#!/usr/bin/env node
/**
 * Production DB HTTP API — cc_production + production Storage.
 * Local dev only — requires .env.production.local with PRODUCTION_DATABASE_URL.
 */
import http from "http";
import { loadProductionEnv } from "./db/load-production-env.mjs";
import { createProductionPool, getProductionDatabaseUrl } from "../src/db/pg.js";
import { createProductionHandler } from "./production/handleRequest.mjs";
import { setActiveSchema } from "../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA } from "../src/db/schemaConfig.js";

loadProductionEnv();
setActiveSchema(PRODUCTION_SCHEMA);

const PORT = Number(process.env.PRODUCTION_API_PORT || 3336);

if (!getProductionDatabaseUrl()) {
  console.error("PRODUCTION_DATABASE_URL required in .env.production.local");
  process.exit(1);
}

const pool = createProductionPool();
const handleRequest = createProductionHandler(pool);

const server = http.createServer((req, res) => handleRequest(req, res));

server.listen(PORT, () => {
  console.log(`Production API listening on http://localhost:${PORT} (cc_production — local dev only)`);
});
