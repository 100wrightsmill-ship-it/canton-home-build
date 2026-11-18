#!/usr/bin/env node
/**
 * Migrate fresh cutover snapshot into empty cc_production — strict insert only.
 * Requires I_CONFIRM_PRODUCTION_CUTOVER=yes + validated cutover manifest.
 */
import { readFileSync } from "fs";
import { loadProductionEnv } from "./load-production-env.mjs";
import { parseCutoverArgs, defaultProductionCutoverDir } from "./parse-cutover-args.mjs";
import { extractRowsFromState } from "../../src/db/extractRows.js";
import { withProductionClient, loadProductionSchemaSql } from "../../src/db/pg.js";
import { migrateTablesStrict, dropActiveSchema, applySchemaSql } from "../../src/db/strictMigrate.js";
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

async function resolveCutoverSource(args) {
  if (args.source && args.manifest) {
    return validateCutoverSource({
      snapshotPath: args.source,
      manifestPath: args.manifest,
      cutoverRunId: args.cutoverRunId,
    });
  }

  const metaPath = `${defaultProductionCutoverDir()}/current-cutover-run.json`;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return validateCutoverSource({
      snapshotPath: meta.snapshotPath,
      manifestPath: meta.manifestPath,
      cutoverRunId: args.cutoverRunId || meta.cutoverRunId,
    });
  } catch {
    throw new Error(
      "Cutover source required. Run fetch-production-source first, or pass --source and --manifest."
    );
  }
}

async function main() {
  const args = parseCutoverArgs();
  if (args.dryRun) {
    console.log("[dry-run] Would migrate fresh cutover snapshot into cc_production");
    return;
  }

  const { manifest, state } = await resolveCutoverSource(args);
  const { tables, meta } = extractRowsFromState(state);

  console.log(`Source: ${manifest.snapshotPath}`);
  console.log(`Cutover run: ${manifest.cutoverRunId}`);
  console.log(`SHA256: ${manifest.sha256}`);
  console.log(
    `Extracted: ${tables.projects.length} projects, ${tables.pays.length} pays, ${tables.contacts.length} contacts`
  );
  console.log(`cloudRevision=${meta.cloudRevision}`);

  await withProductionClient(async (client) => {
    if (args.reset) {
      console.log("Reset: dropping and recreating cc_production…");
      await dropActiveSchema(client);
      await applySchemaSql(client, loadProductionSchemaSql());
    }
    const stats = await migrateTablesStrict(client, tables);
    console.log(`Migration complete: inserted=${stats.inserted}, verified=${stats.verified}`);
    for (const [table, s] of Object.entries(stats.byTable)) {
      if (s.total > 0) console.log(`  ${table}: ${s.inserted} inserted, ${s.verified} verified (${s.total} total)`);
    }
  });
}

main().catch((e) => {
  if (e.code === "RECONCILIATION_MISMATCH") {
    console.error("RECONCILIATION ERROR — migration stopped:");
    console.error(JSON.stringify(e.details, null, 2));
  } else {
    console.error(e.message || e);
  }
  process.exit(1);
});
