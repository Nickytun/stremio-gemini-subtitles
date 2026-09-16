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

function deadKeyId(apiKey, model) {
    return `${apiKey}::${model}`;
}



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

// BUG ĐÃ SỬA: "cứ xài gemini-flash-latest mãi" là vì modelIndex reset về 0 ở MỖI batch
// (mỗi phim bị chia thành hàng chục batch ~20 dòng, chạy song song theo GEMINI_CONCURRENCY).
// Batch #1 có thể tốn 3 lần thử + vài giây delay mới phát hiện model đầu tiên bị 429/503 rồi
// mới nhảy sang model kế — nhưng batch #2, #3... không hề biết điều đó, lại bắt đầu lại từ đầu
// và tự đi thử lại đúng model vừa bị từ chối. Nhân với hàng chục batch mỗi phim -> cảm giác
// addon "kẹt" ở 1 model rất lâu dù log thực ra có nhảy model (chỉ là nhảy rồi lại quay về).
// Cách sửa: nhớ tạm (module-level, dùng chung cho mọi batch) model nào vừa bị 429/503 và
// "nghỉ" nó trong một khoảng thời gian ngắn — các batch sau sẽ tự động xếp model đó xuống
// cuối hàng đợi thay vì thử lại ngay, cho tới khi hết thời gian nghỉ.
const MODEL_COOLDOWN_MS = Number(process.env.GEMINI_MODEL_COOLDOWN_MS || 20000);
const modelCooldownUntil = new Map();

function isModelOnCooldown(model) {
    const until = modelCooldownUntil.get(model);
    return typeof until === "number" && Date.now() < until;
}

function markModelCooldown(model, ms = MODEL_COOLDOWN_MS) {
    const wasOnCooldown = isModelOnCooldown(model);
    modelCooldownUntil.set(model, Date.now() + ms);
    if (!wasOnCooldown) {
        logger.warn("gemini model tạm nghỉ do quá tải/hết quota", { model, cooldownMs: ms });
    }
}

