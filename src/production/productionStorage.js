import { PRODUCTION_API_BASE } from "./isProductionMode.js";

async function storageApi(path, options = {}) {
  const res = await fetch(`${PRODUCTION_API_BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

export async function productionResolveDocumentPath(doc, fallbackPid) {
  try {
    const res = await fetch(`${PRODUCTION_API_BASE}/storage/resolve-doc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc, pid: fallbackPid || doc?.pid }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.path) {
      return {
        ok: false,
        error: data.error || res.statusText || "Not found",
        tried: data.tried || [],
      };
    }
    return { ok: true, path: data.path, tried: data.tried, via: data.via };
  } catch (e) {
    return { ok: false, error: e.message, tried: [] };
  }
}

export async function productionFetchDocumentBlob(storagePath, docHint, fallbackPid) {
  try {
    const payload =
      typeof storagePath === "string" && storagePath
        ? { path: storagePath }
        : docHint && typeof docHint === "object"
          ? { doc: docHint, pid: fallbackPid || docHint.pid }
          : { path: storagePath };
    const data = await storageApi("/storage/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const binary = atob(data.contentBase64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], {
      type: data.contentType || "application/octet-stream",
    });
    return { ok: true, blob };
  } catch (e) {
    return { ok: false, blob: null, error: e.message };
  }
}

export async function productionUploadDocumentFile(storagePath, fileOrBlob, contentType) {
  try {
    const buf = await fileOrBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const contentBase64 = btoa(binary);
    const body = await storageApi("/storage/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: storagePath, contentBase64, contentType }),
    });
    return { ok: true, status: 200, path: body.path || storagePath, bytes: body.bytes ?? bytes.length, body: null };
  } catch (e) {
    return { ok: false, status: 0, path: storagePath, body: e.message || "Upload failed" };
  }
}
