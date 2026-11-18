import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { schemaSqlPath, STAGING_SCHEMA, PRODUCTION_SCHEMA } from "./schemaConfig.js";
import {
  assertStagingDatabaseUrl,
  assertProductionDatabaseUrl,
  assertProductionPoolerUrl,
  assertStagingPoolerUrl,
} from "./safety.js";

const { Client, Pool } = pg;

/** Serverless: Supabase transaction pooler — max 1 conn, SSL, no prepared statements. */
function serverlessPoolConfig(connectionString, { vercel = false } = {}) {
  if (!vercel) return { connectionString };
  let url = connectionString;
  if (!url.includes("pgbouncer=")) {
    url += url.includes("?") ? "&pgbouncer=true" : "?pgbouncer=true";
  }
  return {
    connectionString: url,
    max: 1,
    idleTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false },
  };
}

function resolveProductionPoolUrl() {
  if (process.env.VERCEL) {
    const pooler = getProductionDatabasePoolerUrl();
    assertProductionPoolerUrl(pooler);
    return pooler;
  }
  return requireProductionUrl();
}

function resolveStagingPoolUrl() {
  if (process.env.VERCEL) {
    const pooler = getStagingDatabasePoolerUrl();
    assertStagingPoolerUrl(pooler);
    return pooler;
  }
  return requireStagingUrl();
}

export function getStagingDatabaseUrl() {
  return process.env.STAGING_DATABASE_URL || null;
}

export function getProductionDatabaseUrl() {
  return process.env.PRODUCTION_DATABASE_URL || null;
}

export function getProductionDatabasePoolerUrl() {
  return process.env.PRODUCTION_DATABASE_POOLER_URL || null;
}

export function getStagingDatabasePoolerUrl() {
  return process.env.STAGING_DATABASE_POOLER_URL || null;
}

export function requireStagingUrl() {
  const url = getStagingDatabaseUrl();
  if (!url) {
    throw new Error(
      "STAGING_DATABASE_URL is required. Set a Postgres connection string for the staging Supabase project."
    );
  }
  assertStagingDatabaseUrl(url);
  return url;
}

export function requireProductionUrl() {
  const url = getProductionDatabaseUrl();
  if (!url) {
    throw new Error(
      "PRODUCTION_DATABASE_URL is required. Set a Postgres connection string for the production Supabase project."
    );
  }
  assertProductionDatabaseUrl(url);
  return url;
}

export async function withStagingClient(fn) {
  const client = new Client({ connectionString: requireStagingUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function withProductionClient(fn) {
  const client = new Client({ connectionString: requireProductionUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function createStagingPool() {
  const vercel = Boolean(process.env.VERCEL);
  return new Pool(serverlessPoolConfig(resolveStagingPoolUrl(), { vercel }));
}

export function createProductionPool() {
  const vercel = Boolean(process.env.VERCEL);
  return new Pool(serverlessPoolConfig(resolveProductionPoolUrl(), { vercel }));
}

export function loadSchemaSql(schema) {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "../..", schemaSqlPath(schema));
  return readFileSync(path, "utf8");
}

export function loadStagingSchemaSql() {
  return loadSchemaSql(STAGING_SCHEMA);
}

export function loadProductionSchemaSql() {
  return loadSchemaSql(PRODUCTION_SCHEMA);
}