function geminiModels() {
    const fromEnv = String(process.env.GEMINI_MODEL || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    return fromEnv.length ? [...fromEnv, ...DEFAULT_GEMINI_MODELS] : DEFAULT_GEMINI_MODELS;
}

// Sắp xếp lại danh sách model cho MỖI LẦN GỌI translateGeminiBatch: model đang "nghỉ"
// (do batch khác vừa báo 429/503) bị đẩy xuống cuối thay vì bị loại hẳn — nếu tất cả model
// đều đang nghỉ thì vẫn còn cái để thử, không đứng hình.
function orderedGeminiModels() {
    const models = geminiModels();
    const fresh = models.filter((model) => !isModelOnCooldown(model));
    const cooling = models.filter((model) => isModelOnCooldown(model));
    return fresh.length ? [...fresh, ...cooling] : models;
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
    const groqKeys = collectGroqKeys(config);
    const mistralKeys = collectMistralKeys(config);
    const useGemini = keys.length > 0;
    // useLlm bao gồm cả trường hợp không có key Gemini nhưng có cấu hình Groq/Mistral —
    // vẫn nên đi qua translateGeminiBatch (nó tự rơi thẳng xuống Groq rồi Mistral khi keys
    // rỗng) thay vì đi thẳng Google Dịch.
    const useLlm = useGemini || groqKeys.length > 0 || mistralKeys.length > 0;

    if (!useLlm) {
        logger.warn("gemini/groq/mistral disabled: no api key found", {
            hint: "Đặt GEMINI_KEYS, GROQ_KEYS và/hoặc MISTRAL_KEYS (nhiều key cách nhau dấu phẩy) để dịch bằng AI, nếu không sẽ dùng Google Dịch (chất lượng thấp hơn).",
        });
    }

    const limits = useLlm ? BATCH_LIMITS.gemini : batchLimits(config);
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
        groqKeyCount: groqKeys.length,
        mistralKeyCount: mistralKeys.length,
        provider: useLlm ? (useGemini ? "gemini" : groqKeys.length ? "groq" : "mistral") : translationProvider(config),
    });

    async function runBatch(job) {
        const result = useLlm
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
    const concurrency = useLlm ? geminiConcurrency() : 1;
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

// ===== Tầng dự phòng Groq (groq.com) =====
// API OpenAI-compatible giống OpenRouter, nhưng free tier RỘNG HƠN NHIỀU: 1000 request/ngày,
// 30 request/phút (so với OpenRouter free chỉ 50 request/ngày nếu chưa nạp $10) — theo đúng
// hướng addon "NTL Z-SubAI" đang làm (cho chọn Groq làm nền tảng chính, dán nhãn "miễn phí,
// rất nhanh"). Model mặc định openai/gpt-oss-120b (chất lượng tốt nhất); nếu bị 429 do giới
// hạn RPM thì tự hạ xuống openai/gpt-oss-20b, đúng logic "bị limit RPM thì hạ xuống 20B" mà
// addon kia mô tả trong UI. Giới hạn tính theo TỪNG MODEL riêng nên 120B hết quota không có
// nghĩa là 20B cũng hết.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

let currentGroqKeyIndex = 0;
const deadGroqModels = new Set();

function markGroqModelDead(model) {
    if (!deadGroqModels.has(model)) {
        deadGroqModels.add(model);
        logger.warn("groq model bị loại vĩnh viễn (không tồn tại/không dùng được)", { model });
    }
}

function orderedGroqModels() {
    const models = groqModels();
    const alive = models.filter((model) => !deadGroqModels.has(model));
    return alive.length ? alive : models;
}

function collectGroqKeys(config = {}) {
    const fromEnv = String(process.env.GROQ_KEYS || process.env.GROQ_API_KEY || "").split(",");

    return [config.groqApiKey, ...fromEnv]
        .map((key) => String(key || "").trim())
        .filter(Boolean)
        .filter((key, index, all) => all.indexOf(key) === index);
}

function groqModels() {
    const fromEnv = String(process.env.GROQ_MODEL || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    return fromEnv.length ? [...fromEnv, ...DEFAULT_GROQ_MODELS] : DEFAULT_GROQ_MODELS;
}

async function callGroq({ apiKey, model, texts, config }) {
    const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0.3,
            messages: [{ role: "user", content: buildPrompt(texts, config) }],
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
        const error = new Error(`Groq HTTP ${response.status}: ${message}`);
        error.status = response.status;
        throw error;
    }

    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("Groq trả về nội dung rỗng");

    return parseTranslationArray(text, texts.length);
}

async function translateGroqBatch(texts, config, depth = 0) {
    const keys = collectGroqKeys(config);
    if (!keys.length) return null; // chưa cấu hình Groq -> để tầng sau (Mistral/Google Dịch) xử lý

    const models = orderedGroqModels();
    const maxAttempts = Math.max(models.length * keys.length, models.length + 2);
    let modelIndex = 0;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const model = models[Math.min(modelIndex, models.length - 1)];
        const apiKey = keys[currentGroqKeyIndex % keys.length];
        currentGroqKeyIndex = (currentGroqKeyIndex + 1) % keys.length;

        try {
            return await callGroq({ apiKey, model, texts, config });
        } catch (error) {
            lastError = error;
            logger.warn("groq batch attempt failed", {
                attempt: attempt + 1,
                model,
                reason: error.message,
                size: texts.length,
            });

            // 404 = model không tồn tại (Groq đổi tên/khai tử model rất hay xảy ra) -> loại vĩnh viễn.
            if (error.status === 404) {
                markGroqModelDead(model);
                if (modelIndex < models.length - 1) {
                    modelIndex += 1;
                    continue;
                }
                break;
            }

            // 429 = chạm giới hạn free (RPM hoặc RPD) CỦA RIÊNG model này -> đổi sang model dự phòng
            // (vd 120B hết -> hạ xuống 20B) trước khi chịu đợi.
            if (error.status === 429 || error.status === 503) {
                if (modelIndex < models.length - 1) {
                    modelIndex += 1;
                    continue;
                }
                await delay(1000);
                continue;
            }

            if (error.lengthMismatch && texts.length > 1 && depth < 4) {
                const middle = Math.ceil(texts.length / 2);
                const [left, right] = await Promise.all([
                    translateGroqBatch(texts.slice(0, middle), config, depth + 1),
                    translateGroqBatch(texts.slice(middle), config, depth + 1),
                ]);
                if (left && right) return [...left, ...right];
            }
        }
    }

    logger.error("groq batch failed", {
        reason: lastError ? lastError.message : "unknown",
        size: texts.length,
    });
    return null;
}

