#!/usr/bin/env node
/**
 * Regression: legacy snapshots without version fields default to version=1 on extract.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { extractRowsFromState } from "../../src/db/extractRows.js";
import { rowVersion } from "../../src/db/transform.js";
import { VERSIONED_TABLES } from "../../src/db/versionTables.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

function stripAllVersions(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripAllVersions(item);
    return;
  }
  delete obj.version;
  for (const v of Object.values(obj)) stripAllVersions(v);
}

console.log("rowVersion helper");
{
  assert(rowVersion(undefined) === 1, "undefined → 1");
  assert(rowVersion(null) === 1, "null → 1");
  assert(rowVersion(0) === 1, "0 → 1");
  assert(rowVersion(3) === 3, "valid version preserved");
  assert(rowVersion("5") === 5, "string version preserved");
}

console.log("legacy snapshot without version fields");
{
  const snapshotPath = join(
    process.cwd(),
    "backups/staging-migration-source/live-snapshot-20261004.json"
  );
  const state = JSON.parse(readFileSync(snapshotPath, "utf8"));
  stripAllVersions(state);

  const { tables } = extractRowsFromState(state);

  for (const table of VERSIONED_TABLES) {
    const rows = tables[table] ?? [];
    if (rows.length === 0) continue;
    const bad = rows.filter((r) => r.version !== 1);
    assert(
      bad.length === 0,
      `${table}: all ${rows.length} rows have version=1 (missing legacy version)`
    );
  }

  const totalVersioned = VERSIONED_TABLES.reduce(
    (n, t) => n + (tables[t]?.length ?? 0),
    0
  );
  assert(totalVersioned > 0, `checked ${totalVersioned} versioned rows total`);
}

console.log("explicit version preserved when present");
{
  const state = {
    projs: [{ id: "p1", name: "Test", version: 7, originalContract: 0 }],
    pays: [],
    contacts: [],
    phases: [],
    tasks: [],
    docs: [],
    folders: [],
    msgs: [],
    notifs: [],
    orders: [],
  };
  const { tables } = extractRowsFromState(state);
  assert(tables.projects[0].version === 7, "existing version 7 preserved");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
