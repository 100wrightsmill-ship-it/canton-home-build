#!/usr/bin/env node
/**
 * Migrate live snapshot into empty cc_staging — strict insert, no silent overwrite.
 * Run: STAGING_DATABASE_URL=... node scripts/db/run-staging-migration.mjs [snapshot.json]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { loadStagingEnv } from "./load-staging-env.mjs";
import { extractRowsFromState } from "../../src/db/extractRows.js";
import { withStagingClient, loadStagingSchemaSql } from "../../src/db/pg.js";
import { migrateTablesStrict, dropActiveSchema, applySchemaSql } from "../../src/db/strictMigrate.js";
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
const reset = process.argv.includes("--reset");

async function main() {
  const raw = readFileSync(snapshotPath, "utf8");
  const state = JSON.parse(raw);
  const { tables, meta } = extractRowsFromState(state);

  console.log(`Source: ${snapshotPath}`);
  console.log(`cloudRevision=${meta.cloudRevision}, cp=${meta.activeProjectId}`);
  console.log(
    `Extracted: ${tables.projects.length} projects, ${tables.pays.length} pays, ${tables.contacts.length} contacts`
  );

  await withStagingClient(async (client) => {
    if (reset) {
      console.log("Reset: dropping and recreating cc_staging...");
      await dropActiveSchema(client);
      await applySchemaSql(client, loadStagingSchemaSql());
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
