/**
 * Shared document Storage path resolution — canonical + legacy candidate keys.
 */
import { DOCUMENTS_PREFIX, documentStoragePath, sanitizeFileName } from "./cloudSync.js";

export function isLegacyInlineDoc(doc) {
  if (!doc || typeof doc !== "object") return false;
  return Boolean(doc._legacyInline || doc._dataStripped);
}

/** Ordered unique Storage object keys to try for a document record. */
export function documentStoragePathCandidates(doc, fallbackPid) {
  if (!doc || typeof doc !== "object") return [];
  const out = [];
  const push = (p) => {
    if (p && typeof p === "string" && !out.includes(p)) out.push(p);
  };

  const explicit = (doc.storagePath || "").trim();
  if (explicit) push(explicit);

  const id = doc.id;
  const name = doc.name;
  if (!id || !name) return out;

  const pid =
    doc.pid ||
    fallbackPid ||
    (Array.isArray(doc.pids) ? doc.pids[0] : null) ||
    "p1";
  const contactId = doc.contactId || doc.contact_id || "";
  const scopeId = doc.scopeId || doc.scope_id || "";
  const trimmed = String(name).trim();

  // Migrated/canonical: documents/{pid}/{docId}/{sanitizedName}
  push(documentStoragePath(pid, id, name));

  // Legacy: original filename kept in Storage (spaces, punctuation).
  push(`${DOCUMENTS_PREFIX}/${pid}/${id}/${name}`);
  if (trimmed !== name) push(`${DOCUMENTS_PREFIX}/${pid}/${id}/${trimmed}`);

  // Legacy: contact- or scope-scoped folders (pre canonical doc-id folder).
  if (contactId) {
    push(`${DOCUMENTS_PREFIX}/${pid}/${contactId}/${id}/${name}`);
    push(`${DOCUMENTS_PREFIX}/${pid}/${contactId}/${id}/${sanitizeFileName(name)}`);
    push(`${DOCUMENTS_PREFIX}/${pid}/${contactId}/${name}`);
    push(`${DOCUMENTS_PREFIX}/${pid}/${contactId}/${sanitizeFileName(name)}`);
    push(`${DOCUMENTS_PREFIX}/${contactId}/${id}/${name}`);
  }
  if (scopeId) {
    push(`${DOCUMENTS_PREFIX}/${pid}/${scopeId}/${id}/${name}`);
    push(`${DOCUMENTS_PREFIX}/${pid}/${scopeId}/${name}`);
    push(`${DOCUMENTS_PREFIX}/${scopeId}/${id}/${name}`);
  }

  // Filename-only segment differs from doc.name (e.g. UUID picker name).
  if (doc.fileName && doc.fileName !== name) {
    push(documentStoragePath(pid, id, doc.fileName));
    push(`${DOCUMENTS_PREFIX}/${pid}/${id}/${doc.fileName}`);
  }

  // Pre-project-id layout (very old).
  push(`${DOCUMENTS_PREFIX}/${id}/${name}`);
  push(`${DOCUMENTS_PREFIX}/${id}/${sanitizeFileName(name)}`);

  return out;
}

/** Pick the first candidate equal to a discovered object path (case-sensitive). */
export function matchCandidatePath(candidates, objectPath) {
  if (!objectPath) return null;
  if (candidates.includes(objectPath)) return objectPath;
  return null;
}
