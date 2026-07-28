const LANGUAGES = [
  { code: "en", label: "English", stremio: "eng" },
  { code: "vi", label: "Vietnamese", stremio: "vie" }
];

const GOOGLE_ALIASES = buildAliasMap("code");
const DEEPL_SOURCE_ALIASES = buildAliasMap("deeplSource");
const DEEPL_TARGET_ALIASES = buildAliasMap("deeplTarget");
const STREMIO_ALIASES = buildAliasMap("stremio");

Object.assign(GOOGLE_ALIASES, {
    alb: "sq",
    baq: "eu",
    chi: "zh-CN",
    cze: "cs",
    dut: "nl",
    ell: "el",
    fre: "fr",
    geo: "ka",
    ger: "de",
    ice: "is",
    jpn: "ja",
    lav: "lv",
    mac: "mk",
    may: "ms",
    per: "fa",
    pob: "pt",
    por: "pt",
    "pt-br": "pt",
    rum: "ro",
    scc: "sr",
    slo: "sk",
    slv: "sl",
    spa: "es",
    swe: "sv",
    zht: "zh-TW",
    zhc: "zh-CN",
    zhe: "zh-CN",
});

Object.assign(DEEPL_SOURCE_ALIASES, {
    chi: "ZH",
    pob: "PT",
    por: "PT",
    zhc: "ZH",
    zhe: "ZH",
    zht: "ZH",
});

Object.assign(DEEPL_TARGET_ALIASES, {
    chi: "ZH-HANS",
    en: "EN-US",
    eng: "EN-US",
    pob: "PT-BR",
    por: "PT-PT",
    pt: "PT-PT",
    zhc: "ZH-HANS",
    zhe: "ZH-HANS",
    zht: "ZH-HANT",
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
    nld: "dut",
    ron: "rum",
    slo: "slo",
    spn: "spa",
    zho: "chi",
    zhc: "chi",
    zhe: "chi",
});

function normalizeGoogleLanguage(language) {
    const normalized = normalizeCode(language);

    return GOOGLE_ALIASES[normalized] || normalized;
}

function normalizeDeepLSourceLanguage(language) {
    const normalized = normalizeCode(language);

    return DEEPL_SOURCE_ALIASES[normalized] || normalized.toUpperCase();
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
