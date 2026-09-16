const logger = require("./logger");

const DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate";
const DEEPL_PRO_URL = "https://api.deepl.com/v2/translate";
const CHUNK_SIZE = 50;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkArray(array, chunkSize) {
    const results = [];
    for (let index = 0; index < array.length; index += chunkSize) {
        results.push(array.slice(index, index + chunkSize));
    }
    return results;
}

function deeplUrl(apiKey) {
    if (process.env.DEEPL_API_URL) return process.env.DEEPL_API_URL;
    return apiKey.endsWith(":fx") ? DEEPL_FREE_URL : DEEPL_PRO_URL;
}

// LƯU Ý: file này chỉ dùng cho DeepL thật.
// Bản cũ trong repo mang tên DeepL nhưng lại gọi endpoint Gemini bằng key DeepL nên luôn lỗi
// và âm thầm trả về nguyên văn chưa dịch. Đã viết lại cho đúng.
async function translateDeepLBatch(texts, config = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = String(config.deeplApiKey || process.env.DEEPL_API_KEY || "").trim();
    if (!apiKey) throw new Error("Thiếu DeepL API key");

    const url = deeplUrl(apiKey);
    const chunks = chunkArray(texts, CHUNK_SIZE);
    const translated = [];

    for (let index = 0; index < chunks.length; index += 1) {
        if (index > 0) await delay(500);

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `DeepL-Auth-Key ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                text: chunks[index],
                source_lang: config.deeplSourceLanguage,
                target_lang: config.deeplTargetLanguage,
            }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            logger.error("deepl request failed", { status: response.status, detail: detail.slice(0, 300) });
            throw new Error(`DeepL HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.translations)) throw new Error("DeepL trả về dữ liệu không hợp lệ");

        translated.push(...data.translations.map((item) => item.text));
    }

    return translated;
}

module.exports = { translateDeepLBatch };
