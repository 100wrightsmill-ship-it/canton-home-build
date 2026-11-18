#!/usr/bin/env node
/**
 * Ensure cc-data bucket exists on STAGING Supabase Storage.
 * Requires STAGING_DATABASE_URL + STAGING_SUPABASE_SERVICE_ROLE_KEY in .env.staging
 */
import { loadStagingEnv } from "./load-staging-env.mjs";
import { withStagingClient } from "../../src/db/pg.js";
import {
  ensureStagingBucket,
  getStagingSupabaseUrl,
  uploadStagingObject,
  fetchStagingObject,
  deleteStagingObject,
  STAGING_BUCKET,
} from "../staging/supabaseStorage.mjs";

loadStagingEnv();

async function main() {
  const url = getStagingSupabaseUrl();
  console.log(`Staging Supabase URL: ${url}`);
  console.log(`Bucket: ${STAGING_BUCKET}`);

  await withStagingClient(async (client) => {
    const result = await ensureStagingBucket(client);
    console.log(result.created ? "Created bucket cc-data" : "Bucket cc-data already exists");
  });

  const probePath = `_staging_probe/${Date.now()}.txt`;
  await uploadStagingObject(probePath, Buffer.from("staging-storage-ok"), "text/plain");
  const fetched = await fetchStagingObject(probePath);
  if (fetched.buffer.toString() !== "staging-storage-ok") {
    throw new Error("Storage probe readback mismatch");
  }
  await deleteStagingObject(probePath);
  console.log("Storage upload/fetch/delete probe: PASS");
}

main().catch((e) => {
  console.error("Setup failed:", e.message);
  process.exit(1);
});
