#!/usr/bin/env node
/**
 * Production reconciliation: fresh snapshot vs cc_production (when connected).
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadProductionEnv } from "./load-production-env.mjs";
import { parseCutoverArgs, defaultProductionCutoverDir } from "./parse-cutover-args.mjs";
import { reconcileSnapshot, reconcileDatabase, formatReconcileReport } from "../../src/db/reconcile.js";
import { getProductionDatabaseUrl, withProductionClient } from "../../src/db/pg.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA } from "../../src/db/schemaConfig.js";
import {
  requireProductionConfirmation,
  validateCutoverSource,
  assertActiveProductionSchema,
} from "../../src/db/safety.js";

loadProductionEnv();
requireProductionConfirmation();
setActiveSchema(PRODUCTION_SCHEMA);
assertActiveProductionSchema();

async function resolveSource(args) {
  if (args.source && args.manifest) {
    return validateCutoverSource({
      snapshotPath: args.source,
      manifestPath: args.manifest,
      cutoverRunId: args.cutoverRunId,
    });
  }
  const metaPath = `${defaultProductionCutoverDir()}/current-cutover-run.json`;
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  return validateCutoverSource({
    snapshotPath: meta.snapshotPath,
    manifestPath: meta.manifestPath,
    cutoverRunId: args.cutoverRunId || meta.cutoverRunId,
  });
}

async function main() {
  const args = parseCutoverArgs();
  const { manifest, state } = await resolveSource(args);

  let report;
  if (getProductionDatabaseUrl()) {
    console.log("Running snapshot + cc_production database reconciliation…");
    report = await withProductionClient((client) => reconcileDatabase(client, state));
  } else {
    console.log("Running snapshot-only reconciliation (no PRODUCTION_DATABASE_URL)…");
    report = reconcileSnapshot(state);
  }

  report.cutoverRunId = manifest.cutoverRunId;
  report.sha256 = manifest.sha256;

  const text = formatReconcileReport(report, { title: "PRODUCTION RECONCILIATION REPORT" });
  console.log(text);

  const outDir = join(process.cwd(), "backups/production-cutover", manifest.cutoverRunId);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `reconciliation-report-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "reconciliation-report-latest.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);

  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
