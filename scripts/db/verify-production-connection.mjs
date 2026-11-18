#!/usr/bin/env node
/**
 * Read-only verify: production Postgres connection + project ref check.
 * Does NOT create schema, migrate, or modify any data.
 */
import { loadProductionEnv } from "./load-production-env.mjs";
import { withProductionClient, getProductionDatabaseUrl } from "../../src/db/pg.js";
import {
  assertProductionDatabaseUrl,
  extractProjectRefFromDatabaseUrl,
} from "../../src/db/safety.js";
import { PRODUCTION_PROJECT_REF, PRODUCTION_SCHEMA } from "../../src/db/schemaConfig.js";

loadProductionEnv();

const url = getProductionDatabaseUrl();
if (!url) {
  console.error("PRODUCTION_DATABASE_URL is not set in .env.production.local");
  process.exit(1);
}

try {
  assertProductionDatabaseUrl(url);
} catch (e) {
  console.error("Project ref check failed:", e.message);
  process.exit(1);
}

const ref = extractProjectRefFromDatabaseUrl(url);
if (ref !== PRODUCTION_PROJECT_REF) {
  console.error(`Wrong project ref: expected ${PRODUCTION_PROJECT_REF}, got ${ref}`);
  process.exit(1);
}

async function main() {
  await withProductionClient(async (client) => {
    const { rows } = await client.query(
      "SELECT current_database(), current_user, version()"
    );
    console.log("Connected to production Postgres (read-only check):");
    console.log(`  project ref: ${PRODUCTION_PROJECT_REF}`);
    console.log(`  database: ${rows[0].current_database}`);
    console.log(`  user: ${rows[0].current_user}`);
    console.log(`  ${rows[0].version.split(",")[0]}`);

    const stagingLeak = await client.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.schemata WHERE schema_name = 'cc_staging'`
    );
    if (stagingLeak.rows[0].c > 0) {
      console.error("  ✗ cc_staging schema found on production — unexpected");
      process.exit(1);
    }

    const prodSchema = await client.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.schemata WHERE schema_name = $1`,
      [PRODUCTION_SCHEMA]
    );
    console.log(
      `  ${PRODUCTION_SCHEMA} schema: ${prodSchema.rows[0].c ? "exists" : "not yet created"}`
    );
    console.log("  ✓ Correct production project confirmed");
  });
}

main().catch((e) => {
  console.error("Connection failed:", e.message);
  console.error("\nCheck .env.production.local (see .env.production.local.example)");
  process.exit(1);
});
