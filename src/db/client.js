/**
 * Row-level staging database client.
 * Phase 2: online reads/writes against cc_staging only.
 * Offline mode: read-only cache — no pending-operation replay.
 */

import { tableFqn, getActiveSchema } from "./tableOrder.js";
import { createStagingPool, getStagingDatabaseUrl } from "./pg.js";

const READ_TABLES = [
  "projects",
  "contacts",
  "scopes",
  "scope_stages",
  "payment_schedules",
  "pays",
  "phases",
  "documents",
  "project_change_orders",
];

export class StagingDbClient {
  constructor(options = {}) {
    this.schema = getActiveSchema();
    this.pool = options.pool ?? null;
    this.offline = options.offline ?? false;
    this.cache = options.initialCache ?? null;
    this.mode = getStagingDatabaseUrl() ? "staging-db" : "offline-readonly";
  }

  static isConfigured() {
    return Boolean(getStagingDatabaseUrl());
  }

  async connect() {
    if (!this.pool && !this.offline) {
      this.pool = createStagingPool();
    }
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  assertOnlineWrite() {
    if (this.offline || !getStagingDatabaseUrl()) {
      throw new Error("Offline read-only mode — writes are disabled until online row-level persistence is stable.");
    }
  }

  /** Load full read snapshot into memory for offline read-only use. */
  async hydrateCache() {
    await this.connect();
    const cache = {};
    for (const table of READ_TABLES) {
      const { rows } = await this.pool.query(`SELECT * FROM ${tableFqn(table)} WHERE deleted_at IS NULL ORDER BY id`);
      cache[table] = rows;
    }
    this.cache = cache;
    return cache;
  }

  async getProjects() {
    if (this.cache) return this.cache.projects ?? [];
    await this.connect();
    const { rows } = await this.pool.query(`SELECT * FROM ${tableFqn("projects")} WHERE deleted_at IS NULL ORDER BY name`);
    return rows;
  }

  async getPays(projectId) {
    if (this.cache) {
      const all = this.cache.pays ?? [];
      return projectId ? all.filter((p) => p.project_id === projectId) : all;
    }
    await this.connect();
    const sql = projectId
      ? `SELECT * FROM ${tableFqn("pays")} WHERE deleted_at IS NULL AND project_id = $1 ORDER BY pay_date DESC`
      : `SELECT * FROM ${tableFqn("pays")} WHERE deleted_at IS NULL ORDER BY pay_date DESC`;
    const { rows } = await this.pool.query(sql, projectId ? [projectId] : []);
    return rows;
  }

  async getContacts() {
    if (this.cache) return this.cache.contacts ?? [];
    await this.connect();
    const { rows } = await this.pool.query(`SELECT * FROM ${tableFqn("contacts")} WHERE deleted_at IS NULL ORDER BY name`);
    return rows;
  }

  async getScopes(contactId) {
    if (this.cache) {
      const all = this.cache.scopes ?? [];
      return contactId ? all.filter((s) => s.contact_id === contactId) : all;
    }
    await this.connect();
    const sql = contactId
      ? `SELECT * FROM ${tableFqn("scopes")} WHERE deleted_at IS NULL AND contact_id = $1`
      : `SELECT * FROM ${tableFqn("scopes")} WHERE deleted_at IS NULL`;
    const { rows } = await this.pool.query(sql, contactId ? [contactId] : []);
    return rows;
  }

  /** Optimistic row update with version check — staging only. */
  async updateRow(table, id, patch) {
    this.assertOnlineWrite();
    await this.connect();
    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    const expectedVersion = patch.version;
    if (expectedVersion == null) throw new Error("patch.version required for optimistic update");
    const values = [id, ...cols.map((c) => patch[c])];
    const sql = `UPDATE ${tableFqn(table)} SET ${sets} WHERE id = $1 AND version = $${cols.length + 2} RETURNING *`;
    values.push(expectedVersion);
    const { rows, rowCount } = await this.pool.query(sql, values);
    if (rowCount === 0) {
      const err = new Error("Version conflict or row not found");
      err.code = "VERSION_CONFLICT";
      throw err;
    }
    return rows[0];
  }

  createOfflineReadOnlyClient(cache) {
    return new StagingDbClient({ offline: true, initialCache: cache, pool: null });
  }
}
