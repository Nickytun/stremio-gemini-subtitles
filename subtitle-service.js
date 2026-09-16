const crypto = require("crypto");
const { Buffer } = require("buffer");
const { LRUCache } = require("lru-cache");
const { getSubtitleConfig } = require("./lib/config");
const { composeDiagnosticVtt, createDiagnosticSubtitleOption } = require("./lib/diagnostic-subtitle");
const { getCachedGeneratedSubtitle, setCachedGeneratedSubtitle } = require("./lib/generated-subtitle-cache");
const { fetchText } = require("./lib/http-client");
const { normalizeStremioLanguage } = require("./lib/languages");
const logger = require("./lib/logger");
const {
    recordGeneratedSubtitleCache,
    recordSubtitleCandidates,
    recordSubtitleLookup,
    recordSubtitleTranslation,
} = require("./lib/metrics");
const { getPublicBaseUrl } = require("./lib/public-url");
const { composeVtt, parseSubtitleCues } = require("./lib/subtitle-parser");
const { searchPublicStremioOpenSubtitles } = require("./lib/stremio-subtitles");
const { translateCues, translationProvider } = require("./lib/translator");

const RESULT_LIMIT = Number(process.env.SUBTITLE_RESULT_LIMIT || 3);
const GENERATED_SUBTITLE_CACHE_CONTROL = "public, max-age=86400";
const DIAGNOSTIC_SUBTITLE_CACHE_CONTROL = "no-store";
const JOB_MAX = 1000;
const JOB_TTL_SECONDS = 24 * 60 * 60;

// Thứ tự ưu tiên khi KHÔNG tìm được phụ đề đúng ngôn ngữ nguồn đã chọn.
// Có thể ghi đè bằng biến môi trường SUBTITLE_FALLBACK_LANGS="eng,chi,jpn,kor".
const DEFAULT_FALLBACK_LANGUAGES = ["eng", "chi", "jpn", "kor", "spa", "fre", "ger", "por", "rus", "tha", "ind"];

