/**
 * Shared row-level DB API handler — schema via setActiveSchema(); storage injected per environment.
 */
import { assembleStateFromTables } from "../../src/db/assembleState.js";
import { computeDeltaOps } from "../../src/db/deltaApply.js";
import { TABLE_INSERT_ORDER, TABLE_PRIMARY_KEY, tableFqn } from "../../src/db/tableOrder.js";
import { parseStorageObjectPath } from "./storagePath.mjs";
import { resolveDocumentStoragePath } from "./resolveDocumentStorage.mjs";
const NO_SOFT_DELETE = new Set(["contact_projects"]);
const PRODUCTION_SEED_DOC_IDS = new Set(["d1", "d2", "d3", "d4"]);

function assertProductionDocumentOp(op, mode) {
  if (mode !== "production-db" || op.table !== "documents") return;
  const row = op.row || {};
  const id = op.id || row.id;
  if (PRODUCTION_SEED_DOC_IDS.has(id)) return;

  if (op.op === "insert") {
    if (!row.storage_path) {
      throw Object.assign(
        new Error("Production: document insert blocked — storage_path required after Storage upload"),
        { code: "DOC_STORAGE_REQUIRED" }
      );
    }
    if (row.inline_data_present) {
      throw Object.assign(
        new Error("Production: document insert blocked — inline bytes are not a permanent store"),
        { code: "DOC_INLINE_BLOCKED" }
      );
    }
  }

  if (op.op === "update") {
    if ("storage_path" in row && !row.storage_path) {
      throw Object.assign(
        new Error("Production: cannot clear storage_path on document"),
        { code: "DOC_STORAGE_REQUIRED" }
      );
    }
    if (row.inline_data_present) {
      throw Object.assign(
        new Error("Production: inline_data_present is not allowed on stored documents"),
        { code: "DOC_INLINE_BLOCKED" }
      );
    }
  }
}

