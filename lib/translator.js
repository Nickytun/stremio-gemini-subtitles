const googleTranslate = require("googletrans").default;
const { translateDeepLBatch } = require("./deepl-translator");
const { cueTextForTranslation } = require("./subtitle-parser");

const BATCH_LIMITS = {
    deepl: { chars: 100000, texts: 50 },
    googletrans: { chars: 10000, texts: 50 },
    gemini: { chars: 8000, texts: 25 }, 
};

let currentKeyIndex = 0;
// Hàm tạo độ trễ để tránh bị Google khóa mõm vì spam request
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

        if (result && Array.isArray(result)) {
            result.forEach((text, index) => {
                translated[batchIndexes[index]] = cleanTranslatedText(text);
            });
        } else {
            console.error("[Gemini] Fallback thất bại, không nhận được mảng kết quả.");
        }

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

async function translateGeminiBatchRoundRobin(texts, config, keys, retries = 5) {
    const validKeys = Array.isArray(keys) ? keys : [keys];
    
    for (let attempt = 0; attempt < retries; attempt++) {
        const apiKey = String(validKeys[currentKeyIndex % validKeys.length]).trim();
        currentKeyIndex = (currentKeyIndex + 1) % validKeys.length;
        
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
            
            const prompt = `Bạn là biên dịch viên phụ đề chuyên nghiệp chuẩn Netflix/CBS. Dịch mảng văn bản phụ đề sau sang tiếng Việt. 
            YÊU CẦU BẮT BUỘC:
            1. Văn Phong & Ngôn Ngữ: Sử dụng từ ngữ, câu văn của miền Nam Việt Nam. TUYỆT ĐỐI dùng từ "vậy" thay cho "thế" (VD: "sao vậy").
            2. Cấu trúc rút gọn (CPS): Lược bớt từ thừa (VD: "quản lý của tôi" -> "quản lý", "chuyện gì đang xảy ra" -> "chuyện gì vậy").
            3. Số đếm: Dùng chữ cho số 1-10, dùng số từ 11 trở lên. Ưu tiên số cho tiền bạc, phần trăm. Đứng lẻ giữ nguyên (trăm, ngàn).
            4. Thẻ âm thanh: Giữ nguyên 100%, viết thường trong ngoặc vuông (VD: [nhạc vui nhộn]).
            5. Dấu câu: Bắt buộc dùng ký tự gộp smart ellipsis (…), dấu ngoặc kép (“ ”). Thoại song song dùng gạch nối (- ).
            6. CẤU TRÚC JSON NGHIÊM NGẶT CẤM GỘP DÒNG: 
            - TUYỆT ĐỐI KHÔNG GỘP DÒNG hoặc bỏ sót dòng. Phụ đề thường bị cắt ngang câu giữa 2 dòng, bắt buộc phải dịch sát từng dòng riêng biệt, không được tự ý nối với dòng dưới.
            - Trả về ĐÚNG 1 mảng JSON (JSON Array). Chiều dài mảng đầu ra phải ĐÚNG CHÍNH XÁC bằng ${texts.length}.
            
            Mảng gốc cần dịch (ĐÚNG ${texts.length} dòng):
            ${JSON.stringify(texts)}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { response_mime_type: "application/json" }
                })
            });

            if (response.status === 429) {
                console.log(`[Gemini] Key quá tải (Rate limit), nghỉ ngơi 2 giây rồi thử lại...`);
                await delay(2000); // Thở 2 giây để tránh bị Google block
                continue; 
            }
            
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const data = await response.json();
            const responseText = data.candidates[0].content.parts[0].text;
            
            const jsonMatch = responseText.match(/\[\s*[\s\S]*\s*\]/);
            if (!jsonMatch) {
                throw new Error("[Gemini] Không tìm thấy cấu trúc JSON hợp lệ");
            }
            
            const translatedArray = JSON.parse(jsonMatch[0]);
            
            // Ép buộc kiểm tra độ dài mảng
            if (!Array.isArray(translatedArray) || translatedArray.length !== texts.length) {
                throw new Error(`[Gemini] Lỗi độ dài: Gốc ${texts.length} dòng, Dịch được ${Array.isArray(translatedArray) ? translatedArray.length : 0} dòng`);
            }
            
            return translatedArray;
        } catch (error) {
            console.error(`[Gemini] Lỗi ở key thứ ${currentKeyIndex - 1}:`, error.message);
        }
    }
    
    console.log("[Gemini] Toàn bộ Key đều kẹt, tự động lùi về Google Translate thường...");
    return await translateBatch(texts, config); 
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
