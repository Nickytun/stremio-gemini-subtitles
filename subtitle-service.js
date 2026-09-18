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
const { composeVtt, cueTextForTranslation, parseSubtitleCues } = require("./lib/subtitle-parser");
const { searchPublicStremioOpenSubtitles } = require("./lib/stremio-subtitles");
const { translateCues, translationProvider } = require("./lib/translator");

const RESULT_LIMIT = Number(process.env.SUBTITLE_RESULT_LIMIT || 3);
const GENERATED_SUBTITLE_CACHE_CONTROL = "public, max-age=86400";
const DIAGNOSTIC_SUBTITLE_CACHE_CONTROL = "no-store";
// Số mili-giây đầu phim cần dịch xong TRƯỚC KHI bắt đầu phát bản dịch dở dang cho người xem —
// đủ để người xem không thấy phụ đề tiếng Anh (chưa dịch) ngay từ phút đầu, nhưng không phải đợi
// dịch hết cả phim mới xem được. Phần sau ngưỡng này vẫn tiếp tục dịch ngầm; cues chưa dịch tới
// sẽ tạm hiện nguyên văn ngôn ngữ gốc (composeVtt tự làm việc này) cho tới khi dịch xong.
const PARTIAL_SUBTITLE_WARMUP_MS = Number(process.env.SUBTITLE_WARMUP_MS || 60000);
// Bản dịch dở dang thay đổi liên tục nên KHÔNG được cache ở trình phát/CDN — luôn phải hỏi lại
// server để lấy bản mới nhất (cho tới khi dịch xong hẳn mới chuyển sang GENERATED_SUBTITLE_CACHE_CONTROL).
const PARTIAL_SUBTITLE_CACHE_CONTROL = "no-store";
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

    if (!job.promise) {
        job.startedAt = Date.now();
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
        // Không còn ai await job.promise ở luồng response nữa (xem giải thích bên dưới) — nếu
        // job.promise reject mà không có consumer nào bắt, Node coi là "unhandled rejection" và
        // CÓ THỂ LÀM CRASH CẢ SERVER (mặc định từ Node 15+). Lỗi thật đã được log ở .catch() ngay
        // trên; dòng này chỉ để đánh dấu rejection là "đã xử lý", không làm gì thêm.
        job.promise.catch(() => {});
    } else {
        logger.debug("generated subtitle build joined", { key });
        recordGeneratedSubtitleCache("joined");
    }

    // KHÔNG await job.promise ở đây nữa: bản dịch AI (Gemini/Groq/Mistral xoay vòng, có thể mất
    // 30-90s khi phải dò nhiều model) khiến Stremio treo cả phút chờ 1 response HTTP — trải
    // nghiệm y hệt "không load được sub". Thay vào đó, trả về NGAY một bản VTT "đang dịch" (job
    // vẫn tiếp tục chạy ngầm phía sau nhờ job.promise đã được kích hoạt phía trên, không phụ
    // thuộc việc có ai await nó hay không). Người xem tắt/bật lại phụ đề sau vài chục giây sẽ gọi
    // lại đúng key này — lúc đó cache đã có, trả về ngay lập tức không cần dịch lại.
    // Nếu đã dịch xong đủ phần "phút đầu" (job.cues/job.translated được buildTranslatedVtt cập
    // nhật dần qua callback tiến độ), phát NGAY bản VTT dở dang thay vì bắt người xem chờ dịch
    // hết cả phim — phần chưa dịch tới sẽ tự hiện nguyên văn ngôn ngữ gốc (composeVtt lo việc
    // này) cho tới khi dịch xong, người xem tắt/bật lại phụ đề sẽ thấy phần đã dịch nhiều hơn.
    if (isWarmupSegmentTranslated(job)) {
        const vtt = composeVtt(job.cues, job.translated);
        logGeneratedSubtitleServed({ diagnostic: false, key, source: "partial", startedAt, vtt });
        return { cacheControl: PARTIAL_SUBTITLE_CACHE_CONTROL, diagnostic: false, vtt };
    }

    return translatingGeneratedSubtitleResponse({ job, key, startedAt });
}

