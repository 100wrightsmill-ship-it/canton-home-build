#!/usr/bin/env node
/**
 * Read-only fetch of LIVE production state.json for staging migration.
 * Does NOT modify production state.json.
 *
 * Requires: SUPABASE_URL, SUPABASE_ANON_KEY (or service role) in env.
 * Run: node scripts/db/fetch-migration-source.mjs
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://bdckzzweimrmvcvvahbr.supabase.co";
const BUCKET = "cc-data";
const STATE_PATH = "state.json";

function authHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!key) throw new Error("Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function main() {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${STATE_PATH}`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) {
    const authedUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${STATE_PATH}`;
    const res2 = await fetch(authedUrl, { headers: authHeaders(), cache: "no-store" });
    if (!res2.ok) throw new Error(`Fetch failed: ${res.status} / ${res2.status}`);
    var state = await res2.json();
  } else {
    var state = await res.json();
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 8);
  const dir = join(process.cwd(), "backups/staging-migration-source");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `live-snapshot-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(state, null, 2));
  writeFileSync(
    `${base}.manifest.json`,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        source: `${BUCKET}/${STATE_PATH} (production read-only GET)`,
        cloudRevision: state.cloudRevision ?? null,
        savedAt: state.savedAt ?? null,
        purpose: "staging migration source of truth — not July baseline",
      },
      null,
      2
    )
  );
  console.log(`Saved ${base}.json`);
  console.log(`Projects: ${state.projs?.length}, Pays: ${state.pays?.length}, Contacts: ${state.contacts?.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
