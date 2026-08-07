const DEFAULT_PORT = process.env.PORT || "53100";

function getPublicBaseUrl() {
    return "https://stremio-gemini-subtitles.onrender.com";
}

function getListenHost() {
    return process.env.HOST || "0.0.0.0";
}

function getDisplayBaseUrl(port) {
    return getPublicBaseUrl();
}

function getTrustProxySetting() {
    return process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN ? 1 : false;
}

function stripTrailingSlash(value) {
    return String(value).replace(/\/+$/, "");
}

module.exports = {
    getDisplayBaseUrl,
    getListenHost,
    getPublicBaseUrl,
    getTrustProxySetting,
};
