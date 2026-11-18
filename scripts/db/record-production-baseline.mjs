#!/usr/bin/env node
/**
 * Record production baseline from fresh cutover snapshot.
 */
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { loadProductionEnv } from "./load-production-env.mjs";
import { parseCutoverArgs } from "./parse-cutover-args.mjs";
import {
  requireProductionConfirmation,
  validateCutoverSource,
} from "../../src/db/safety.js";
import { recordProductionBaseline } from "../../src/db/baseline.js";

loadProductionEnv();
requireProductionConfirmation();

async function main() {
  const args = parseCutoverArgs();
  if (!args.source || !args.manifest) {
    throw new Error("Usage: --source <snapshot.json> --manifest <manifest.json> [--cutover-run-id ID]");
  }

  const { manifest, state } = validateCutoverSource({
    snapshotPath: args.source,
    manifestPath: args.manifest,
    cutoverRunId: args.cutoverRunId,
  });

  const baseline = recordProductionBaseline(state, {
    cutoverRunId: manifest.cutoverRunId,
    snapshotPath: args.source,
    manifestPath: args.manifest,
    sha256: manifest.sha256,
  });

  const outDir = join(process.cwd(), "backups/production-cutover", manifest.cutoverRunId);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "production-baseline.json");
  writeFileSync(outPath, JSON.stringify(baseline, null, 2));

  console.log(`Baseline recorded: ${outPath}`);
  console.log(`Projects: ${baseline.counts.projects}, Pays: ${baseline.counts.pays}, Contacts: ${baseline.counts.contacts}`);
  console.log(`Jordan contract: $${baseline.financials.jordanContract}, expenses: $${baseline.financials.jordanExpenses}`);
  console.log(`Snapshot self-check: ${baseline.snapshotPassed ? "PASS" : "FAIL"}`);

  if (!baseline.snapshotPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