// ===== Tầng dự phòng Mistral (mistral.ai) =====
// Free tier CHÍNH THỨC, không cần thẻ tín dụng, quota theo tháng rất rộng (cỡ 1 tỷ token/tháng
// trên tier "Experiment") — không bị kiểu giới hạn 50 request/ngày như OpenRouter free.
// API JSON giống hệt dạng chat completions (choices[0].message.content) nên dùng lại được
// buildPrompt/parseTranslationArray như các tầng khác. Model mặc định mistral-small-latest
// (nhẹ, nhanh, đủ tốt để dịch phụ đề); có thể đổi qua biến MISTRAL_MODEL.
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MISTRAL_MODELS = ["mistral-small-latest", "open-mistral-nemo"];

let currentMistralKeyIndex = 0;
const deadMistralModels = new Set();

function markMistralModelDead(model) {
    if (!deadMistralModels.has(model)) {
        deadMistralModels.add(model);
        logger.warn("mistral model bị loại vĩnh viễn (không tồn tại/không dùng được)", { model });
    }
}

function orderedMistralModels() {
    const models = mistralModels();
    const alive = models.filter((model) => !deadMistralModels.has(model));
    return alive.length ? alive : models;
}

function collectMistralKeys(config = {}) {
    const fromEnv = String(process.env.MISTRAL_KEYS || process.env.MISTRAL_API_KEY || "").split(",");

    return [config.mistralApiKey, ...fromEnv]
        .map((key) => String(key || "").trim())
        .filter(Boolean)
        .filter((key, index, all) => all.indexOf(key) === index);
}

function mistralModels() {
    const fromEnv = String(process.env.MISTRAL_MODEL || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    return fromEnv.length ? [...fromEnv, ...DEFAULT_MISTRAL_MODELS] : DEFAULT_MISTRAL_MODELS;
}

async function callMistral({ apiKey, model, texts, config }) {
    const response = await fetch(MISTRAL_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "user",
                    // Mistral ở chế độ json_object yêu cầu prompt phải nhắc rõ từ "JSON" và mô tả
                    // hình dạng object, nên bọc mảng gốc vào field "translations".
                    content: `${buildPrompt(texts, config)}\n\nTrả về DUY NHẤT một JSON object dạng {"translations": [...]}, KHÔNG trả về mảng trần.`,
                },
            ],
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
        const message = (data && data.error && (data.error.message || data.error)) || raw.slice(0, 300) || "unknown error";
        const error = new Error(`Mistral HTTP ${response.status}: ${message}`);
        error.status = response.status;
        throw error;
    }

    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("Mistral trả về nội dung rỗng");

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // fallback: có thể model vẫn trả mảng trần dù đã dặn bọc object
        return parseTranslationArray(text, texts.length);
    }

    const array = Array.isArray(parsed) ? parsed : parsed.translations;
    if (!Array.isArray(array)) throw new Error("Mistral trả về JSON nhưng không tìm thấy mảng translations");
    if (array.length !== texts.length) {
        const error = new Error(`Sai độ dài: gốc ${texts.length} dòng, dịch được ${array.length} dòng`);
        error.lengthMismatch = true;
        throw error;
    }
    return array.map((value) => String(value ?? ""));
}