export function createDbHandler(pool, { mode = "db", storage = null } = {}) {
  const auditLog = [];
  let simulateOffline = false;

  if (!storage?.uploadObject || !storage?.fetchObject || !storage?.deleteObject) {
    throw new Error("createDbHandler requires storage adapter (uploadObject, fetchObject, deleteObject)");
  }

  async function loadAllTables(client) {
    const tables = {};
    for (const table of TABLE_INSERT_ORDER) {
      const where = NO_SOFT_DELETE.has(table) ? "" : " WHERE deleted_at IS NULL";
      const { rows } = await client.query(`SELECT * FROM ${tableFqn(table)}${where} ORDER BY 1`);
      tables[table] = rows;
    }
    return tables;
  }

  function recordAudit(entry) {
    auditLog.push({ ...entry, at: new Date().toISOString() });
    if (auditLog.length > 500) auditLog.shift();
  }

  async function applyOp(client, op) {
    assertProductionDocumentOp(op, mode);
    const { table } = op;
    if (op.op === "insert") {
      const cols = Object.keys(op.row).filter((c) => op.row[c] !== undefined);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${tableFqn(table)} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`;
      const { rows } = await client.query(sql, cols.map((c) => op.row[c]));
      recordAudit({ op: "insert", table, id: rows[0]?.id, sql: "INSERT", rowCount: 1 });
      return rows[0];
    }
    if (op.op === "update") {
      const pk = TABLE_PRIMARY_KEY[table]?.[0] || "id";
      const { rows: existing } = await client.query(
        `SELECT version FROM ${tableFqn(table)} WHERE ${pk} = $1 AND deleted_at IS NULL`,
        [op.id]
      );
      if (!existing.length) throw Object.assign(new Error(`Row not found: ${table}.${op.id}`), { code: "NOT_FOUND" });
      const version = op.expectedVersion ?? existing[0].version;
      const patch = { ...op.row };
      delete patch.id;
      delete patch.created_at;
      delete patch.version;
      const cols = Object.keys(patch);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
      const sql = `UPDATE ${tableFqn(table)} SET ${sets} WHERE ${pk} = $1 AND version = $${cols.length + 2} RETURNING *`;
      const vals = [op.id, ...cols.map((c) => patch[c]), version];
      const result = await client.query(sql, vals);
      if (result.rowCount === 0) {
        throw Object.assign(new Error(`Version conflict: ${table}.${op.id}`), { code: "VERSION_CONFLICT" });
      }
      recordAudit({ op: "update", table, id: op.id, sql: "UPDATE", rowCount: 1 });
      return result.rows[0];
    }
    if (op.op === "soft_delete") {
      if (table === "contact_projects") {
        const sql = `DELETE FROM ${tableFqn(table)} WHERE contact_id = $1 AND project_id = $2 RETURNING *`;
        const { rows, rowCount } = await client.query(sql, [op.contact_id, op.project_id]);
        recordAudit({ op: "delete", table, id: op.id, sql: "DELETE", rowCount });
        return rows[0];
      }
      const pk = TABLE_PRIMARY_KEY[table]?.[0] || "id";
      const sql = `UPDATE ${tableFqn(table)} SET deleted_at = now() WHERE ${pk} = $1 AND deleted_at IS NULL RETURNING *`;
      const { rows, rowCount } = await client.query(sql, [op.id]);
      recordAudit({ op: "soft_delete", table, id: op.id, sql: "SOFT_DELETE", rowCount });
      return rows[0];
    }
    throw new Error(`Unknown op: ${op.op}`);
  }

  async function applyOps(client, ops) {
    const applied = [];
    await client.query("BEGIN");
    try {
      for (const op of ops) {
        applied.push(await applyOp(client, op));
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    return applied;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  }

  async function readJsonBody(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    return JSON.parse(buf.toString());
  }

  return async function handleRequest(req, res, { urlPath = req.url } = {}) {
    const path = urlPath.split("?")[0];

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const json = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
    };

    if (simulateOffline && path !== "/api/health" && path !== "/api/simulate-offline") {
      return json(503, { ok: false, offline: true, error: `${mode} API offline (simulated)` });
    }

    try {
      if (path === "/api/health" && req.method === "GET") {
        const client = await pool.connect();
        try {
          await client.query("SELECT 1");
          return json(200, { ok: true, mode, offline: simulateOffline });
        } finally {
          client.release();
        }
      }

      if (path === "/api/state" && req.method === "GET") {
        const client = await pool.connect();
        try {
          const tables = await loadAllTables(client);
          const state = assembleStateFromTables(tables, { activeProjectId: "zfjnvrxmo8rj9ui" });
          return json(200, {
            ok: true,
            state,
            counts: {
              projects: tables.projects.length,
              pays: tables.pays.length,
              contacts: tables.contacts.length,
            },
          });
        } finally {
          client.release();
        }
      }

      if (path === "/api/delta" && req.method === "POST") {
        const body = await readJsonBody(req);
        const ops = computeDeltaOps(body.before, body.after);
        if (ops.length === 0) return json(200, { ok: true, ops: [], applied: 0 });
        const client = await pool.connect();
        try {
          const applied = await applyOps(client, ops);
          return json(200, { ok: true, ops, applied: applied.length });
        } finally {
          client.release();
        }
      }

      if (path === "/api/ops" && req.method === "POST") {
        const body = await readJsonBody(req);
        const client = await pool.connect();
        try {
          const applied = await applyOps(client, body.ops || []);
          return json(200, { ok: true, applied: applied.length, ops: body.ops });
        } finally {
          client.release();
        }
      }

      if (path === "/api/audit" && req.method === "GET") {
        const since = Number(new URL(urlPath, "http://x").searchParams.get("since") || 0);
        return json(200, { ok: true, entries: auditLog.slice(since) });
      }

      if (path === "/api/audit/clear" && req.method === "POST") {
        auditLog.length = 0;
        return json(200, { ok: true });
      }

      if (path === "/api/simulate-offline" && req.method === "POST") {
        const body = await readJsonBody(req);
        simulateOffline = !!body.offline;
        return json(200, { ok: true, offline: simulateOffline });
      }

      if (path?.startsWith("/api/row/") && req.method === "GET") {
        const parts = path.split("/");
        const table = parts[3];
        const id = parts[4];
        const client = await pool.connect();
        try {
          const pk = TABLE_PRIMARY_KEY[table]?.[0] || "id";
          const { rows } = await client.query(
            `SELECT * FROM ${tableFqn(table)} WHERE ${pk} = $1`,
            [id]
          );
          return json(200, { ok: true, row: rows[0] || null });
        } finally {
          client.release();
        }
      }

      if (path === "/api/storage/upload" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.path || !body.contentBase64) {
          return json(400, { ok: false, error: "path and contentBase64 required" });
        }
        const buffer = Buffer.from(body.contentBase64, "base64");
        await storage.uploadObject(body.path, buffer, body.contentType || "application/octet-stream", {
          upsert: body.upsert !== false,
        });
        recordAudit({ op: "storage_upload", table: "storage.objects", id: body.path, sql: "PUT", rowCount: 1 });
        return json(200, { ok: true, path: body.path, bytes: buffer.length });
      }

      if (path === "/api/storage/resolve-doc" && req.method === "POST") {
        const body = await readJsonBody(req);
        const doc = body.doc || body;
        if (!doc?.id && !doc?.storagePath) {
          return json(400, { ok: false, error: "doc.id or doc.storagePath required" });
        }
        const client = await pool.connect();
        try {
          const result = await resolveDocumentStoragePath({
            doc,
            fallbackPid: body.pid || doc.pid,
            fetchObject: (p) => storage.fetchObject(p),
            listObjects: storage.listObjects,
            dbClient: client,
          });
          if (!result.ok) {
            return json(404, {
              ok: false,
              error: "Document object not found in Storage",
              tried: result.tried,
            });
          }
          return json(200, { ok: true, path: result.path, tried: result.tried, via: result.via || "candidate" });
        } finally {
          client.release();
        }
      }

      if (path === "/api/storage/fetch" && req.method === "POST") {
        const body = await readJsonBody(req);
        let objectPath = parseStorageObjectPath(body.path);
        if (!objectPath && body.doc?.id) {
          const client = await pool.connect();
          try {
            const resolved = await resolveDocumentStoragePath({
              doc: body.doc,
              fallbackPid: body.pid || body.doc.pid,
              fetchObject: (p) => storage.fetchObject(p),
              listObjects: storage.listObjects,
              dbClient: client,
            });
            if (resolved.ok) objectPath = resolved.path;
          } finally {
            client.release();
          }
        }
        if (!objectPath) return json(400, { ok: false, error: "path required" });
        const fetched = await storage.fetchObject(objectPath);
        recordAudit({ op: "storage_fetch", table: "storage.objects", id: objectPath, sql: "POST", rowCount: 1 });
        return json(200, {
          ok: true,
          path: objectPath,
          contentType: fetched.contentType,
          contentBase64: fetched.buffer.toString("base64"),
        });
      }

      if (path === "/api/storage/delete" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.path) return json(400, { ok: false, error: "path required" });
        await storage.deleteObject(body.path);
        recordAudit({ op: "storage_delete", table: "storage.objects", id: body.path, sql: "DELETE", rowCount: 1 });
        return json(200, { ok: true, path: body.path });
      }

      if (path === "/api/storage/ensure-bucket" && req.method === "POST") {
        if (storage.ensureBucket) {
          const client = await pool.connect();
          try {
            const result = await storage.ensureBucket(client);
            return json(200, { ok: true, ...result });
          } finally {
            client.release();
          }
        }
        return json(200, { ok: true, skipped: true });
      }

      return json(404, { ok: false, error: "Not found" });
    } catch (e) {
      const status = e.code === "VERSION_CONFLICT" ? 409 : 500;
      return json(status, { ok: false, error: e.message, code: e.code || null });
    }
  };
}
