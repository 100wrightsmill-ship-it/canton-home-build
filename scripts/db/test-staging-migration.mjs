#!/usr/bin/env node
/**
 * Unit tests for extraction + snapshot reconciliation (no DB required).
 * Run: node scripts/db/test-staging-migration.mjs
 */
import { readFileSync } from "fs";
import { join } from "path";
import { extractRowsFromState } from "../../src/db/extractRows.js";
import { reconcileSnapshot } from "../../src/db/reconcile.js";
import { rowsEquivalent } from "../../src/db/strictMigrate.js";
import { toMoney, moneyEqual } from "../../src/db/money.js";

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

const snapshotPath = join(
  process.cwd(),
  "backups/staging-migration-source/live-snapshot-20261004.json"
);
const state = JSON.parse(readFileSync(snapshotPath, "utf8"));

console.log("money helpers");
{
  assert(toMoney(67575) === "67575.00", "toMoney integer");
  assert(toMoney(9450.5) === "9450.50", "toMoney decimal");
  assert(moneyEqual(100.1, "100.10"), "moneyEqual string");
  assert(toMoney(null) === null, "null money");
}

console.log("extractRowsFromState");
{
  const { tables } = extractRowsFromState(state);
  assert(tables.projects.length === 3, "3 projects");
  assert(tables.pays.length === 81, "81 pays");
  assert(tables.contacts.length === 19, "19 contacts");
  assert(tables.scopes.length === 24, "24 scopes");
  assert(tables.scope_stages.length === 60, "60 stages");
  assert(tables.payment_schedules.length === 29, "29 payment schedules");
  assert(tables.documents.length === 16, "16 documents (11 contact + 5 project)");
  const elder = tables.contacts.find((c) => c.id === "w1fmbromutbxlxb");
  assert(Boolean(elder), "Elder contact extracted");
  const elderScope = tables.scopes.find((s) => s.id === "u4pihffmutc0o1x");
  assert(elderScope?.price === "1500.00", "Elder scope $1500 as NUMERIC string");
}

console.log("rowsEquivalent / strict migrate semantics");
{
  const row = { id: "x", amount: "100.00", name: "Test" };
  const dbRow = { id: "x", amount: "100.00", name: "Test", version: 1, created_at: new Date() };
  assert(rowsEquivalent(row, dbRow, "test").ok, "ignores version/timestamps");
  assert(!rowsEquivalent({ ...row, amount: "99.00" }, dbRow, "test").ok, "detects amount mismatch");
}

console.log("reconcileSnapshot acceptance criteria");
{
  const report = reconcileSnapshot(state);
  assert(report.passed, "full snapshot reconciliation passes");
  assert(report.financials.jordanContract === "67575.00", "Jordan contract $67,575");
  assert(report.financials.jordanExpenses === "40393.00", "Jordan expenses $40,393");
  assert(report.financials.cantonExpenses === "134937.00", "Canton expenses $134,937");
  assert(report.financials.cabinetsCo === "9450.00", "Cabinets CO $9,450");
  assert(report.financials.jordanElectrical === "49000.00", "Jordan Electrical $49,000");
  assert(report.financials.elderScope === "1500.00", "Elder scope $1,500");
  assert(report.duplicateIds.length === 0, "zero duplicate IDs");
  assert(report.orphans.length === 0, "zero orphan relationships");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
