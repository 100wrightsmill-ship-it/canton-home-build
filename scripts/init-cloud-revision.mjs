/**
 * Initialize cloudRevision on production state.json: 0 → 1.
 * Archives current state first, then PUTs identical data with cloudRevision: 1 only.
 * Does not change projects, pays, contacts, or financial fields.
 *
 * Run: node scripts/init-cloud-revision.mjs
 */
import {
  fetchStorageJson,
  putStorageJson,
  archiveCloudStateBeforeReplace,
  stateFingerprint,
  getCloudRevision,
  STATE_PATH,
} from "../src/sync/cloudSync.js";

const EXPECTED = { projs: 3, pays: 81, contacts: 18 };

console.log("1. Fetch current production cloud state…");
const res = await fetchStorageJson(STATE_PATH);
if (!res.ok || !res.data) {
  console.error("Failed to fetch:", res.error || res.status);
  process.exit(1);
}

const fp = stateFingerprint(res.data);
const rev = getCloudRevision(res.data);
console.log(`   revision: ${rev}, ${fp.projs}/${fp.pays}/${fp.contacts}`);

for (const [k, v] of Object.entries(EXPECTED)) {
  if (fp[k] !== v) {
    console.error(`   ✗ expected ${k}=${v}, got ${fp[k]} — aborting`);
    process.exit(1);
  }
}

if (rev >= 1) {
  console.log(`   cloudRevision already ${rev} — nothing to do.`);
  process.exit(0);
}

console.log("2. Archive current state before revision init…");
const archive = await archiveCloudStateBeforeReplace(res.data);
if (!archive.ok) {
  console.error("Archive failed:", archive);
  process.exit(1);
}
console.log(`   archived to: ${archive.path}`);

console.log("3. PUT state.json with cloudRevision: 1 (all user data unchanged)…");
const initialized = {
  ...res.data,
  cloudRevision: 1,
  _revisionInitializedAt: Date.now(),
};
const put = await putStorageJson(STATE_PATH, initialized);
if (!put.ok) {
  console.error("PUT failed:", put.status, put.body);
  process.exit(1);
}

console.log("4. Verify read-back…");
const verify = await fetchStorageJson(STATE_PATH);
const vfp = stateFingerprint(verify.data);
const vrev = getCloudRevision(verify.data);
console.log(`   revision: ${vrev}, ${vfp.projs}/${vfp.pays}/${vfp.contacts}`);

if (vrev !== 1 || vfp.projs !== 3 || vfp.pays !== 81 || vfp.contacts !== 18) {
  console.error("   ✗ verification failed");
  process.exit(1);
}

console.log("");
console.log("cloudRevision initialized:");
console.log(`  archive: ${archive.path}`);
console.log(`  cloudRevision: 0 → 1`);
console.log(`  projects: ${vfp.projs}, pays: ${vfp.pays}, contacts: ${vfp.contacts}`);
