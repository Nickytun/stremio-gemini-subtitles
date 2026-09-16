const googleTranslate = require("googletrans").default;
const { translateDeepLBatch } = require("./deepl-translator");
const { cueTextForTranslation } = require("./subtitle-parser");
const logger = require("./logger");

const BATCH_LIMITS = {
    deepl: { chars: 100000, texts: 50 },
    googletrans: { chars: 10000, texts: 50 },
    gemini: { chars: 6000, texts: 20 },
};

// Chuỗi model dự phòng: nếu Google khai tử / đổi tên model thì addon tự nhảy sang model kế tiếp.
// LƯU Ý: Google đang khai tử dồn dập cả dòng model 2.5 trong năm 2026.
// gemini-2.5-flash-lite và gemini-2.5-flash đều đã bị khai tử (HTTP 404 cho tài khoản mới).
// Đã chuyển sang dòng model 3.x hiện đang là GA (generally available) ổn định:
// gemini-3.6-flash và gemini-3.5-flash-lite. Có nhiều model dự phòng hơn để giảm rủi ro
// khi Google tiếp tục thay đổi.
const DEFAULT_GEMINI_MODELS = [
    "gemini-flash-latest",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.7-flash",
    "gemini-3.5-flash-lite",
];

// Key bị lỗi 401 (sai key) hoặc 403 (project bị chặn) là hỏng VĨNH VIỄN, không phải do quá tải.
// Đổi model hay đợi cũng vô ích -> đánh dấu "chết" ngay để các batch sau không phí lượt thử lại key đó.
// Danh sách này chỉ tồn tại trong bộ nhớ của tiến trình server, mất khi Render restart.
const deadKeys = new Set();


// Hạ ngưỡng kiểm duyệt xuống mức thấp nhất được phép.
// Đây là nguyên nhân chính khiến addon "luôn báo lỗi rồi rơi về Google Dịch":
// phụ đề phim có chửi thề / bạo lực bị Gemini chặn -> candidates rỗng -> code cũ crash.
const SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

let currentKeyIndex = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function geminiModels() {
    const fromEnv = String(process.env.GEMINI_MODEL || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    return fromEnv.length ? [...fromEnv, ...DEFAULT_GEMINI_MODELS] : DEFAULT_GEMINI_MODELS;
}

function geminiConcurrency() {
    const value = Number(process.env.GEMINI_CONCURRENCY || 3);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 8) : 3;
}

function collectGeminiKeys(config = {}, apiKeys = []) {
    const fromArgs = Array.isArray(apiKeys) ? apiKeys : [apiKeys];
    const fromEnv = String(process.env.GEMINI_KEYS || process.env.GEMINI_API_KEY || "").split(",");

    return [...fromArgs, config.geminiApiKey, ...fromEnv]
        .map((key) => String(key || "").trim())
        .filter(Boolean)
        .filter((key, index, all) => all.indexOf(key) === index);
}

async function translateCues(cues, config, apiKeys = []) {
    const translated = new Array(cues.length).fill("");
    const keys = collectGeminiKeys(config, apiKeys);
    const useGemini = keys.length > 0;

    if (!useGemini) {
        logger.warn("gemini disabled: no api key found", {
            hint: "Đặt biến môi trường GEMINI_KEYS (nhiều key cách nhau bằng dấu phẩy) hoặc nhập key ở trang cấu hình.",
        });
    }

    const limits = useGemini ? BATCH_LIMITS.gemini : batchLimits(config);
    const batches = [];
    let batch = [];
    let batchIndexes = [];
    let batchChars = 0;

    function pushBatch() {
        if (!batch.length) return;
        batches.push({ indexes: batchIndexes, texts: batch });
        batch = [];
        batchIndexes = [];
        batchChars = 0;
    }

    for (let index = 0; index < cues.length; index += 1) {
        const text = cueTextForTranslation(cues[index]);
        if (!text) continue;

        if (batch.length >= limits.texts || batchChars + text.length > limits.chars) {
            pushBatch();
        }

        batch.push(text);
        batchIndexes.push(index);
        batchChars += text.length;
    }
    pushBatch();

    logger.info("translation batches prepared", {
        batchCount: batches.length,
        cueCount: cues.length,
        keyCount: keys.length,
        provider: useGemini ? "gemini" : translationProvider(config),
    });

    async function runBatch(job) {
        const result = useGemini
            ? await translateGeminiBatch(job.texts, config, keys)
            : await translateBatch(job.texts, config);

        if (!Array.isArray(result)) {
            logger.error("translation batch returned no array", { size: job.texts.length });
            return;
        }

        result.forEach((text, index) => {
            translated[job.indexes[index]] = cleanTranslatedText(text);
        });
    }

    // Chạy song song vài batch một lúc cho nhanh (phim dài 1500+ dòng).
    const concurrency = useGemini ? geminiConcurrency() : 1;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
        while (cursor < batches.length) {
            const job = batches[cursor];
            cursor += 1;
            await runBatch(job);
        }
    });
    await Promise.all(workers);

    return translated;
}

