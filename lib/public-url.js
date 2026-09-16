const DEFAULT_PORT = process.env.PORT || "10000";

function getPublicBaseUrl() {
    const fromEnv =
        process.env.ADDON_BASE_URL ||
        (process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL : "") ||
        (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");

    if (fromEnv) return stripTrailingSlash(fromEnv);

    return `http://127.0.0.1:${DEFAULT_PORT}`;
}

function getListenHost() {
    return process.env.HOST || "0.0.0.0";
}

function getDisplayBaseUrl() {
    return getPublicBaseUrl();
}

function getTrustProxySetting() {
    return process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN ? 1 : false;
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
