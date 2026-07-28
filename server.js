#!/usr/bin/env node

const { Buffer } = require("buffer");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { LRUCache } = require("lru-cache");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const { createAddonInterface } = require("./addon");
const { composeDiagnosticVtt, parseDiagnosticSubtitlePayload } = require("./lib/diagnostic-subtitle");
const logger = require("./lib/logger");
const { contentType, recordHttpRequest, renderMetrics } = require("./lib/metrics");
const { getDisplayBaseUrl, getListenHost, getTrustProxySetting } = require("./lib/public-url");
const { createRateLimiters } = require("./lib/rate-limit");
const { renderConfigPage } = require("./lib/web-page");
const { getGeneratedSubtitleResponse } = require("./subtitle-service");

const DEFAULT_CONFIGURED_ROUTER_CACHE_MAX = 100;
const DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS = 6 * 60 * 60;
const CONFIGURED_ROUTER_CACHE_MAX = DEFAULT_CONFIGURED_ROUTER_CACHE_MAX;
const CONFIGURED_ROUTER_CACHE_TTL_SECONDS = DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS;

function createApp() {
    const app = express();
    app.set('trust proxy', true);
    app.use((req, res, next) => { req.headers['x-forwarded-proto'] = 'https'; req.headers.host = 'stremio-one-subtitles.onrender.com'; next(); });
    const imgDir = path.join(__dirname, "img");
    const publicDir = path.join(__dirname, "assets");
    const webDir = path.join(__dirname, "web");
    const configuredRouters = new LRUCache({
        max: CONFIGURED_ROUTER_CACHE_MAX,
        ttl: CONFIGURED_ROUTER_CACHE_TTL_SECONDS * 1000,
        updateAgeOnGet: true,
    });

    app.set("trust proxy", getTrustProxySetting());

    const rateLimiters = createRateLimiters();

    app.use(logRequest);
    app.use((req, res, next) => {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "*");
        res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

        if (req.method === "OPTIONS") {
            res.sendStatus(204);
            return;
        }

        next();
    });
    app.use(rateLimiters.general);
    app.use(rateLimiters.subtitleWork);

    app.use("/public", express.static(publicDir));
    app.use("/assets", express.static(webDir));
    app.use("/img", express.static(imgDir));

    app.get("/", (req, res) => {
        res.type("html").send(renderConfigPage(addonInterface.manifest));
    });

    app.get("/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/configure/:sourceLang/:targetLang/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/configure/:sourceLang/:targetLang/:translationProvider/:deeplApiKey/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/metrics", async (req, res, next) => {
        if (!isMetricsRequestAllowed(req)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        if (!isMetricsRequestAuthorized(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        try {
            res.type(contentType).send(await renderMetrics());
        } catch (error) {
            next(error);
        }
    });

    app.get("/generated-subtitles/:key.vtt", async (req, res, next) => {
        try {
            const subtitle = await getGeneratedSubtitleResponse(req.params.key);
            res.type("text/vtt").set("Cache-Control", subtitle.cacheControl).send(subtitle.vtt);
        } catch (error) {
            next(error);
        }
    });

    app.get("/diagnostic-subtitles/:payload.vtt", (req, res, next) => {
        try {
            const payload = parseDiagnosticSubtitlePayload(req.params.payload);
            res.type("text/vtt").set("Cache-Control", "no-store").send(composeDiagnosticVtt(payload));
        } catch (error) {
            next(error);
        }
    });

    app.use("/configure/:sourceLang/:targetLang/:translationProvider/:deeplApiKey", (req, res, next) => {
        getConfiguredRouter(configuredRouters, {
            deeplApiKey: decodeProviderKey(req.params.deeplApiKey),
            sourceLang: req.params.sourceLang,
            targetLang: req.params.targetLang,
            translationProvider: req.params.translationProvider,
        })(req, res, next);
    });

    app.use("/configure/:sourceLang/:targetLang", (req, res, next) => {
        getConfiguredRouter(configuredRouters, {
            sourceLang: req.params.sourceLang,
            targetLang: req.params.targetLang,
            translationProvider: "googletrans",
        })(req, res, next);
    });

    app.use(getRouter(addonInterface));

    app.use((error, req, res, next) => {
        if (res.headersSent) {
            next(error);
            return;
        }

        logger.error("request failed", {
            error,
            method: req.method,
            path: req.path,
            statusCode: error.statusCode || 500,
        });
        res.status(error.statusCode || 500).json({ error: error.message || "Server error" });
    });

    return app;
}

function getConfiguredRouter(configuredRouters, config) {
    const key = routerCacheKey(config);
    const cached = configuredRouters.get(key);
    if (cached) return cached;

    const router = getRouter(createAddonInterface(config));
    configuredRouters.set(key, router);
    return router;
}

function routerCacheKey(config) {
    return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function logRequest(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const route = routeLabel(req);
        recordHttpRequest({
            durationSeconds,
            method: req.method,
            route,
            status: res.statusCode,
        });
        logger.info("http request", {
            durationMs: durationSeconds * 1000,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
        });
    });

    next();
}

function routeLabel(req) {
    if (req.path === "/") return "/";
    if (req.path === "/metrics") return "/metrics";
    if (req.path.startsWith("/assets/")) return "/assets/*";
    if (req.path.startsWith("/img/")) return "/img/*";
    if (req.path.startsWith("/public/")) return "/public/*";
    if (req.path.startsWith("/generated-subtitles/")) return "/generated-subtitles/:key.vtt";
    if (req.path.startsWith("/diagnostic-subtitles/")) return "/diagnostic-subtitles/:payload.vtt";
    if (/^\/configure\/[^/]+\/[^/]+\/subtitles\//.test(req.path)) {
        return "/configure/:sourceLang/:targetLang/subtitles/*";
    }
    if (/^\/configure\/[^/]+\/[^/]+/.test(req.path)) return "/configure/:sourceLang/:targetLang/*";
    if (req.path.startsWith("/subtitles/")) return "/subtitles/*";
    return "other";
}

function isMetricsRequestAuthorized(req) {
    const token = process.env.METRICS_TOKEN;
    if (!token) return true;
    return req.get("authorization") === `Bearer ${token}`;
}

function isMetricsRequestAllowed(req) {
    return clientAddresses(req).some(isPrivateAddress);
}

function clientAddresses(req) {
    const forwardedFor = String(req.get("x-forwarded-for") || "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);

    if (forwardedFor.length) return forwardedFor;

    return [req.get("x-real-ip"), req.ip, req.socket && req.socket.remoteAddress].filter(Boolean);
}

function isPrivateAddress(address) {
    const ip = String(address)
        .replace(/^::ffff:/, "")
        .toLowerCase();

    return (
        ip === "127.0.0.1" ||
        ip === "::1" ||
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
        ip.startsWith("fc") ||
        ip.startsWith("fd")
    );
}

function decodeProviderKey(value) {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

if (require.main === module) {
    const app = createApp();
    const port = Number(process.env.PORT || 53100);
    const host = getListenHost();
    const server = app.listen(port, host, () => {
        const baseUrl = getDisplayBaseUrl(server.address().port);
        logger.info("server started", {
            host,
            baseUrl: baseUrl,
            port: server.address().port,
        });
    });
}

module.exports = {
    createApp,
    decodeProviderKey,
    isPrivateAddress,
};
