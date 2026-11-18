/**
 * Read-only resolve of a document's Storage object key (tries DB path, candidates, folder listing).
 */
import { DOCUMENTS_PREFIX } from "../../src/sync/cloudSync.js";
import { documentStoragePathCandidates } from "../../src/sync/documentPaths.js";
import { tableFqn } from "../../src/db/tableOrder.js";

function isListFolder(item) {
  return item && item.id == null && !item.metadata;
}

/** List immediate children under a Storage prefix. */
export async function listStorageChildren(listFn, prefix) {
  const items = await listFn(prefix, { limit: 1000, offset: 0 });
  return Array.isArray(items) ? items : [];
}

/** Probe fetch without throwing — returns true when object exists. */
async function objectExists(fetchFn, path) {
  try {
    await fetchFn(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an existing Storage key for a document.
 * @param {object} opts
 * @param {object} opts.doc - { id, name, pid, storagePath, fileName }
 * @param {string} [opts.fallbackPid]
 * @param {function} opts.fetchObject - throws on missing
 * @param {function} opts.listObjects - (prefix, opts) => items[]
 * @param {import('pg').PoolClient} [opts.dbClient]
 */
export async function resolveDocumentStoragePath({
  doc,
  fallbackPid,
  fetchObject,
  listObjects,
  dbClient,
}) {
  const tried = [];
  const candidates = [];

  let enrichedDoc = doc;
  if (dbClient && doc?.id) {
    const { rows } = await dbClient.query(
      `SELECT d.storage_path, d.contact_id, d.scope_id, d.inline_data_present,
              s.contact_id AS scope_contact_id
       FROM ${tableFqn("documents")} d
       LEFT JOIN ${tableFqn("scopes")} s ON s.id = d.scope_id AND s.deleted_at IS NULL
       WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [doc.id]
    );
    const row = rows[0];
    if (row) {
      if (row.storage_path) candidates.push(row.storage_path);
      enrichedDoc = {
        ...doc,
        storagePath: doc.storagePath || row.storage_path || "",
        contactId: doc.contactId || doc.contact_id || row.contact_id || row.scope_contact_id || "",
        scopeId: doc.scopeId || doc.scope_id || row.scope_id || "",
        _legacyInline: doc._legacyInline ?? Boolean(row.inline_data_present),
        _dataStripped: doc._dataStripped ?? Boolean(row.inline_data_present),
      };
    }
  }

  for (const p of documentStoragePathCandidates(enrichedDoc, fallbackPid)) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  for (const path of candidates) {
    tried.push(path);
    if (await objectExists(fetchObject, path)) {
      return { ok: true, path, tried };
    }
  }

  const pid =
    enrichedDoc?.pid ||
    fallbackPid ||
    (Array.isArray(enrichedDoc?.pids) ? enrichedDoc.pids[0] : null) ||
    "p1";
  const id = enrichedDoc?.id;
  const name = enrichedDoc?.name;

  // List documents/{pid}/{docId}/ — use sole file or name match inside folder.
  if (id && listObjects) {
    const folderPrefix = `${DOCUMENTS_PREFIX}/${pid}/${id}/`;
    const children = await listStorageChildren(listObjects, folderPrefix);
    const files = children.filter((item) => !isListFolder(item) && item.name);
    if (files.length === 1) {
      const path = `${folderPrefix}${files[0].name}`;
      tried.push(path);
      if (await objectExists(fetchObject, path)) {
        return { ok: true, path, tried, via: "doc-folder-list" };
      }
    }
    for (const item of files) {
      const path = `${folderPrefix}${item.name}`;
      if (name && (item.name === name || item.name === name.trim())) {
        tried.push(path);
        if (await objectExists(fetchObject, path)) {
          return { ok: true, path, tried, via: "doc-folder-name" };
        }
      }
    }
  }

  // Scan project document folders: documents/{pid}/{folderId}/{file}
  if (pid && name && listObjects) {
    const projectPrefix = `${DOCUMENTS_PREFIX}/${pid}/`;
    const folders = await listStorageChildren(listObjects, projectPrefix);
    for (const folder of folders) {
      if (!folder.name) continue;
      const folderPrefix = `${projectPrefix}${folder.name}/`;
      const inner = await listStorageChildren(listObjects, folderPrefix);
      for (const item of inner) {
        if (isListFolder(item) || !item.name) continue;
        if (item.name !== name && item.name !== String(name).trim()) continue;
        const path = `${folderPrefix}${item.name}`;
        tried.push(path);
        if (await objectExists(fetchObject, path)) {
          return { ok: true, path, tried, via: "project-filename-scan" };
        }
      }
    }
  }

  return { ok: false, path: null, tried };
}