// "Phút đầu" đã dịch xong khi: mọi cue có mốc thời gian bắt đầu <= PARTIAL_SUBTITLE_WARMUP_MS
// và CÓ nội dung cần dịch (cueTextForTranslation khác rỗng — có cue chỉ là ký hiệu/trắng thì bỏ
// qua, không tính) đều đã có bản dịch trong job.translated.
function isWarmupSegmentTranslated(job) {
    if (!job.cues || !job.translated) return false;

    for (let index = 0; index < job.cues.length; index += 1) {
        const cue = job.cues[index];
        if (cue.start > PARTIAL_SUBTITLE_WARMUP_MS) break; // cues đã theo đúng thứ tự thời gian
        if (cueTextForTranslation(cue) && !job.translated[index]) return false;
    }

    return true;
}

function translatingGeneratedSubtitleResponse({ job, key, startedAt }) {
    const elapsedSeconds = job.startedAt ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : 0;

    let message;
    if (job.progress && job.progress.totalBatches > 0) {
        const percent = Math.round((job.progress.completedBatches / job.progress.totalBatches) * 100);
        const stuckAtZero = percent === 0 && elapsedSeconds >= 30;
        // Tiến độ = 0% có 2 khả năng rất khác nhau: (a) vừa mới bắt đầu, bình thường, hoặc
        // (b) đã chờ khá lâu mà vẫn 0% — nhiều khả năng các nguồn AI free đang quá tải đồng loạt
        // (đúng thứ đang xảy ra khi hạn mức Gemini/Groq/Mistral cạn cùng lúc). Nói thẳng trường
        // hợp (b) ra thay vì để người xem cứ tưởng "sắp xong tới nơi".
        message = stuckAtZero
            ? `Đang dịch... các nguồn AI miễn phí đang quá tải, đã chờ ${elapsedSeconds}s vẫn chưa xong phần nào (0/${job.progress.totalBatches}). Có thể mất vài phút hoặc lâu hơn — cứ tắt/bật lại phụ đề để kiểm tra.`
            : `Đang dịch... đã xong ${percent}% (${job.progress.completedBatches}/${job.progress.totalBatches} phần). Vui lòng tắt và bật lại phụ đề sau ít phút.`;
    } else if (elapsedSeconds > 0) {
        message = `Đang dịch... đã chờ khoảng ${elapsedSeconds} giây. Vui lòng tắt và bật lại phụ đề sau ít phút.`;
    } else {
        message = "Đang dịch... Vui lòng tắt và bật lại phụ đề sau ít phút.";
    }

    const vtt = composeDiagnosticVtt({ title: "Đang dịch phụ đề bằng AI", message });
    logGeneratedSubtitleServed({ diagnostic: true, key, source: "translating", startedAt, vtt });

    return { cacheControl: DIAGNOSTIC_SUBTITLE_CACHE_CONTROL, diagnostic: true, vtt };
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
    job.cues = cues; // để getGeneratedSubtitleResponse dựng bản VTT dở dang khi cần

    logger.info("subtitle translation started", {
        cueCount: cues.length,
        key: job.key,
        provider: GEMINI_API_KEYS.length ? "gemini" : translationProvider(config),
        sourceLanguage: config.googleSourceLanguage,
        targetLanguage: config.googleTargetLanguage,
    });

    try {
        const translations = await translateCues(cues, config, GEMINI_API_KEYS, (completedBatches, totalBatches, translatedSoFar) => {
            // Ghi tiến độ + GIỮ LUÔN tham chiếu mảng đang dịch dở — mảng này được translateCues
            // tự điền dần vào đúng vị trí (không tạo mảng mới mỗi lần), nên job.translated luôn
            // phản ánh trạng thái MỚI NHẤT dù ta chỉ gán tham chiếu 1 lần.
            job.progress = { completedBatches, totalBatches };
            job.translated = translatedSoFar;
        });
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
