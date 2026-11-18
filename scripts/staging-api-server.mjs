#!/usr/bin/env node
/**
 * Staging-only HTTP API — row-level cc_staging + STAGING Storage proxy.
 * STAGING_DATABASE_URL from .env.staging only. Never production.
 */
import http from "http";
import { loadStagingEnv } from "./db/load-staging-env.mjs";
import { createStagingPool, getStagingDatabaseUrl } from "../src/db/pg.js";
import { createStagingHandler } from "./staging/handleRequest.mjs";
import { setActiveSchema } from "../src/db/schemaContext.js";
import { STAGING_SCHEMA } from "../src/db/schemaConfig.js";

loadStagingEnv();
setActiveSchema(STAGING_SCHEMA);

const PORT = Number(process.env.STAGING_API_PORT || 3334);

if (!getStagingDatabaseUrl()) {
  console.error("STAGING_DATABASE_URL required in .env.staging");
  process.exit(1);
}

const pool = createStagingPool();
const handleRequest = createStagingHandler(pool);

const server = http.createServer((req, res) => handleRequest(req, res));

server.listen(PORT, () => {
  console.log(`Staging API listening on http://localhost:${PORT} (cc_staging + staging storage only)`);
});
