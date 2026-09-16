const LANGUAGES = [
    { code: "vi", label: "Tiếng Việt", stremio: "vie" },
    { code: "en", label: "English", stremio: "eng" },
    { code: "zh-CN", label: "中文 (Giản thể)", stremio: "chi" },
    { code: "zh-TW", label: "中文 (Phồn thể)", stremio: "chi" },
    { code: "ja", label: "日本語", stremio: "jpn" },
    { code: "ko", label: "한국어", stremio: "kor" },
    { code: "th", label: "ไทย", stremio: "tha" },
    { code: "id", label: "Bahasa Indonesia", stremio: "ind" },
    { code: "fr", label: "Français", stremio: "fre" },
    { code: "de", label: "Deutsch", stremio: "ger" },
    { code: "es", label: "Español", stremio: "spa" },
    { code: "pt", label: "Português", stremio: "por" },
    { code: "ru", label: "Русский", stremio: "rus" },
    { code: "it", label: "Italiano", stremio: "ita" },
    { code: "hi", label: "हिन्दी", stremio: "hin" },
];

const GOOGLE_ALIASES = buildAliasMap("code");
const DEEPL_SOURCE_ALIASES = buildAliasMap("deeplSource");
const DEEPL_TARGET_ALIASES = buildAliasMap("deeplTarget");
const STREMIO_ALIASES = buildAliasMap("stremio");

Object.assign(GOOGLE_ALIASES, {
    alb: "sq",
    ara: "ar",
    baq: "eu",
    chi: "zh-CN",
    cze: "cs",
    dut: "nl",
    ell: "el",
    fre: "fr",
    geo: "ka",
    ger: "de",
    heb: "iw",
    hin: "hi",
    ice: "is",
    ind: "id",
    ita: "it",
    jpn: "ja",
    kor: "ko",
    lav: "lv",
    mac: "mk",
    may: "ms",
    per: "fa",
    pob: "pt",
    pol: "pl",
    por: "pt",
    "pt-br": "pt",
    rum: "ro",
    rus: "ru",
    scc: "sr",
    slo: "sk",
    slv: "sl",
    spa: "es",
    swe: "sv",
    tha: "th",
    tur: "tr",
    ukr: "uk",
    vie: "vi",
    zht: "zh-TW",
    zhc: "zh-CN",
    zhe: "zh-CN",
    zho: "zh-CN",
});

Object.assign(DEEPL_SOURCE_ALIASES, {
    chi: "ZH",
    pob: "PT",
    por: "PT",
    vie: "VI",
    zhc: "ZH",
    zhe: "ZH",
    zht: "ZH",
    "zh-cn": "ZH",
    "zh-tw": "ZH",
});

Object.assign(DEEPL_TARGET_ALIASES, {
    chi: "ZH-HANS",
    en: "EN-US",
    eng: "EN-US",
    pob: "PT-BR",
    por: "PT-PT",
    pt: "PT-PT",
    vie: "VI",
    zhc: "ZH-HANS",
    zhe: "ZH-HANS",
    zht: "ZH-HANT",
    "zh-cn": "ZH-HANS",
    "zh-tw": "ZH-HANT",
});

Object.assign(STREMIO_ALIASES, {
    baq: "baq",
    cze: "cze",
    deu: "ger",
    dut: "dut",
    ell: "ell",
    fra: "fre",
    fre: "fre",
    gre: "ell",
    ind: "ind",
    jpn: "jpn",
    kor: "kor",
    nld: "dut",
    ron: "rum",
    slo: "slo",
    spn: "spa",
    tha: "tha",
    vi: "vie",
    vie: "vie",
    zho: "chi",
    zhc: "chi",
    zhe: "chi",
    zht: "chi",
    "zh-cn": "chi",
    "zh-tw": "chi",
    "pt-br": "por",
});

function normalizeGoogleLanguage(language) {
    const normalized = normalizeCode(language);

    return GOOGLE_ALIASES[normalized] || normalized;
}

function normalizeDeepLSourceLanguage(language) {
    const normalized = normalizeCode(language);

    return DEEPL_SOURCE_ALIASES[normalized] || normalized.split("-")[0].toUpperCase();
}

function normalizeDeepLTargetLanguage(language) {
    const normalized = normalizeCode(language);

    return DEEPL_TARGET_ALIASES[normalized] || normalized.toUpperCase();
}

function normalizeStremioLanguage(language) {
    const normalized = normalizeCode(language);

    return STREMIO_ALIASES[normalized] || normalized;
}

function buildAliasMap(targetProperty) {
    const aliases = {};

    for (const language of LANGUAGES) {
        aliases[normalizeCode(language.code)] = normalizeLanguageValue(language[targetProperty], targetProperty);
        aliases[normalizeCode(language.stremio)] = normalizeLanguageValue(language[targetProperty], targetProperty);
    }

    return aliases;
}

function normalizeLanguageValue(value, targetProperty) {
    if (targetProperty === "code") return value;
    if (targetProperty === "deeplSource") return normalizeCode(value).split("-")[0].toUpperCase();
    if (targetProperty === "deeplTarget") return normalizeCode(value).toUpperCase();
    return normalizeCode(value);
}

function normalizeCode(language) {
    return String(language || "")
        .trim()
        .toLowerCase();
}

module.exports = {
    LANGUAGES,
    normalizeDeepLSourceLanguage,
    normalizeDeepLTargetLanguage,
    normalizeGoogleLanguage,
    normalizeStremioLanguage,
};
