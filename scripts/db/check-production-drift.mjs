#!/usr/bin/env node
/**
 * READ-ONLY pre-Gate-2 drift check: live state.json vs Gate 1 cutover snapshot.
 * No writes to production state.json or cc_production.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadProductionEnv } from "./load-production-env.mjs";
import { snapshotSha256 } from "../../src/db/safety.js";
import { extractRowsFromState } from "../../src/db/extractRows.js";
import { reconcileSnapshot, reconcileDatabase, formatReconcileReport } from "../../src/db/reconcile.js";
import { assertDeployGatePassed } from "../../src/db/safety.js";
import { withProductionClient } from "../../src/db/pg.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA } from "../../src/db/schemaConfig.js";
import { PRODUCTION_SUPABASE_URL } from "../../src/db/schemaConfig.js";
import { BUCKET, STATE_PATH } from "../../src/sync/cloudSync.js";

const GATE1_SHA256 = "d77974664229a0967ea9d035cd66f48cc59e3ec2283a1f6088f5f91c60759968";
const GATE1_SNAPSHOT = join(
  process.cwd(),
  "backups/production-cutover-source/live-snapshot-20261004061326.json"
);
const CUTOVER_RUN_ID = "7625f22b-b0d7-4a6c-902d-952656115418";

loadProductionEnv();

function authHeaders() {
  const key =
    process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing service role key for read-only fetch");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function fetchLiveState() {
  const url = `${(process.env.PRODUCTION_SUPABASE_URL || PRODUCTION_SUPABASE_URL).replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${STATE_PATH}`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Live fetch failed: ${res.status}`);
  return res.json();
}

function canonicalJson(state) {
  return JSON.stringify(state, null, 2);
}

function semanticDiff(gate1, live) {
  const diffs = [];
  const g1 = extractRowsFromState(gate1);
  const liveEx = extractRowsFromState(live);
  const g1rep = reconcileSnapshot(gate1);
  const liveRep = reconcileSnapshot(live);

  for (const [k, v] of Object.entries(g1rep.counts)) {
    const lv = liveRep.counts[k];
    if (v !== lv) diffs.push({ kind: "count", entity: k, gate1: v, live: lv });
  }

  for (const [k, v] of Object.entries(g1rep.financials)) {
    const lv = liveRep.financials[k];
    if (v !== lv) diffs.push({ kind: "financial", metric: k, gate1: v, live: lv });
  }

  for (const [table, rows] of Object.entries(g1.tables)) {
    const liveRows = liveEx.tables[table] ?? [];
    if (rows.length !== liveRows.length) {
      diffs.push({ kind: "table_rows", table, gate1: rows.length, live: liveRows.length });
      continue;
    }
    const gIds = new Set(rows.map((r) => r.id ?? `${r.contact_id}:${r.project_id}`));
    const lIds = new Set(liveRows.map((r) => r.id ?? `${r.contact_id}:${r.project_id}`));
    for (const id of gIds) {
      if (!lIds.has(id)) diffs.push({ kind: "missing_in_live", table, id });
    }
    for (const id of lIds) {
      if (!gIds.has(id)) diffs.push({ kind: "added_in_live", table, id });
    }
  }

  if (gate1.cloudRevision !== live.cloudRevision) {
    diffs.push({
      kind: "metadata",
      field: "cloudRevision",
      gate1: gate1.cloudRevision,
      live: live.cloudRevision,
    });
  }
  if (gate1.savedAt !== live.savedAt) {
    diffs.push({ kind: "metadata", field: "savedAt", gate1: gate1.savedAt, live: live.savedAt });
  }

  return { diffs, g1rep, liveRep };
}

async function main() {
  console.log("=== PRE-GATE-2 DRIFT CHECK (read-only) ===\n");

  const gate1Raw = readFileSync(GATE1_SNAPSHOT, "utf8");
  const gate1State = JSON.parse(gate1Raw);
  const gate1Hash = snapshotSha256(gate1Raw);

  console.log("Gate 1 snapshot:");
  console.log(`  path: ${GATE1_SNAPSHOT}`);
  console.log(`  SHA256: ${gate1Hash}`);
  console.log(`  cloudRevision: ${gate1State.cloudRevision}`);
  console.log(`  savedAt: ${gate1State.savedAt}`);

  console.log("\nFetching live production state.json (read-only)…");
  const liveState = await fetchLiveState();
  const liveCanonical = canonicalJson(liveState);
  const liveHash = snapshotSha256(liveCanonical);
  const liveHashRaw = snapshotSha256(JSON.stringify(liveState));

  console.log("\nLive state.json:");
  console.log(`  SHA256 (canonical pretty): ${liveHash}`);
  console.log(`  SHA256 (compact JSON): ${liveHashRaw}`);
  console.log(`  cloudRevision: ${liveState.cloudRevision}`);
  console.log(`  savedAt: ${liveState.savedAt}`);

  const hashMatchFile = gate1Hash === gate1Hash && gate1Hash === GATE1_SHA256;
  const hashMatchLive = gate1Hash === liveHash || gate1Raw === liveCanonical;

  console.log("\n--- Hash comparison ---");
  console.log(`  Gate 1 manifest SHA256 matches file: ${gate1Hash === GATE1_SHA256 ? "YES" : "NO"}`);
  console.log(`  Live vs Gate 1 (byte-identical pretty JSON): ${gate1Raw === liveCanonical ? "YES" : "NO"}`);
  console.log(`  Live SHA256 vs Gate 1: ${gate1Hash === liveHash ? "MATCH" : "DIFFER"}`);

  const { diffs, g1rep, liveRep } = semanticDiff(gate1State, liveState);

  console.log("\n--- Semantic comparison ---");
  if (diffs.length === 0) {
    console.log("  Zero data drift detected across all persisted entities.");
  } else {
    console.log(`  ${diffs.length} difference(s) found:`);
    for (const d of diffs) {
      console.log(`  - ${JSON.stringify(d)}`);
    }
  }

  const outDir = join(process.cwd(), "backups/production-cutover", CUTOVER_RUN_ID);
  mkdirSync(outDir, { recursive: true });
  const report = {
    checkedAt: new Date().toISOString(),
    purpose: "pre-gate-2-drift-check",
    gate1Sha256: gate1Hash,
    liveSha256Canonical: liveHash,
    liveSha256Compact: liveHashRaw,
    hashIdentical: gate1Raw === liveCanonical,
    semanticDrift: diffs,
    driftDetected: diffs.length > 0 || gate1Hash !== liveHash,
  };

  if (diffs.length > 0 || (gate1Hash !== liveHash && gate1Raw !== liveCanonical)) {
    writeFileSync(join(outDir, "drift-report.json"), JSON.stringify(report, null, 2));
    console.log("\n=== STOP: Production state.json has drifted since Gate 1 ===");
    console.log("Do NOT deploy DB mode.");
    console.log(`Drift report: ${join(outDir, "drift-report.json")}`);
    process.exit(1);
  }

  console.log("\n--- Live reconciliation vs cc_production ---");
  setActiveSchema(PRODUCTION_SCHEMA);
  const reconcileReport = await withProductionClient((client) =>
    reconcileDatabase(client, liveState)
  );
  reconcileReport.cutoverRunId = CUTOVER_RUN_ID;
  reconcileReport.driftCheckAt = report.checkedAt;
  reconcileReport.liveSha256 = liveHash;

  const reconcilePath = join(outDir, "reconciliation-report-live-drift-check.json");
  writeFileSync(reconcilePath, JSON.stringify(reconcileReport, null, 2));
  writeFileSync(join(outDir, "reconciliation-report-latest.json"), JSON.stringify(reconcileReport, null, 2));

  console.log(formatReconcileReport(reconcileReport, { title: "LIVE DRIFT-CHECK RECONCILIATION" }));

  if (!reconcileReport.passed) {
    console.log("\n=== STOP: Reconciliation FAILED against live state ===");
    process.exit(1);
  }

  console.log("\n--- Deploy gate ---");
  assertDeployGatePassed(reconcilePath);
  console.log("  Deploy gate: PASS");

  writeFileSync(join(outDir, "drift-report.json"), JSON.stringify({ ...report, reconciliationPassed: true }, null, 2));
  console.log("\n=== Zero drift — Gate 2 deploy gate PASS (do not deploy until explicit approval) ===");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
