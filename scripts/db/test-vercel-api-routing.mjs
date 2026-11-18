#!/usr/bin/env node
/**
 * Vercel single-entry API routing tests — path resolution + handler route matching.
 * Run before Preview deploy to catch multi-segment routing regressions.
 */
import {
  PRODUCTION_ROUTE_CASES,
  resolveProductionUrlPath,
  resolveVercelApiSubPath,
  toHandlerUrlPath,
} from "../shared/vercelApiPath.mjs";
import { parseStorageObjectPath } from "../shared/storagePath.mjs";

const HANDLER_ROUTES = new Map([
  ["/api/health", new Set(["GET"])],
  ["/api/state", new Set(["GET"])],
  ["/api/delta", new Set(["POST"])],
  ["/api/audit", new Set(["GET"])],
  ["/api/audit/clear", new Set(["POST"])],
  ["/api/storage/upload", new Set(["POST"])],
  ["/api/storage/fetch", new Set(["POST"])],
  ["/api/storage/delete", new Set(["POST"])],
]);

function matchesHandlerRoute(path, method) {
  if (HANDLER_ROUTES.has(path)) return HANDLER_ROUTES.get(path).has(method);
  if (path.startsWith("/api/row/") && method === "GET") return true;
  return false;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("  ✓", msg);
}

function simulateRewriteRequest(mountPrefix, segment) {
  const fullPath = segment ? `${mountPrefix}/${segment}` : mountPrefix;
  return {
    url: fullPath,
    query: {},
    headers: {},
  };
}

console.log("--- Vercel API path resolution (rewrite scenarios) ---");

for (const scenario of [
  { name: "original url preserved", req: { url: "/api/production/health", query: {}, headers: {} } },
  { name: "invoke header fallback", req: { url: "/api/production", query: {}, headers: { "x-invoke-path": "/api/production/storage/upload" } } },
  { name: "rewrite query __subpath", req: { url: "/api/production", query: { __subpath: "audit/clear" }, headers: {} } },
  { name: "legacy catch-all query.path array", req: { url: "/api/production", query: { path: ["row", "projects", "x"] }, headers: {} } },
]) {
  const sub = resolveVercelApiSubPath(scenario.req, "/api/production");
  assert(sub.length > 0, `${scenario.name} → sub="${sub}"`);
}

console.log("\n--- Production route table ---");

for (const route of PRODUCTION_ROUTE_CASES) {
  const req = simulateRewriteRequest("/api/production", route.segment);
  const handlerPath = resolveProductionUrlPath(req).split("?")[0];
  assert(
    handlerPath === route.handlerPath,
    `${route.method} /api/production/${route.segment} → ${handlerPath}`
  );
  assert(
    matchesHandlerRoute(handlerPath, route.method),
    `${route.method} ${handlerPath} matches dbHandler route`
  );
}

console.log("\n--- Storage fetch POST route (no query string) ---");

const fetchReq = simulateRewriteRequest("/api/production", "storage/fetch");
const fetchSub = resolveVercelApiSubPath(fetchReq, "/api/production");
const fetchPath = resolveProductionUrlPath(fetchReq).split("?")[0];
assert(fetchSub === "storage/fetch", `fetch subpath → ${fetchSub}`);
assert(fetchPath === "/api/storage/fetch", `fetch handler path → ${fetchPath}`);
assert(!resolveProductionUrlPath(fetchReq).includes("?"), "fetch route has no query string");

console.log("\n--- Storage fetch body paths (slashes, spaces, URL-sensitive) ---");

for (const objectPath of [
  "documents/zfjnvrxmo8rj9ui/test_preview_doc1/preview-test.pdf",
  "documents/p1/file with spaces.pdf",
  "documents/p1/weird?&=#+chars.pdf",
  "documents/p1/café-résumé.pdf",
]) {
  const parsed = parseStorageObjectPath(objectPath);
  assert(parsed === objectPath, `POST body path preserved: ${objectPath}`);
}

console.log("\n--- Staging mount prefix ---");

const stagingSub = resolveVercelApiSubPath(
  simulateRewriteRequest("/api/staging", "storage/upload"),
  "/api/staging"
);
assert(stagingSub === "storage/upload", `staging storage/upload → ${toHandlerUrlPath(stagingSub)}`);

console.log("\nAll routing tests passed.");
