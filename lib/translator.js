const googleTranslate = require("googletrans").default;
const { translateDeepLBatch } = require("./deepl-translator");
const { cueTextForTranslation } = require("./subtitle-parser");

const BATCH_LIMITS = {
    deepl: {
        chars: 100000,
        texts: 50,
    },
    googletrans: {
        chars: 10000,
        texts: 50,
    },
    gemini: {
        chars: 30000,
        texts: 80,
    },
};

let currentKeyIndex = 0;

async function translateCues(cues, config, apiKeys = []) {
    const translated = new Array(cues.length).fill("");
    const limits = (apiKeys && apiKeys.length > 0) ? BATCH_LIMITS.gemini : batchLimits(config);
    let batch = [];
    let batchIndexes = [];
    let batchChars = 0;

    async function flushBatch() {
        if (!batch.length) return;

        let result;
        if (apiKeys && apiKeys.length > 0) {
            result = await translateGeminiBatchRoundRobin(batch, config, apiKeys);
        } else {
            result = await translateBatch(batch, config);
        }

        result.forEach((text, index) => {
            translated[batchIndexes[index]] = cleanTranslatedText(text);
        });

        batch = [];
        batchIndexes = [];
        batchChars = 0;
    }

    for (let index = 0; index < cues.length; index += 1) {
        const text = cueTextForTranslation(cues[index]);
        if (!text) continue;

        if (batch.length >= limits.texts || batchChars + text.length > limits.chars) {
            await flushBatch();
        }

        batch.push(text);
        batchIndexes.push(index);
        batchChars += text.length;
    }

    await flushBatch();
    return translated;
}

async function translateGeminiBatchRoundRobin(texts, config, keys, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        // Ép kiểu chuỗi và gọt sạch 100% khoảng trắng/xuống dòng tàng hình bị dư lúc copy
        const apiKey = String(keys[currentKeyIndex]).trim();
        currentKeyIndex = (currentKeyIndex + 1) % keys.length;
        
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
            const prompt = `Bạn là biên dịch viên phụ đề chuyên nghiệp chuẩn Netflix/CBS. Dịch mảng văn bản phụ đề sau sang tiếng Việt. 
            YÊU CẦU BẮT BUỘC:
            1. Văn phong, từ ngữ miền Nam Việt Nam. TUYỆT ĐỐI dùng từ "vậy" thay cho "thế" (VD: "sao vậy", "như vậy").
            2. Rất ngắn gọn, súc tích để tối ưu tốc độ đọc (CPS). Lược bỏ các từ dư thừa (VD: "quản lý của tôi" -> "quản lý", "chuyện gì đang xảy ra" -> "chuyện gì vậy", "công việc của tôi" -> "công việc").
            3. Số đếm: Từ 1-10 dùng chữ, 11 trở lên dùng số. Ưu tiên số cho tiền bạc, phần trăm. Đứng độc lập thì giữ nguyên (trăm, ngàn, vạn).
            4. Giữ nguyên 100% các thẻ âm thanh, tên nhân vật trong ngoặc vuông và viết thường (VD: [thở dài], [nhạc vui nhộn], [tiếng súng]).
            5. BẮT BUỘC trả về ĐÚNG định dạng MẢNG JSON (JSON Array) chứa các chuỗi đã dịch, có độ dài mảng chuẩn xác là ${texts.length}. Tuyệt đối không thêm văn bản, code block hay chú thích nào khác ngoài mảng JSON.
            
            Mảng gốc cần dịch: ${JSON.stringify(texts)}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { response_mime_type: "application/json" }
                })
            });

            if (response.status === 429) {
                console.log(`[Gemini] Key thứ ${currentKeyIndex} quá tải (Rate limit), tự động chuyển key tiếp theo...`);
                continue; 
            }
            
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const data = await response.json();
            const responseText = data.candidates[0].content.parts[0].text;
            const translatedArray = JSON.parse(responseText);
            
            if (translatedArray.length !== texts.length) {
                throw new Error("[Gemini] Lỗi độ dài mảng không khớp với gốc");
            }
            
            return translatedArray;
        } catch (error) {
            console.error(`[Gemini] Lỗi ở key thứ ${currentKeyIndex}:`, error.message);
            if (attempt === retries - 1) {
                console.log("[Gemini] Toàn bộ Key đều kẹt, tự động lùi về Google Translate thường...");
                return translateBatch(texts, config); 
            }
        }
    }
}

function batchLimits(config) {
    return BATCH_LIMITS[translationProvider(config)] || BATCH_LIMITS.googletrans;
}

async function translateBatch(texts, config) {
    if (translationProvider(config) === "deepl") {
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
    const provider = String(config.translationProvider).trim().toLowerCase();
    return provider ?? "googletrans";
}

function cleanTranslatedText(text) {
    return String(text || "")
        .replace(/[ \t]+/g, " ")
        .trim();
}

module.exports = {
    batchLimits,
    translateCues,
    translationProvider,
};
