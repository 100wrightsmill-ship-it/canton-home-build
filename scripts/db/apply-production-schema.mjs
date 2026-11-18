#!/usr/bin/env node
/**
 * Apply cc_production schema to PRODUCTION database only.
 * Requires I_CONFIRM_PRODUCTION_CUTOVER=yes — does NOT run without explicit flag.
 */
import { loadProductionEnv } from "./load-production-env.mjs";
import { withProductionClient, loadProductionSchemaSql } from "../../src/db/pg.js";
import { dropActiveSchema, applySchemaSql } from "../../src/db/strictMigrate.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA } from "../../src/db/schemaConfig.js";
import { requireProductionConfirmation, assertActiveProductionSchema } from "../../src/db/safety.js";

loadProductionEnv();
requireProductionConfirmation();
setActiveSchema(PRODUCTION_SCHEMA);
assertActiveProductionSchema();

const reset = process.argv.includes("--reset");
const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (dryRun) {
    console.log("[dry-run] Would apply cc_production schema");
    console.log(`  reset=${reset}`);
    return;
  }

  await withProductionClient(async (client) => {
    if (reset) {
      console.log("Dropping cc_production schema…");
      await dropActiveSchema(client);
    }
    console.log("Applying cc_production schema…");
    await applySchemaSql(client, loadProductionSchemaSql());
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [PRODUCTION_SCHEMA]
    );
    console.log(`Created ${rows.length} tables in cc_production`);
    rows.forEach((r) => console.log(`  - ${r.table_name}`));
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
