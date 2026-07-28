#!/usr/bin/env node

const { Buffer } = require("buffer");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { LRUCache } = require("lru-cache");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const createAddonInterface = require("./addon");
const { composeDiagnosticVtt, parseDiagnosticSubtitlePayload } = require("./lib/diagnostic-subtitle");
const logger = require("./lib/logger");
const { contentType, recordHttpRequest, renderMetrics } = require("./lib/metrics");
const { getDisplayBaseUrl, getListenHost, getTrustProxySetting } = require("./lib/public-url");
const { createRateLimiters } = require("./lib/rate-limit");
const { renderConfigPage } = require("./lib/web-page");
const { getGeneratedSubtitleResponse } = require("./lib/subtitle-service");

const DEFAULT_CONFIGURED_ROUTER_CACHE_MAX = 100;
const DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS = 6 * 60 * 60;
const CONFIGURED_ROUTER_CACHE_MAX = DEFAULT_CONFIGURED_ROUTER_CACHE_MAX;
const CONFIGURED_ROUTER_CACHE_TTL_SECONDS = DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS;

function createApp() {
  const app = express();

  // 1. Cấu hình trust proxy chuẩn cho Serverless Vercel & Render
  app.set("trust proxy", true);

  // 2. Xóa header 'forwarded' để tránh lỗi ValidationError
  app.use((req, res, next) => {
    delete req.headers["forwarded"];
    next();
  });

  const imgDir = path.join(__dirname, "img");
  const publicDir = path.join(__dirname, "assets");
  const webDir = path.join(__dirname, "web");
  const configuredRouters = new LRUCache({
    max: CONFIGURED_ROUTER_CACHE_MAX,
    ttl: CONFIGURED_ROUTER_CACHE_TTL_SECONDS * 1000,
    updateAgeOnGet: true,
  });

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

  // Serve static files
  app.use("/img", express.static(imgDir));
  app.use("/assets", express.static(publicDir));
  app.use("/public", express.static(publicDir));

  // Route Metrics
  app.get("/metrics", (req, res) => {
    res.set("Content-Type", contentType);
    res.send(renderMetrics());
  });

  // Route Root Config Page
  app.get("/", (req, res) => {
    res.send(renderConfigPage(req));
  });

  // Route Subtitle / Configure
  app.use("/configure/:from/:to", (req, res, next) => {
    const config = {
      from: req.params.from,
      to: req.params.to,
    };
    const router = getConfiguredRouter(configuredRouters, config);
    router(req, res, next);
  });

  app.use("/configure/:from/:to/:provider", (req, res, next) => {
    const config = {
      from: req.params.from,
      to: req.params.to,
      provider: req.params.provider,
    };
    const router = getConfiguredRouter(configuredRouters, config);
    router(req, res, next);
  });

  app.use("/configure/:from/:to/:provider/:key", (req, res, next) => {
    const config = {
      from: req.params.from,
      to: req.params.to,
      provider: req.params.provider,
      key: req.params.key,
    };
    const router = getConfiguredRouter(configuredRouters, config);
    router(req, res, next);
  });

  // Root addon router fallback
  const defaultRouter = getRouter(addonInterface);
  app.use(defaultRouter);

  // Global Error Handler
  app.use((error, req, res, next) => {
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
      statusCode: res.statusCode,
    });
  });

  next();
}

function routeLabel(req) {
  if (req.path === "/") return "/";
  if (req.path === "/metrics") return "/metrics";
  if (req.path.includes("/subtitles/")) return "/subtitles";
  if (req.path.includes("/manifest.json")) return "/manifest.json";
  return "other";
}

const app = createApp();

if (require.main === module) {
  const port = process.env.PORT || 7000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
