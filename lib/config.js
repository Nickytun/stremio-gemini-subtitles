const {
    normalizeDeepLSourceLanguage,
    normalizeDeepLTargetLanguage,
    normalizeGoogleLanguage,
    normalizeStremioLanguage,
} = require("./languages");
const { Buffer } = require("buffer");

function getSubtitleConfig(config = {}) {
    const sourceLanguage = config.sourceLang || config.sourceLanguage || "en";
    const targetLanguage = config.targetLang || config.targetLanguage || "vi";
    const provider = String(config.translationProvider || "gemini")
        .trim()
        .toLowerCase();

    // Một key duy nhất đi trong URL cấu hình; tuỳ provider mà nó là key Gemini hay DeepL.
    const providerKey = config.providerKey || config.geminiApiKey || config.deeplApiKey || "";

    return {
        deeplApiKey: provider === "deepl" ? providerKey : config.deeplApiKey || "",
        geminiApiKey: provider === "gemini" ? providerKey : config.geminiApiKey || "",
        sourceLanguage,
        targetLanguage,
        translationProvider: provider,
        deeplSourceLanguage: normalizeDeepLSourceLanguage(sourceLanguage),
        deeplTargetLanguage: normalizeDeepLTargetLanguage(targetLanguage),
        stremioSourceLanguage: normalizeStremioLanguage(sourceLanguage),
        stremioTargetLanguage: normalizeStremioLanguage(targetLanguage),
        googleSourceLanguage: normalizeGoogleLanguage(sourceLanguage),
        googleTargetLanguage: normalizeGoogleLanguage(targetLanguage),
    };
}

function parseConfigPrefix(parts) {
    if (parts[0] !== "configure" || !parts[1] || !parts[2]) return null;

    return {
        providerKey: parts[4] ? decodeProviderKey(parts[4]) : "",
        sourceLang: decodeURIComponent(parts[1]),
        targetLang: decodeURIComponent(parts[2]),
        translationProvider: parts[3] ? decodeURIComponent(parts[3]) : "gemini",
    };
}

function decodeProviderKey(value) {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

module.exports = {
    decodeProviderKey,
    getSubtitleConfig,
    parseConfigPrefix,
};
