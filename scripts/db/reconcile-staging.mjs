#!/usr/bin/env node
/**
 * Reconciliation report: snapshot vs acceptance criteria (+ DB if connected).
 * Run: node scripts/db/reconcile-staging.mjs [snapshot.json]
 * With DB: STAGING_DATABASE_URL=... node scripts/db/reconcile-staging.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadStagingEnv } from "./load-staging-env.mjs";
import { reconcileSnapshot, reconcileDatabase, formatReconcileReport } from "../../src/db/reconcile.js";
import { getStagingDatabaseUrl, withStagingClient } from "../../src/db/pg.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { STAGING_SCHEMA } from "../../src/db/schemaConfig.js";
import { assertActiveStagingSchema } from "../../src/db/safety.js";

loadStagingEnv();
setActiveSchema(STAGING_SCHEMA);
assertActiveStagingSchema();

const defaultSnapshot = join(
  process.cwd(),
  "backups/staging-migration-source/live-snapshot-20261004.json"
);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const snapshotPath = args[0] || defaultSnapshot;

async function main() {
  const state = JSON.parse(readFileSync(snapshotPath, "utf8"));
  let report;

  if (getStagingDatabaseUrl()) {
    console.log("Running snapshot + database reconciliation...");
    report = await withStagingClient((client) => reconcileDatabase(client, state));
  } else {
    console.log("Running snapshot-only reconciliation (no STAGING_DATABASE_URL)...");
    report = reconcileSnapshot(state);
  }

  const text = formatReconcileReport(report);
  console.log(text);

  const outDir = join(process.cwd(), "backups/staging-migration-source");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `reconciliation-report-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);

  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
