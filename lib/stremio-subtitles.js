const { fetchJson } = require("./http-client");
const logger = require("./logger");

const STREMIO_OPEN_SUBTITLES_URL = "https://opensubtitles-v3.strem.io";

/**
 * OpenSubtitles thường khớp theo hash chính xác của file (videoHash/videoSize).
 * Với các bản encode ít phổ biến, hash không khớp bản nào trong kho -> trả về rỗng,
 * dù vẫn có phụ đề khác cho đúng bộ phim đó (khớp theo IMDB id thay vì hash).
 * Vì vậy ta thử lần lượt từ truy vấn CHÍNH XÁC nhất tới truy vấn RỘNG nhất,
 * dùng ngay kết quả đầu tiên có phụ đề thay vì bỏ cuộc sau 1 lần thử.
 */
async function searchPublicStremioOpenSubtitles(args) {
    const attempts = buildLookupAttempts(args.extra || {});

    for (let index = 0; index < attempts.length; index += 1) {
        const extra = attempts[index];
        const isLastAttempt = index === attempts.length - 1;

        try {
            const subtitles = await runLookup({ ...args, extra });
            logger.info("opensubtitles lookup finished", {
                attempt: index + 1,
                id: args.id,
                subtitleCount: subtitles.length,
                type: args.type,
            });

            if (subtitles.length) {
                if (index > 0) {
                    logger.info("opensubtitles broadened query succeeded", {
                        attempt: index + 1,
                        id: args.id,
                        usedExtraKeys: Object.keys(extra),
                    });
                }
                return subtitles;
            }
        } catch (error) {
            logger.warn("opensubtitles lookup attempt failed", {
                attempt: index + 1,
                error,
                id: args.id,
            });
            if (isLastAttempt) return [];
        }
    }

    return [];
}

async function runLookup(args) {
    const url = `${STREMIO_OPEN_SUBTITLES_URL}${buildStremioAddonPath(args)}`;
    logger.info("opensubtitles lookup started", {
        extraKeys: Object.keys(args.extra || {}),
        id: args.id,
        type: args.type,
    });
    const response = await fetchJson(url);

    if (!Array.isArray(response.subtitles)) return [];
    return response.subtitles.filter((subtitle) => subtitle.url);
}

/**
 * Trả về danh sách "extra" theo thứ tự từ hẹp -> rộng:
 *  1. Đầy đủ (filename + videoSize + videoHash) — khớp chính xác nhất, đồng bộ timing tốt nhất.
 *  2. Bỏ videoHash — vẫn ưu tiên đúng bản encode qua tên file, nới lỏng khớp hash.
 *  3. Chỉ giữ filename — nới lỏng thêm.
 *  4. Không có extra — tìm theo IMDB id, trả về mọi phụ đề có cho phim đó bất kể bản encode.
 * Bỏ qua bước nào trùng với bước trước (ví dụ nếu vốn không có videoHash thì không lặp lại).
 */
function buildLookupAttempts(extra) {
    const base = sanitizeExtra(extra);
    const attempts = [base];

    const withoutHash = omit(base, ["videoHash"]);
    pushIfDifferent(attempts, withoutHash);

    const withoutHashAndSize = omit(withoutHash, ["videoSize"]);
    pushIfDifferent(attempts, withoutHashAndSize);

    pushIfDifferent(attempts, {});

    return attempts;
}

function pushIfDifferent(attempts, candidate) {
    const last = attempts[attempts.length - 1];
    if (JSON.stringify(sortedEntries(last)) !== JSON.stringify(sortedEntries(candidate))) {
        attempts.push(candidate);
    }
}

function sortedEntries(object) {
    return Object.entries(object).sort(([a], [b]) => a.localeCompare(b));
}

function omit(object, keys) {
    const result = { ...object };
    keys.forEach((key) => delete result[key]);
    return result;
}

function sanitizeExtra(extra) {
    return Object.fromEntries(
        Object.entries(extra).filter(
            ([key, value]) => key !== "__config" && value !== undefined && value !== null && value !== "",
        ),
    );
}

function buildStremioAddonPath(args) {
    const encodedId = encodeURIComponent(args.id);
    const encodedExtra = encodeExtra(args.extra || {});
    const extraSegment = encodedExtra ? `/${encodedExtra}` : "";

    return `/subtitles/${encodeURIComponent(args.type)}/${encodedId}${extraSegment}.json`;
}

function encodeExtra(extra) {
    return Object.entries(extra)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
}

module.exports = {
    searchPublicStremioOpenSubtitles,
};
