/**
 * Production Supabase Storage — same cc-data bucket as state.json mode.
 * Requires explicit production confirmation for mutating operations.
 */
import { loadProductionEnv } from "../db/load-production-env.mjs";
import {
  requireProductionConfirmation,
  assertProductionApiStorageWriteAllowed,
  assertProductionSupabaseUrl,
} from "../../src/db/safety.js";
import { PRODUCTION_SUPABASE_URL } from "../../src/db/schemaConfig.js";
import { BUCKET } from "../../src/sync/cloudSync.js";

loadProductionEnv();

export const PRODUCTION_BUCKET = BUCKET;

export function getProductionSupabaseUrl() {
  const url = (process.env.PRODUCTION_SUPABASE_URL || PRODUCTION_SUPABASE_URL).replace(/\/$/, "");
  assertProductionSupabaseUrl(url);
  return url;
}

export function getProductionServiceRoleKey() {
  const key =
    process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY required in .env.production.local"
    );
  }
  return key;
}

function authHeaders(contentType) {
  const key = getProductionServiceRoleKey();
  const h = { Authorization: `Bearer ${key}`, apikey: key };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

export function productionStorageObjectUrl(objectPath) {
  return `${getProductionSupabaseUrl()}/storage/v1/object/${PRODUCTION_BUCKET}/${objectPath}`;
}

export async function uploadProductionObject(objectPath, body, contentType, { upsert = true, viaApi = false } = {}) {
  if (viaApi) assertProductionApiStorageWriteAllowed();
  else requireProductionConfirmation();
  const res = await fetch(productionStorageObjectUrl(objectPath), {
    method: "PUT",
    headers: { ...authHeaders(contentType || "application/octet-stream"), ...(upsert ? { "x-upsert": "true" } : {}) },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Production storage upload failed (${res.status}): ${text}`), { status: res.status });
  }
  return { ok: true, path: objectPath };
}

export async function fetchProductionObject(objectPath) {
  const res = await fetch(productionStorageObjectUrl(objectPath), { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Production storage fetch failed (${res.status}): ${text}`), { status: res.status });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, buffer: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

export async function deleteProductionObject(objectPath, { viaApi = false } = {}) {
  if (viaApi) assertProductionApiStorageWriteAllowed();
  else requireProductionConfirmation();
  const url = `${getProductionSupabaseUrl()}/storage/v1/object/${PRODUCTION_BUCKET}/${objectPath}`;
  const res = await fetch(url, { method: "DELETE", headers: authHeaders() });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Production storage delete failed (${res.status}): ${text}`), { status: res.status });
  }
  return { ok: true, path: objectPath };
}

export async function copyProductionObject(sourcePath, destPath) {
  requireProductionConfirmation();
  const fetched = await fetchProductionObject(sourcePath);
  await uploadProductionObject(destPath, fetched.buffer, fetched.contentType, { upsert: true });
  return { ok: true, source: sourcePath, dest: destPath };
}

export async function listProductionObjects(prefix, { limit = 1000, offset = 0 } = {}) {
  const url = `${getProductionSupabaseUrl()}/storage/v1/object/list/${PRODUCTION_BUCKET}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders("application/json") },
    body: JSON.stringify({ prefix, limit, offset, sortBy: { column: "name", order: "asc" } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Production storage list failed (${res.status}): ${text}`);
  }
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}
