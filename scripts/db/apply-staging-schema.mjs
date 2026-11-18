#!/usr/bin/env node
/**
 * Apply cc_staging schema to STAGING database only.
 * Run: STAGING_DATABASE_URL=... node scripts/db/apply-staging-schema.mjs [--reset]
 */
import { loadStagingEnv } from "./load-staging-env.mjs";
import { withStagingClient, loadStagingSchemaSql } from "../../src/db/pg.js";
import { dropActiveSchema, applySchemaSql } from "../../src/db/strictMigrate.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { STAGING_SCHEMA } from "../../src/db/schemaConfig.js";
import { assertActiveStagingSchema } from "../../src/db/safety.js";

loadStagingEnv();
setActiveSchema(STAGING_SCHEMA);
assertActiveStagingSchema();
const reset = process.argv.includes("--reset");

async function main() {
  await withStagingClient(async (client) => {
    if (reset) {
      console.log("Dropping cc_staging schema...");
      await dropActiveSchema(client);
    }
    console.log("Applying cc_staging schema...");
    await applySchemaSql(client, loadStagingSchemaSql());
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cc_staging' ORDER BY table_name`
    );
    console.log(`Created ${rows.length} tables in cc_staging`);
    rows.forEach((r) => console.log(`  - ${r.table_name}`));
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
