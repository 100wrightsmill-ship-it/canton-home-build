#!/usr/bin/env node
import { loadStagingEnv } from "./load-staging-env.mjs";
import { withStagingClient } from "../../src/db/pg.js";

loadStagingEnv();

async function main() {
  await withStagingClient(async (client) => {
    const { rows } = await client.query("SELECT current_database(), current_user, version()");
    console.log("Connected to staging Postgres:");
    console.log(`  database: ${rows[0].current_database}`);
    console.log(`  user: ${rows[0].current_user}`);
    console.log(`  ${rows[0].version.split(",")[0]}`);
    const schema = await client.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.schemata WHERE schema_name = 'cc_staging'`
    );
    console.log(`  cc_staging schema: ${schema.rows[0].c ? "exists" : "not yet created"}`);
  });
}

main().catch((e) => {
  console.error("Connection failed:", e.message);
  console.error("\nCreate .env.staging from .env.staging.example (see docs/staging-db-phase2.md)");
  process.exit(1);
});
