#!/usr/bin/env node
/**
 * Read-only fetch of LIVE production state.json for cutover migration.
 * Does NOT modify production state.json.
 *
 * Requires: I_CONFIRM_PRODUCTION_CUTOVER=yes + production Supabase credentials.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { loadProductionEnv } from "./load-production-env.mjs";
import {
  requireProductionConfirmation,
  assertProductionSupabaseUrl,
  buildCutoverManifest,
} from "../../src/db/safety.js";
import { PRODUCTION_SUPABASE_URL } from "../../src/db/schemaConfig.js";
import { BUCKET, STATE_PATH } from "../../src/sync/cloudSync.js";

loadProductionEnv();
requireProductionConfirmation();

const SUPABASE_URL = (process.env.PRODUCTION_SUPABASE_URL || PRODUCTION_SUPABASE_URL).replace(/\/$/, "");
assertProductionSupabaseUrl(SUPABASE_URL);

function authHeaders() {
  const key =
    process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Set PRODUCTION_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function fetchStateJson() {
  const authedUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${STATE_PATH}`;
  const res = await fetch(authedUrl, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

async function main() {
  const cutoverRunId = process.env.CUTOVER_RUN_ID || randomUUID();
  const dir = join(process.cwd(), "backups/production-cutover-source");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const base = join(dir, `live-snapshot-${stamp}`);
  const snapshotPath = `${base}.json`;
  const manifestPath = `${base}.manifest.json`;

  console.log("Read-only GET production state.json…");
  const state = await fetchStateJson();

  writeFileSync(snapshotPath, JSON.stringify(state, null, 2));
  const manifest = buildCutoverManifest({
    snapshotPath,
    state,
    cutoverRunId,
    fetchedAt: new Date().toISOString(),
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const runMetaPath = join(dir, "current-cutover-run.json");
  writeFileSync(
    runMetaPath,
    JSON.stringify(
      {
        cutoverRunId,
        snapshotPath: resolve(snapshotPath),
        manifestPath: resolve(manifestPath),
        recordedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`Saved ${snapshotPath}`);
  console.log(`Manifest ${manifestPath}`);
  console.log(`Cutover run ID: ${cutoverRunId}`);
  console.log(
    `Projects: ${state.projs?.length}, Pays: ${state.pays?.length}, Contacts: ${state.contacts?.length}`
  );
  console.log(`SHA256: ${manifest.sha256}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
