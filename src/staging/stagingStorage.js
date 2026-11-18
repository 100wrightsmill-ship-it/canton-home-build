/**
 * STAGING document Storage — proxied via staging API (never production Supabase).
 */
import { STAGING_API_BASE } from "./isStagingMode.js";

async function apiJson(path, options = {}) {
  const res = await fetch(`${STAGING_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function stagingUploadDocumentFile(storagePath, fileOrBlob, contentType) {
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const contentBase64 = btoa(binary);
  const body = await apiJson("/api/storage/upload", {
    method: "POST",
    body: JSON.stringify({
      path: storagePath,
      contentBase64,
      contentType: contentType || blob.type || "application/octet-stream",
      upsert: true,
    }),
  });
  return { ok: true, status: 200, path: body.path, body: null };
}

export async function stagingFetchDocumentBlob(storagePath) {
  try {
    const body = await apiJson("/api/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    const binary = atob(body.contentBase64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: body.contentType || "application/octet-stream" });
    return { ok: true, blob };
  } catch (e) {
    return { ok: false, blob: null, error: e.message, status: e.status };
  }
}

export async function stagingDeleteDocumentFile(storagePath) {
  await apiJson("/api/storage/delete", {
    method: "POST",
    body: JSON.stringify({ path: storagePath }),
  });
  return { ok: true };
}