async function translateMistralBatch(texts, config, depth = 0) {
    const keys = collectMistralKeys(config);
    if (!keys.length) return null; // chưa cấu hình Mistral -> để translateGeminiBatch rơi xuống Google Dịch

    const models = orderedMistralModels();
    const maxAttempts = Math.max(models.length * keys.length, models.length + 2);
    let modelIndex = 0;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const model = models[Math.min(modelIndex, models.length - 1)];
        const apiKey = keys[currentMistralKeyIndex % keys.length];
        currentMistralKeyIndex = (currentMistralKeyIndex + 1) % keys.length;

        try {
            return await callMistral({ apiKey, model, texts, config });
        } catch (error) {
            lastError = error;
            logger.warn("mistral batch attempt failed", {
                attempt: attempt + 1,
                model,
                reason: error.message,
                size: texts.length,
            });

            if (error.status === 404) {
                markMistralModelDead(model);
                if (modelIndex < models.length - 1) {
                    modelIndex += 1;
                    continue;
                }
                break;
            }

            if (error.status === 429 || error.status === 503) {
                if (modelIndex < models.length - 1) {
                    modelIndex += 1;
                    continue;
                }
                await delay(1000);
                continue;
            }

            if (error.lengthMismatch && texts.length > 1 && depth < 4) {
                const middle = Math.ceil(texts.length / 2);
                const [left, right] = await Promise.all([
                    translateMistralBatch(texts.slice(0, middle), config, depth + 1),
                    translateMistralBatch(texts.slice(middle), config, depth + 1),
                ]);
                if (left && right) return [...left, ...right];
            }
        }
    }

    logger.error("mistral batch failed", {
        reason: lastError ? lastError.message : "unknown",
        size: texts.length,
    });
    return null;
}

