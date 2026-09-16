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
const { getDisplayBaseUrl } = require("./lib/public-url");
const { renderConfigPage } = require("./lib/web-page");
const { getGeneratedSubtitleResponse } = require("./subtitle-service");

const CONFIGURED_ROUTER_CACHE_MAX = 100;
const CONFIGURED_ROUTER_CACHE_TTL_SECONDS = 6 * 60 * 60;
const PROVIDERS = new Set(["gemini", "googletrans", "deepl"]);
const RESERVED_SEGMENTS = new Set(["manifest.json", "subtitles", "configure", "catalog", "meta", "stream"]);

function createApp() {
    const app = express();
    app.set("trust proxy", true);

    const imgDir = path.join(__dirname, "img");
    const publicDir = path.join(__dirname, "assets");
    const webDir = path.join(__dirname, "web");
    const configuredRouters = new LRUCache({
        max: CONFIGURED_ROUTER_CACHE_MAX,
        ttl: CONFIGURED_ROUTER_CACHE_TTL_SECONDS * 1000,
        updateAgeOnGet: true,
    });

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

    app.use("/public", express.static(publicDir));
    app.use("/assets", express.static(webDir));
    app.use("/img", express.static(imgDir));

    app.get("/", (req, res) => {
        res.type("html").send(renderConfigPage(addonInterface.manifest));
    });

    app.get("/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/health", (req, res) => {
        res.json({
            geminiKeysConfigured: String(process.env.GEMINI_KEYS || process.env.GEMINI_API_KEY || "")
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean).length,
            ok: true,
        });
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

    // Chấp nhận mọi dạng URL cấu hình:
    //   /configure/:src/:tgt/manifest.json
    //   /configure/:src/:tgt/gemini/manifest.json
    //   /configure/:src/:tgt/gemini/:base64Key/manifest.json
    app.use("/configure/:sourceLang/:targetLang", (req, res, next) => {
        const [pathname, query] = req.url.split("?");
        const segments = pathname.split("/").filter(Boolean);

        let consumed = 0;
        let translationProvider = "gemini";
        let providerKey = "";

        if (segments[0] && PROVIDERS.has(segments[0].toLowerCase())) {
            translationProvider = segments[0].toLowerCase();
            consumed = 1;

            if (segments[1] && !RESERVED_SEGMENTS.has(segments[1])) {
                providerKey = safeDecodeProviderKey(segments[1]);
                consumed = 2;
            }
        }

        const rest = segments.slice(consumed);
        if (rest[0] === "configure") {
            res.redirect("/");
            return;
        }

        req.url = `/${rest.join("/")}${query ? `?${query}` : ""}`;

        getConfiguredRouter(configuredRouters, {
            providerKey,
            sourceLang: req.params.sourceLang,
            targetLang: req.params.targetLang,
            translationProvider,
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
    const originalPath = req.path;

    res.on("finish", () => {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        recordHttpRequest({
            durationSeconds,
            method: req.method,
            route: routeLabel(originalPath),
            status: res.statusCode,
        });
        logger.info("http request", {
            durationMs: durationSeconds * 1000,
            method: req.method,
            path: originalPath,
            statusCode: res.statusCode,
        });
    });

    next();
}

function routeLabel(pathname) {
    if (pathname === "/") return "/";
    if (pathname === "/metrics") return "/metrics";
    if (pathname.startsWith("/assets/")) return "/assets/*";
    if (pathname.startsWith("/img/")) return "/img/*";
    if (pathname.startsWith("/public/")) return "/public/*";
    if (pathname.startsWith("/generated-subtitles/")) return "/generated-subtitles/:key.vtt";
    if (pathname.startsWith("/diagnostic-subtitles/")) return "/diagnostic-subtitles/:payload.vtt";
    if (/^\/configure\/[^/]+\/[^/]+/.test(pathname)) return "/configure/:sourceLang/:targetLang/*";
    if (pathname.startsWith("/subtitles/")) return "/subtitles/*";
    return "other";
}

function isMetricsRequestAuthorized(req) {
    const token = process.env.METRICS_TOKEN;
    if (!token) return true;
    return req.get("authorization") === `Bearer ${token}`;
}

function isMetricsRequestAllowed(req) {
    if (process.env.METRICS_TOKEN) return true;
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

function safeDecodeProviderKey(value) {
    try {
        return decodeProviderKey(value);
    } catch {
        return "";
    }
}

if (require.main === module) {
    const app = createApp();
    const port = Number(process.env.PORT || 10000);
    const server = app.listen(port, "0.0.0.0", () => {
        logger.info("server started", {
            baseUrl: getDisplayBaseUrl(server.address().port),
            host: "0.0.0.0",
            port: server.address().port,
        });
    });
}

module.exports = {
    createApp,
    decodeProviderKey,
    isPrivateAddress,
};
