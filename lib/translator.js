const googleTranslate = require("googletrans").default;
const { translateDeepLBatch } = require("./deepl-translator");
const { cueTextForTranslation } = require("./subtitle-parser");

const BATCH_LIMITS = {
    deepl: { chars: 100000, texts: 50 },
    googletrans: { chars: 10000, texts: 50 },
    gemini: { chars: 30000, texts: 80 },
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
    const validKeys = Array.isArray(keys) ? keys : [keys];
    
    for (let attempt = 0; attempt < retries; attempt++) {
        const apiKey = String(validKeys[currentKeyIndex % validKeys.length]).trim();
        currentKeyIndex = (currentKeyIndex + 1) % validKeys.length;
        
        try {
            // Đã đổi chính xác sang model gemini-3.6-flash theo hình ảnh trong Google AI Studio
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
            
            // Câu lệnh Prompt bám sát toàn bộ quy tắc biên dịch
            const prompt = `Bạn là biên dịch viên phụ đề chuyên nghiệp chuẩn Netflix/CBS. Dịch mảng văn bản phụ đề sau sang tiếng Việt. 
            YÊU CẦU BẮT BUỘC:
            1. Văn Phong & Ngôn Ngữ: Sử dụng từ ngữ, câu văn, ngữ cảnh của miền Nam Việt Nam. Hạn chế tối đa từ vựng miền Bắc/Trung. TUYỆT ĐỐI dùng từ "vậy" thay cho "thế" (VD: "sao vậy", "như vậy", "chuyện gì vậy").
            2. Cấu trúc rút gọn (CPS): Lược bớt các từ ngữ thừa. (VD: "quản lý của tôi" -> "quản lý", "bản thân của mình" -> "bản thân mình", "công việc của tôi" -> "công việc", "Đây là gì" -> "Gì đây", "tôi đoán vậy" -> "tôi nghĩ vậy", "ngay cả khi" -> "dù là").
            3. Số đếm: Dùng chữ cho số 1-10, dùng số từ 11 trở lên. Ưu tiên dùng số cho tiền bạc, phần trăm. Đứng riêng lẻ thì giữ nguyên (trăm, ngàn, vạn).
            4. Thẻ âm thanh: Giữ nguyên 100%, dịch đầy đủ và đặt trong ngoặc vuông, viết thường (VD: [tiếng súng], [nhạc vui nhộn]). Giữ nguyên tên nhân vật trong ngoặc nếu có.
            5. Dấu câu: Bắt buộc dùng ký tự gộp smart ellipsis (…), dấu ngoặc kép (“ ”). Thoại song song bắt đầu bằng gạch nối và khoảng trắng (- ).
            6. ĐỊNH DẠNG XUẤT: BẮT BUỘC trả về ĐÚNG định dạng MẢNG JSON (JSON Array) chứa các chuỗi đã dịch, có độ dài mảng chuẩn xác là ${texts.length}. Tuyệt đối không thêm văn bản hay chú thích nào khác ngoài mảng JSON.
            
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
                console.log(`[Gemini] Key quá tải (Rate limit), tự động chuyển key tiếp theo...`);
                continue; 
            }
            
            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, Lỗi từ Google: ${errorBody}`);
            }
            
            const data = await response.json();
            const responseText = data.candidates[0].content.parts[0].text;
            const translatedArray = JSON.parse(responseText);
            
            if (translatedArray.length !== texts.length) {
                throw new Error("[Gemini] Lỗi độ dài mảng không khớp với gốc");
            }
            
            return translatedArray;
        } catch (error) {
            console.error(`[Gemini] Lỗi ở key thứ ${currentKeyIndex - 1}:`, error.message);
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