async function translateGeminiBatch(texts, config, keys, depth = 0) {
    // Bật tạm biến này (GEMINI_DISABLED=true trên Render) để bỏ qua hẳn vòng thử Gemini —
    // hữu ích khi cả 25 key đều bị 429 "Resource has been exhausted" như hiện tại: mỗi batch
    // đang phải thử tới 70+ lần (key x model) trước khi rơi xuống Google Dịch, tốn cả phút/batch.
    // Bật cờ này thì đi thẳng vào Groq/Mistral (nếu đã cấu hình) rồi mới tới Google Dịch.
    const geminiDisabled = String(process.env.GEMINI_DISABLED || "").trim().toLowerCase() === "true";
    let lastError = null;

    if (!geminiDisabled && keys.length > 0) {
        const models = orderedGeminiModels();
        // Trước đây là keys.length*3 (72 lần với 24 key) — quá nhiều, mỗi lần 503 còn cộng dồn
        // delay, khiến 1 batch kẹt ở Gemini vài PHÚT trước khi chịu nhường cho Groq/Mistral dù
        // 2 tầng đó đang rảnh. Giờ giới hạn thấp hẳn (mặc định 6, chỉnh qua GEMINI_MAX_ATTEMPTS)
        // để Gemini "thử nhanh rồi thôi" thay vì cố đấm khi đang quá tải diện rộng (503 hàng loạt
        // không phải do key hỏng nên đổi key mãi cũng vô ích).
        const maxAttempts = Math.min(keys.length, Number(process.env.GEMINI_MAX_ATTEMPTS || 6));
        let modelIndex = 0;
        let sameModelFailStreak = 0;

        attemptsLoop: for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const model = models[Math.min(modelIndex, models.length - 1)];

            // "Chết" được tính riêng theo TỪNG CẶP key+model — một key bị từ chối ở model trả phí
            // (chưa bật billing) vẫn phải dùng bình thường được ở các model free khác.
            const usableKeys = keys.filter((key) => !deadKeys.has(deadKeyId(key, model)));
            const rotationKeys = usableKeys.length ? usableKeys : keys;

            const apiKey = rotationKeys[currentKeyIndex % rotationKeys.length];
            const keyLabel = keys.indexOf(apiKey);
            currentKeyIndex = (currentKeyIndex + 1) % rotationKeys.length;

            try {
                const result = await callGemini({ apiKey, model, texts, config });
                deadKeys.delete(deadKeyId(apiKey, model));
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
                    // Chỉ đánh dấu "chết" cho ĐÚNG cặp key+model này. Lỗi 403 rất hay xảy ra vì
                    // model trả phí (vd Pro) mà key chưa bật billing — key đó vẫn dùng tốt cho
                    // các model free khác, không được đánh đồng là hỏng toàn bộ.
                    deadKeys.add(deadKeyId(apiKey, model));
                    continue;
                }

                if (error.modelProblem) {
                    if (modelIndex < models.length - 1) {
                        modelIndex += 1;
                        sameModelFailStreak = 0;
                        continue;
                    }
                    // Đã hết model dự phòng để thử và model cuối cùng cũng không tồn tại/không dùng được
                    // -> đổi key không giúp được gì, dừng vòng lặp để rơi xuống tầng dự phòng kế tiếp
                    // (Groq rồi Mistral rồi Google Dịch) thay vì lãng phí hàng chục lần thử vô ích.
                    break attemptsLoop;
                }

                if (error.status === 429 || error.status === 503) {
                    sameModelFailStreak += 1;
                    // Báo ngay cho các batch KHÁC (đang chạy song song hoặc sắp chạy) biết model này
                    // đang bị 429/503 — 429 (hết quota) nghỉ lâu hơn 503 (quá tải tạm thời, thường
                    // hồi phục nhanh hơn).
                    markModelCooldown(model, error.status === 429 ? MODEL_COOLDOWN_MS : Math.min(MODEL_COOLDOWN_MS, 8000));
                    // Model hiện tại bị quá tải liên tục (Google trả 503 "high demand") dù đã đổi key
                    // -> đổi sang model dự phòng kế tiếp thay vì tiếp tục dí vào model đang quá tải.
                    // Hạ ngưỡng 3->2: với budget chỉ còn 6 lần thử tổng cộng, phải đổi model SỚM.
                    if (sameModelFailStreak >= 2 && modelIndex < models.length - 1) {
                        modelIndex += 1;
                        sameModelFailStreak = 0;
                        continue;
                    }
                    // Bỏ hẳn delay chờ: 503 diện rộng (Google đang quá tải) thì chờ vài giây trong
                    // 1 request của Stremio không giải quyết được gì — đổi model/key ngay lập tức,
                    // để dành thời gian cho Groq/Mistral xử lý nếu Gemini vẫn không ăn thua.
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
    }

    // Tầng dự phòng 2: Groq (chỉ chạy nếu đã cấu hình GROQ_KEYS/GROQ_API_KEY). Đặt TRƯỚC
    // OpenRouter vì free tier của Groq rộng hơn nhiều (1000 request/ngày so với 50/ngày của
    // OpenRouter khi chưa nạp $10) — translateGroqBatch trả về null nếu chưa cấu hình.
    const groqResult = await translateGroqBatch(texts, config);
    if (groqResult) return groqResult;

    // Tầng dự phòng 3: Mistral (chỉ chạy nếu đã cấu hình MISTRAL_KEYS/MISTRAL_API_KEY).
    // translateMistralBatch trả về null nếu chưa cấu hình, khi đó rơi thẳng xuống Google Dịch.
    const mistralResult = await translateMistralBatch(texts, config);
    if (mistralResult) return mistralResult;

    logger.error("gemini + groq + mistral đều thất bại/chưa cấu hình, rơi về Google Dịch", {
        reason: lastError
            ? lastError.message
            : geminiDisabled
              ? "gemini disabled (GEMINI_DISABLED=true)"
              : keys.length === 0
                ? "no gemini keys"
                : "unknown",
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
    collectGroqKeys,
    collectMistralKeys,
    translateCues,
    translationProvider,
};