function buildPrompt(texts, config) {
    const sourceLanguage = config.googleSourceLanguage || config.sourceLanguage || "auto";

    return [
        "Bạn là biên dịch viên phụ đề chuyên nghiệp chuẩn Netflix/CBS.",
        `Dịch mảng phụ đề sau từ ngôn ngữ gốc (mã: ${sourceLanguage}) sang Tiếng Việt.`,
        "Nếu ngôn ngữ gốc là tiếng Trung/Nhật/Hàn: dịch thoát ý, tự nhiên, tuyệt đối không dịch Hán-Việt cứng nhắc hay word-by-word.",
        "",
        "YÊU CẦU BẮT BUỘC:",
        '1. Văn phong miền Nam Việt Nam. Dùng "vậy" thay cho "thế" (VD: "sao vậy", "như vậy").',
        '2. Rút gọn theo chuẩn CPS: lược từ thừa ("quản lý của tôi" -> "quản lý", "chuyện gì đang xảy ra" -> "chuyện gì vậy").',
        "3. Số đếm: dùng chữ cho 1-10, dùng số từ 11 trở lên; ưu tiên chữ số cho tiền bạc và phần trăm.",
        "4. Thẻ âm thanh: giữ nguyên vị trí, dịch sang tiếng Việt, viết thường trong ngoặc vuông (VD: [nhạc vui nhộn], [tiếng súng]).",
        "5. Dấu câu: dùng ký tự ellipsis gộp (…) và ngoặc kép cong (“ ”). Thoại song song giữ nguyên gạch đầu dòng.",
        "6. Giữ nguyên tên riêng, thương hiệu, thẻ định dạng nếu có.",
        "7. TUYỆT ĐỐI KHÔNG GỘP DÒNG và không bỏ sót dòng. Phụ đề hay bị cắt ngang câu giữa hai dòng — vẫn phải dịch từng dòng riêng biệt, đúng thứ tự.",
        `8. Trả về DUY NHẤT một mảng JSON gồm các chuỗi, độ dài đúng bằng ${texts.length}. Không thêm lời giải thích, không markdown.`,
        "9. Nếu một dòng không thể dịch (chỉ là ký hiệu, số, tên riêng) thì giữ nguyên dòng đó — không được trả về chuỗi rỗng.",
        "",
        `Mảng gốc (${texts.length} dòng):`,
        JSON.stringify(texts, null, 0),
    ].join("\n");
}

async function callGemini({ apiKey, model, texts, config }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: buildPrompt(texts, config) }] }],
            safetySettings: SAFETY_SETTINGS,
            generationConfig: {
                temperature: 0.3,
                responseMimeType: "application/json",
                responseSchema: { type: "ARRAY", items: { type: "STRING" } },
                maxOutputTokens: 8192,
            },
        }),
    });

    const raw = await response.text();
    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        const message = (data && data.error && data.error.message) || raw.slice(0, 300) || "unknown error";
        const error = new Error(`Gemini HTTP ${response.status}: ${message}`);
        error.status = response.status;
        error.retryable = response.status === 429 || response.status >= 500;
        // 404 = model không tồn tại -> đáng để thử model khác
        error.modelProblem = response.status === 404 || /not found|not supported/i.test(message);
        throw error;
    }

    if (!data) throw new Error("Gemini trả về phản hồi không phải JSON");

    if (data.promptFeedback && data.promptFeedback.blockReason) {
        const error = new Error(`Gemini chặn prompt: ${data.promptFeedback.blockReason}`);
        error.blocked = true;
        throw error;
    }

    const candidate = data.candidates && data.candidates[0];
    if (!candidate) throw new Error("Gemini không trả về candidate nào");

    const parts = (candidate.content && candidate.content.parts) || [];
    const text = parts
        .map((part) => part.text || "")
        .join("")
        .trim();

    if (!text) {
        const error = new Error(`Gemini trả về nội dung rỗng (finishReason: ${candidate.finishReason || "unknown"})`);
        error.blocked = candidate.finishReason === "SAFETY" || candidate.finishReason === "RECITATION";
        error.truncated = candidate.finishReason === "MAX_TOKENS";
        throw error;
    }

    return parseTranslationArray(text, texts.length);
}

function parseTranslationArray(responseText, expectedLength) {
    const match = responseText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Gemini không trả về cấu trúc JSON hợp lệ");

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error("Gemini trả về JSON nhưng không phải mảng");

    if (parsed.length !== expectedLength) {
        const error = new Error(`Sai độ dài: gốc ${expectedLength} dòng, dịch được ${parsed.length} dòng`);
        error.lengthMismatch = true;
        throw error;
    }

    return parsed.map((value) => String(value ?? ""));
}

