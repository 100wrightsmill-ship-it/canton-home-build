/**
 * Resolve handler sub-path for Vercel single-entry API routes (rewrite architecture).
 * After rewrite to /api/{env}, the original path may appear on req.url, invoke headers,
 * or __subpath query — NOT req.query.path (reserved for storage fetch ?path=…).
 */
function headerPath(req) {
  const h = req.headers || {};
  const invoke =
    h["x-invoke-path"] ||
    h["x-vercel-invoke-path"] ||
    h["x-matched-path"] ||
    h["x-vercel-sc-path"];
  if (typeof invoke === "string" && invoke) return invoke.split("?")[0];
  return "";
}

function subpathFromRewriteQuery(req) {
  const raw = req.query?.__subpath;
  if (Array.isArray(raw) && raw.length) return raw.join("/");
  if (typeof raw === "string" && raw) return raw.replace(/^\/+/, "");
  return "";
}

function subpathFromFullPath(pathOnly, mount, prefix) {
  if (pathOnly === mount) return "";
  if (pathOnly.startsWith(prefix)) return pathOnly.slice(prefix.length).replace(/^\/+/, "");
  const idx = pathOnly.indexOf(prefix);
  if (idx >= 0) return pathOnly.slice(idx + prefix.length).replace(/^\/+/, "");
  return null;
}

/** Legacy optional catch-all: req.query.path segments when URL is bare mount only. */
function legacyCatchAllSubpath(req, mount) {
  const pathOnly = (req.url || "").split("?")[0];
  if (pathOnly !== mount) return "";
  const segments = req.query?.path;
  if (Array.isArray(segments) && segments.length) return segments.join("/");
  if (typeof segments === "string" && segments) return segments.replace(/^\/+/, "");
  return "";
}

export function resolveVercelApiSubPath(req, mountPrefix) {
  const mount = mountPrefix.replace(/\/$/, "");
  const prefix = `${mount}/`;

  const invoke = headerPath(req);
  if (invoke) {
    const fromInvoke = subpathFromFullPath(invoke, mount, prefix);
    if (fromInvoke !== null) return fromInvoke;
  }

  const raw = req.url || "";
  const pathOnly = raw.split("?")[0];
  const fromUrl = subpathFromFullPath(pathOnly, mount, prefix);
  if (fromUrl !== null && fromUrl) return fromUrl;

  const fromRewrite = subpathFromRewriteQuery(req);
  if (fromRewrite) return fromRewrite;

  if (fromUrl !== null && pathOnly === mount) return legacyCatchAllSubpath(req, mount);

  if (fromUrl !== null) return fromUrl;

  return legacyCatchAllSubpath(req, mount);
}

export function toHandlerUrlPath(sub, qs = "") {
  if (!sub) return `/api/health${qs}`;
  if (sub.startsWith("api/") || sub === "api") return `/${sub}${qs}`;
  return `/api/${sub}${qs}`;
}

/** Preserve query string after Vercel rewrite (req.url query may truncate ?path= at slashes). */
export function buildHandlerQueryString(req) {
  const q = req.query || {};
  const params = new URLSearchParams();

  for (const [k, v] of Object.entries(q)) {
    if (k === "__subpath" || k === "path") continue;
    if (typeof v === "string") params.set(k, v);
    else if (Array.isArray(v) && v.length) params.set(k, v.join("/"));
  }

  let objectPath = "";
  if (typeof q.path === "string" && q.path) {
    objectPath = q.path;
  } else if (Array.isArray(q.path) && q.path.length === 1 && typeof q.path[0] === "string") {
    objectPath = q.path[0];
  }

  const raw = req.url || "";
  const qIdx = raw.indexOf("?");
  if (qIdx >= 0) {
    const urlParams = new URLSearchParams(raw.slice(qIdx + 1));
    for (const [k, v] of urlParams.entries()) {
      if (k === "path") {
        if (!objectPath) objectPath = v;
        continue;
      }
      if (!params.has(k)) params.set(k, v);
    }
  }

  if (objectPath) params.set("path", objectPath);

  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Expected handler paths for routing regression tests. */
export const PRODUCTION_ROUTE_CASES = [
  { segment: "health", method: "GET", handlerPath: "/api/health" },
  { segment: "state", method: "GET", handlerPath: "/api/state" },
  { segment: "delta", method: "POST", handlerPath: "/api/delta" },
  { segment: "audit", method: "GET", handlerPath: "/api/audit" },
  { segment: "audit/clear", method: "POST", handlerPath: "/api/audit/clear" },
  { segment: "storage/upload", method: "POST", handlerPath: "/api/storage/upload" },
  { segment: "storage/fetch", method: "POST", handlerPath: "/api/storage/fetch" },
  { segment: "storage/delete", method: "POST", handlerPath: "/api/storage/delete" },
  { segment: "row/projects/zfjnvrxmo8rj9ui", method: "GET", handlerPath: "/api/row/projects/zfjnvrxmo8rj9ui" },
];

export function resolveProductionUrlPath(req) {
  const sub = resolveVercelApiSubPath(req, "/api/production");
  const qs = buildHandlerQueryString(req);
  return toHandlerUrlPath(sub, qs);
}
