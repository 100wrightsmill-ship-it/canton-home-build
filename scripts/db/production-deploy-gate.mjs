#!/usr/bin/env node
/**
 * Gate for production DB-mode deployment — requires reconciliation PASS.
 *
 * Usage:
 *   node scripts/db/production-deploy-gate.mjs --report backups/production-cutover/{runId}/reconciliation-report-latest.json
 */
import { parseCutoverArgs, defaultProductionCutoverDir } from "./parse-cutover-args.mjs";
import { assertDeployGatePassed } from "../../src/db/safety.js";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

const args = parseCutoverArgs();
let reportPath = args.baseline;

if (process.argv.includes("--report")) {
  const i = process.argv.indexOf("--report");
  reportPath = process.argv[i + 1];
}

if (!reportPath) {
  try {
    const meta = JSON.parse(
      readFileSync(join(defaultProductionCutoverDir(), "current-cutover-run.json"), "utf8")
    );
    reportPath = join(
      process.cwd(),
      "backups/production-cutover",
      meta.cutoverRunId,
      "reconciliation-report-latest.json"
    );
  } catch {
    console.error("Usage: --report <reconciliation-report.json>");
    process.exit(1);
  }
}

if (!existsSync(reportPath)) {
  console.error(`Deploy gate blocked: report not found at ${reportPath}`);
  process.exit(1);
}

try {
  const report = assertDeployGatePassed(reportPath);
  console.log("Deploy gate PASS — reconciliation 100%");
  console.log(`  cutoverRunId: ${report.cutoverRunId || "—"}`);
  console.log(`  checks: ${(report.checks || []).length} all passed`);
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