async function translateGeminiBatch(texts, config, keys, depth = 0) {
    const models = geminiModels();
    // Tăng số lần thử vì giờ có thể phải xoay qua nhiều model khi 1 model bị quá tải (503).
    const maxAttempts = Math.max(keys.length * 3, 9);
    let modelIndex = 0;
    let sameModelFailStreak = 0;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // Bỏ qua key đã biết là hỏng (401/403) từ những lần dịch trước, trừ khi TẤT CẢ
        // key đều bị đánh dấu hỏng — lúc đó vẫn phải thử lại vì có thể do lỗi tạm thời trước đây.
        const usableKeys = keys.filter((key) => !deadKeys.has(key));
        const rotationKeys = usableKeys.length ? usableKeys : keys;

        const apiKey = rotationKeys[currentKeyIndex % rotationKeys.length];
        const keyLabel = keys.indexOf(apiKey);
        currentKeyIndex = (currentKeyIndex + 1) % rotationKeys.length;
        const model = models[Math.min(modelIndex, models.length - 1)];

        try {
            const result = await callGemini({ apiKey, model, texts, config });
            deadKeys.delete(apiKey);
            return result;
        } catch (error) {
            lastError = error;
            logger.warn("gemini batch attempt failed", {
                attempt: attempt + 1,
                keyIndex: keyLabel,
                model,
                reason: error.message,
                size: texts.length,
            });

            if (error.status === 401 || error.status === 403) {
                // Key hỏng vĩnh viễn (sai key / project bị chặn) — đánh dấu để các lần dịch
                // sau (kể cả phim khác) không phí lượt thử lại key này nữa.
                deadKeys.add(apiKey);
                continue;
            }

            if (error.modelProblem) {
                if (modelIndex < models.length - 1) {
                    modelIndex += 1;
                    sameModelFailStreak = 0;
                    continue;
                }
                // Đã hết model dự phòng để thử và model cuối cùng cũng không tồn tại/không dùng được
                // -> đổi key không giúp được gì, dừng vòng lặp ngay để rơi về Google Dịch thay vì
                // lãng phí hàng chục lần thử vô ích.
                break;
            }

            if (error.status === 429 || error.status === 503) {
                sameModelFailStreak += 1;
                // Model hiện tại bị quá tải liên tục (Google trả 503 "high demand") dù đã đổi key
                // -> đổi sang model dự phòng kế tiếp thay vì tiếp tục dí vào model đang quá tải.
                if (sameModelFailStreak >= 3 && modelIndex < models.length - 1) {
                    modelIndex += 1;
                    sameModelFailStreak = 0;
                    continue;
                }
                await delay(1200 * Math.min(attempt + 1, 4));
                continue;
            }

            sameModelFailStreak = 0;

            // Bị chặn an toàn, bị cắt ngắn, hoặc sai độ dài:
            // chia đôi batch rồi dịch lại — thường đoạn nhỏ sẽ qua được.
            if ((error.blocked || error.truncated || error.lengthMismatch) && texts.length > 1 && depth < 4) {
                const middle = Math.ceil(texts.length / 2);
                const [left, right] = await Promise.all([
                    translateGeminiBatch(texts.slice(0, middle), config, keys, depth + 1),
                    translateGeminiBatch(texts.slice(middle), config, keys, depth + 1),
                ]);
                return [...left, ...right];
            }
        }
    }

    logger.error("gemini batch failed, falling back to google translate", {
        reason: lastError ? lastError.message : "unknown",
        size: texts.length,
    });
    return translateBatch(texts, config);
}

function batchLimits(config) {
    return BATCH_LIMITS[translationProvider(config)] || BATCH_LIMITS.googletrans;
}

async function translateBatch(texts, config) {
    if (translationProvider(config) === "deepl" && (config.deeplApiKey || process.env.DEEPL_API_KEY)) {
        return translateDeepLBatch(texts, config);
    }

    try {
        const result = await googleTranslate(texts, {
            from: config.googleSourceLanguage,
            to: config.googleTargetLanguage,
        });
        return result.textArray || [result.text];
    } catch (error) {
        if (texts.length === 1) throw error;

        const translated = [];
        for (const text of texts) {
            const result = await googleTranslate(text, {
                from: config.googleSourceLanguage,
                to: config.googleTargetLanguage,
            });
            translated.push(result.text);
        }
        return translated;
    }
}

function translationProvider(config = {}) {
    // BUG CŨ: String(undefined) = "undefined" và `??` không bao giờ bắt được chuỗi rỗng,
    // nên provider luôn sai. Đã sửa lại cho đúng.
    const provider = String(config.translationProvider || "")
        .trim()
        .toLowerCase();

    return provider || "googletrans";
}

function cleanTranslatedText(text) {
    return String(text || "")
        .replace(/[ \t]+/g, " ")
        .trim();
}

module.exports = {
    batchLimits,
    collectGeminiKeys,
    translateCues,
    translationProvider,
};
