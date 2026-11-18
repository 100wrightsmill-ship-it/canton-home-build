#!/usr/bin/env node
/**
 * Combined STAGING app server: static dist + staging API on one port (Safari/iPhone friendly).
 * Run: npm run build:staging && npm run staging:serve
 */
import http from "http";
import { readFileSync, existsSync, statSync, createReadStream } from "fs";
import { join, extname } from "path";
import { loadStagingEnv } from "./db/load-staging-env.mjs";
import { createStagingPool, getStagingDatabaseUrl } from "../src/db/pg.js";
import { createStagingHandler } from "./staging/handleRequest.mjs";

loadStagingEnv();

const PORT = Number(process.env.STAGING_SERVE_PORT || 3335);
const DIST = join(process.cwd(), "dist");
const API_PREFIX = "/staging-api";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

if (!getStagingDatabaseUrl()) {
  console.error("STAGING_DATABASE_URL required in .env.staging");
  process.exit(1);
}
if (!existsSync(join(DIST, "index.html"))) {
  console.error("dist/ not found — run: npm run build:staging");
  process.exit(1);
}

const pool = createStagingPool();
const handleRequest = createStagingHandler(pool);

function serveStatic(pathname, res) {
  let file = pathname === "/" ? "/index.html" : pathname;
  const abs = join(DIST, file);
  if (!abs.startsWith(DIST) || !existsSync(abs) || statSync(abs).isDirectory()) {
    file = "/index.html";
  }
  const finalPath = join(DIST, file === "/index.html" ? "index.html" : file.replace(/^\//, ""));
  if (!existsSync(finalPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(finalPath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  createReadStream(finalPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith(API_PREFIX)) {
    const apiPath = url.pathname.slice(API_PREFIX.length) || "/";
    return handleRequest(req, res, { urlPath: apiPath + url.search });
  }
  return serveStatic(url.pathname, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`STAGING combined server: http://0.0.0.0:${PORT}`);
  console.log(`  App + API same origin (${API_PREFIX} → cc_staging)`);
});
