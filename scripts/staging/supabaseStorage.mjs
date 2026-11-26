/**
 * STAGING Supabase Storage only — never production bucket.
 */
import { loadStagingEnv } from "../db/load-staging-env.mjs";
import { resolveStagingSupabaseSecret } from "../../src/db/supabaseKeys.js";

loadStagingEnv();

export const STAGING_BUCKET = "cc-data";

export function getStagingSupabaseUrl() {
  if (process.env.STAGING_SUPABASE_URL) return process.env.STAGING_SUPABASE_URL.replace(/\/$/, "");
  const db = process.env.STAGING_DATABASE_URL || "";
  const m = db.match(/@db\.([^.]+)\.supabase/);
  if (m) return `https://${m[1]}.supabase.co`;
  throw new Error("Set STAGING_SUPABASE_URL or STAGING_DATABASE_URL with Supabase host");
}

export function getStagingServiceRoleKey() {
  const key = resolveStagingSupabaseSecret();
  if (!key) {
    throw new Error(
      "STAGING_SUPABASE_SECRET_KEY (sb_secret) or STAGING_SUPABASE_SERVICE_ROLE_KEY required in .env.staging"
    );
  }
  return key;
}

function authHeaders(contentType) {
  const key = getStagingServiceRoleKey();
  const h = {
    Authorization: `Bearer ${key}`,
    apikey: key,
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

export function stagingStorageObjectUrl(objectPath) {
  const base = getStagingSupabaseUrl();
  return `${base}/storage/v1/object/${STAGING_BUCKET}/${objectPath}`;
}

export async function ensureStagingBucket(client) {
  const { rows } = await client.query(
    `SELECT id FROM storage.buckets WHERE id = $1`,
    [STAGING_BUCKET]
  );
  if (rows.length) return { created: false, id: STAGING_BUCKET };
  await client.query(
    `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
     VALUES ($1, $1, false, null, null)`,
    [STAGING_BUCKET]
  );
  return { created: true, id: STAGING_BUCKET };
}

export async function uploadStagingObject(objectPath, body, contentType, { upsert = true } = {}) {
  const url = stagingStorageObjectUrl(objectPath);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      ...authHeaders(contentType || "application/octet-stream"),
      ...(upsert ? { "x-upsert": "true" } : {}),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Staging storage upload failed (${res.status}): ${text}`), {
      status: res.status,
    });
  }
  return { ok: true, path: objectPath };
}

export async function fetchStagingObject(objectPath) {
  const url = stagingStorageObjectUrl(objectPath);
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Staging storage fetch failed (${res.status}): ${text}`), {
      status: res.status,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, buffer: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

export async function deleteStagingObject(objectPath) {
  const base = getStagingSupabaseUrl();
  const url = `${base}/storage/v1/object/${STAGING_BUCKET}/${objectPath}`;
  const res = await fetch(url, { method: "DELETE", headers: authHeaders() });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Staging storage delete failed (${res.status}): ${text}`), {
      status: res.status,
    });
  }
  return { ok: true, path: objectPath };
}