// Key Gemini lấy từ biến môi trường của Render (không bao giờ nằm trong URL/repo).
const GEMINI_API_KEYS = String(process.env.GEMINI_KEYS || process.env.GEMINI_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

const jobs = new LRUCache({
    max: JOB_MAX,
    ttl: JOB_TTL_SECONDS * 1000,
    updateAgeOnGet: true,
});

function fallbackLanguages() {
    const fromEnv = String(process.env.SUBTITLE_FALLBACK_LANGS || "")
        .split(",")
        .map((value) => normalizeStremioLanguage(value))
        .filter(Boolean);

    return fromEnv.length ? fromEnv : DEFAULT_FALLBACK_LANGUAGES;
}

function subtitleLanguage(subtitle) {
    return normalizeStremioLanguage(subtitle.lang || subtitle.language || "");
}

/**
 * Chọn phụ đề nguồn:
 *  1. Ưu tiên đúng ngôn ngữ nguồn đã cấu hình.
 *  2. Nếu không có -> tự động lấy phụ đề ở ngôn ngữ KHÁC của đúng bản phim đó
 *     (theo thứ tự ưu tiên), rồi dịch sang ngôn ngữ đích như bình thường.
 */
function selectSourceSubtitles(results, config) {
    const targetLanguage = config.stremioTargetLanguage;
    const sourceLanguage = config.stremioSourceLanguage;

    const exact = results.filter((subtitle) => subtitleLanguage(subtitle) === sourceLanguage);
    if (exact.length) {
        return { subtitles: exact.slice(0, RESULT_LIMIT), usedFallback: false };
    }

    // Bỏ qua phụ đề vốn đã ở ngôn ngữ đích (dịch vi -> vi là vô nghĩa).
    const usable = results.filter((subtitle) => {
        const language = subtitleLanguage(subtitle);
        return language && language !== targetLanguage;
    });

    if (!usable.length) return { subtitles: [], usedFallback: false };

    const priority = fallbackLanguages();
    const ranked = [...usable].sort((left, right) => {
        const leftRank = priority.indexOf(subtitleLanguage(left));
        const rightRank = priority.indexOf(subtitleLanguage(right));
        return (leftRank === -1 ? 999 : leftRank) - (rightRank === -1 ? 999 : rightRank);
    });

    return { subtitles: ranked.slice(0, RESULT_LIMIT), usedFallback: true };
}

async function getSubtitleOptions(args) {
    const config = getSubtitleConfig(args.config || (args.extra && args.extra.__config));
    logger.info("subtitle options requested", {
        id: args.id,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        type: args.type,
    });

    try {
        const results = await searchPublicStremioOpenSubtitles(args);

        recordSubtitleCandidates({
            count: results.length,
            sourceLanguage: config.sourceLanguage,
            stage: "upstream",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });

        const { subtitles: selected, usedFallback } = selectSourceSubtitles(results, config);

        recordSubtitleCandidates({
            count: selected.length,
            sourceLanguage: config.sourceLanguage,
            stage: "source_language",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });

        if (usedFallback) {
            logger.info("source language missing, using fallback languages", {
                availableLanguages: [...new Set(results.map(subtitleLanguage).filter(Boolean))],
                id: args.id,
                requestedSourceLanguage: config.stremioSourceLanguage,
                selectedLanguages: selected.map(subtitleLanguage),
            });
        }

        const subtitles = buildSubtitleOptions(args, results, selected, config);

        recordSubtitleLookup({
            sourceLanguage: config.sourceLanguage,
            status: "success",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        logger.info("subtitle options resolved", {
            id: args.id,
            returnedCount: subtitles.length,
            sourceLanguageCount: selected.length,
            totalCount: results.length,
            usedFallback,
        });
        return { subtitles };
    } catch (error) {
        logger.error("subtitle lookup failed", { error, id: args.id, type: args.type });
        recordSubtitleLookup({
            sourceLanguage: config.sourceLanguage,
            status: "failure",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });

        return {
            subtitles: [
                createDiagnosticSubtitleOption({
                    code: "lookup-failed",
                    config,
                    title: "Double Subtitles lookup failed",
                    message: "Could not look up source subtitles for this video.",
                }),
            ],
        };
    }
}

function buildSubtitleOptions(args, results, selected, config) {
    if (!results.length) {
        return [
            createDiagnosticSubtitleOption({
                code: "no-upstream-subtitles",
                config,
                title: "Double Subtitles notice",
                message: "OpenSubtitles did not return any subtitles for this video.",
            }),
        ];
    }

    if (!selected.length) {
        return [
            createDiagnosticSubtitleOption({
                code: "no-source-language-subtitles",
                config,
                title: "Double Subtitles notice",
                message: `No usable subtitles were found for this video (requested ${config.sourceLanguage}).`,
            }),
        ];
    }

    return selected
        .map((subtitle) => {
            // Mỗi phụ đề dùng đúng ngôn ngữ thật của nó làm ngôn ngữ nguồn khi dịch.
            const actualLanguage = subtitleLanguage(subtitle) || config.sourceLanguage;
            const subtitleConfig = getSubtitleConfig({
                ...config,
                sourceLang: actualLanguage,
                sourceLanguage: actualLanguage,
                targetLang: config.targetLanguage,
            });
            return createSubtitleOption(args, subtitle, subtitleConfig);
        })
        .filter(Boolean)
        .slice(0, RESULT_LIMIT);
}

function createSubtitleOption(args, subtitle, config) {
    const key = hashKey({
        type: args.type,
        id: args.id,
        sourceLanguage: config.stremioSourceLanguage,
        targetLanguage: config.stremioTargetLanguage,
        subtitleId: subtitle.id,
        subtitleUrl: subtitle.url,
    });

    if (!jobs.get(key)) {
        jobs.set(key, {
            key,
            config,
            subtitleUrl: subtitle.url,
            title: `OpenSubtitles v3 ${subtitle.id}`,
        });
    }

    return {
        id: `opensubtitles-v3-${subtitle.id}-${config.stremioSourceLanguage}-to-${config.stremioTargetLanguage}`,
        url: `${getPublicBaseUrl()}/generated-subtitles/${key}.vtt`,
        lang: config.stremioTargetLanguage || "vie",
    };
}

async function getGeneratedSubtitleResponse(key) {
    const startedAt = process.hrtime.bigint();
    const cachedSubtitle = await getCachedGeneratedSubtitle(key);
    if (cachedSubtitle) {
        logger.debug("generated subtitle cache hit", { key, source: cachedSubtitle.source });
        recordGeneratedSubtitleCache(`${cachedSubtitle.source}_hit`);
        logGeneratedSubtitleServed({
            cacheSource: cachedSubtitle.source,
            key,
            source: "cache",
            startedAt,
            vtt: cachedSubtitle.vtt,
        });
        return generatedSubtitleResponse(cachedSubtitle.vtt);
    }

    const job = jobs.get(key);
    if (!job) {
        return diagnosticGeneratedSubtitleResponse({
            key,
            message: "Generated subtitle expired or was not found.",
            source: "missing",
            startedAt,
        });
    }

    const source = job.promise ? "joined" : "build";
    if (!job.promise) {
        logger.info("generated subtitle build queued", { key });
        recordGeneratedSubtitleCache("miss");
        job.promise = buildTranslatedVtt(job)
            .then((vtt) =>
                setCachedGeneratedSubtitle(key, vtt).then(() => {
                    if (jobs.get(key) === job) jobs.delete(key);
                    return vtt;
                }),
            )
            .then((vtt) => {
                logger.info("generated subtitle cached", { bytes: Buffer.byteLength(vtt, "utf8"), key });
                return vtt;
            })
            .catch((error) => {
                job.promise = null;
                logger.error("generated subtitle build failed", { error, key });
                throw error;
            });
    } else {
        logger.debug("generated subtitle build joined", { key });
        recordGeneratedSubtitleCache("joined");
    }

    try {
        const vtt = await job.promise;
        logGeneratedSubtitleServed({ key, source, startedAt, vtt });
        return generatedSubtitleResponse(vtt);
    } catch (error) {
        return diagnosticGeneratedSubtitleResponse({
            error,
            key,
            message: "Could not generate translated subtitles for this video.",
            source: "error",
            startedAt,
        });
    }
}

function generatedSubtitleResponse(vtt) {
    return { cacheControl: GENERATED_SUBTITLE_CACHE_CONTROL, diagnostic: false, vtt };
}

function diagnosticGeneratedSubtitleResponse({ error, key, message, source, startedAt }) {
    const vtt = composeDiagnosticVtt({ title: "Double Subtitles error", message });
    logGeneratedSubtitleServed({ diagnostic: true, error, key, source, startedAt, vtt });

    return { cacheControl: DIAGNOSTIC_SUBTITLE_CACHE_CONTROL, diagnostic: true, vtt };
}

function logGeneratedSubtitleServed({ cacheSource, diagnostic, error, key, source, startedAt, vtt }) {
    logger.info("generated subtitle served", {
        bytes: Buffer.byteLength(vtt, "utf8"),
        cacheSource,
        diagnostic,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        error,
        key,
        source,
    });
}

async function buildTranslatedVtt(job) {
    const config = getSubtitleConfig(job.config);
    const startedAt = process.hrtime.bigint();
    logger.info("source subtitle download started", { key: job.key, subtitleUrl: job.subtitleUrl });

    const subtitleText = await fetchText(job.subtitleUrl);
    const cues = parseSubtitleCues(subtitleText);
    if (!cues.length) throw new Error(`No subtitle cues found for ${job.title}`);

    logger.info("subtitle translation started", {
        cueCount: cues.length,
        key: job.key,
        provider: GEMINI_API_KEYS.length ? "gemini" : translationProvider(config),
        sourceLanguage: config.googleSourceLanguage,
        targetLanguage: config.googleTargetLanguage,
    });

    try {
        const translations = await translateCues(cues, config, GEMINI_API_KEYS);
        const vtt = composeVtt(cues, translations);

        recordSubtitleTranslation({
            bytes: Buffer.byteLength(vtt, "utf8"),
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: "success",
            targetLanguage: config.targetLanguage,
        });
        logger.info("subtitle translation finished", { cueCount: cues.length, key: job.key });
        return vtt;
    } catch (error) {
        recordSubtitleTranslation({
            bytes: 0,
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: "failure",
            targetLanguage: config.targetLanguage,
        });
        throw error;
    }
}

function hashKey(value) {
    return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

module.exports = {
    getGeneratedSubtitleResponse,
    getSubtitleOptions,
    selectSourceSubtitles,
};
