import {
  COMPARE_OMIT,
  TABLE_INSERT_ORDER,
  TABLE_PRIMARY_KEY,
  tableFqn,
  getActiveSchema,
} from "./tableOrder.js";

function normalizeDbValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v.constructor?.name === "Decimal") return String(v);
  return v;
}

export function rowsEquivalent(expected, actual, table) {
  const keys = Object.keys(expected).filter((k) => !COMPARE_OMIT.has(k));
  const diffs = [];
  for (const k of keys) {
    const e = normalizeDbValue(expected[k]);
    const a = normalizeDbValue(actual[k]);
    if (e === a) continue;
    if (String(e) === String(a)) continue;
    diffs.push({ field: k, expected: e, actual: a });
  }
  if (diffs.length) {
    return { ok: false, table, diffs };
  }
  return { ok: true };
}

export async function assertSchemaEmpty(client) {
  const violations = [];
  for (const table of TABLE_INSERT_ORDER) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${tableFqn(table)}`);
    const count = rows[0]?.c ?? 0;
    if (count > 0) violations.push({ table, count });
  }
  if (violations.length) {
    const msg = violations.map((v) => `${v.table}=${v.count}`).join(", ");
    throw new Error(`Migration target not empty — STOP: ${msg}`);
  }
}

function pkWhere(table, row) {
  const pk = TABLE_PRIMARY_KEY[table] ?? ["id"];
  const cols = pk.map((c) => `${c} = $${pk.indexOf(c) + 1}`).join(" AND ");
  const vals = pk.map((c) => row[c]);
  return { sql: cols, vals, pk };
}

export async function strictInsertRow(client, table, row) {
  const pk = TABLE_PRIMARY_KEY[table] ?? ["id"];
  const { sql: whereSql, vals: whereVals } = pkWhere(table, row);
  const existing = await client.query(`SELECT * FROM ${tableFqn(table)} WHERE ${whereSql}`, whereVals);
  if (existing.rows.length === 0) {
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => row[c]);
    await client.query(
      `INSERT INTO ${tableFqn(table)} (${cols.join(", ")}) VALUES (${placeholders})`,
      values
    );
    return { action: "inserted", id: pk.length === 1 ? row[pk[0]] : whereVals.join(":") };
  }
  if (existing.rows.length > 1) {
    throw new Error(`Unexpected duplicate rows in ${table} for PK ${whereVals.join(":")}`);
  }
  const cmp = rowsEquivalent(row, existing.rows[0], table);
  if (!cmp.ok) {
    const err = new Error(`Reconciliation error: ${table} PK exists with mismatched fields`);
    err.code = "RECONCILIATION_MISMATCH";
    err.details = cmp;
    throw err;
  }
  return { action: "verified", id: pk.length === 1 ? row[pk[0]] : whereVals.join(":") };
}

export async function migrateTablesStrict(client, tables) {
  const stats = { inserted: 0, verified: 0, byTable: {} };
  await client.query("BEGIN");
  try {
    await assertSchemaEmpty(client);
    for (const table of TABLE_INSERT_ORDER) {
      const rows = tables[table] ?? [];
      stats.byTable[table] = { inserted: 0, verified: 0, total: rows.length };
      for (const row of rows) {
        const result = await strictInsertRow(client, table, row);
        if (result.action === "inserted") {
          stats.inserted += 1;
          stats.byTable[table].inserted += 1;
        } else {
          stats.verified += 1;
          stats.byTable[table].verified += 1;
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  return stats;
}

export async function dropSchema(client, schema) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

export async function dropActiveSchema(client) {
  await dropSchema(client, getActiveSchema());
}

/** @deprecated use dropActiveSchema */
export async function dropStagingSchema(client) {
  await dropActiveSchema(client);
}

export async function applySchemaSql(client, sqlText) {
  await client.query(sqlText);
}

/** @deprecated use applySchemaSql */
export async function applyStagingSchemaSql(client, sqlText) {
  await applySchemaSql(client, sqlText);
}
