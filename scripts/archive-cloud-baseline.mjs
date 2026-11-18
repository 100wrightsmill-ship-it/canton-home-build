/**
 * Permanent read-only archive of current production cloud state.json.
 * Does NOT modify state.json.
 *
 * Run: node scripts/archive-cloud-baseline.mjs [--prefix state-pre-cutover]
 */
import {
  fetchStorageJson,
  putStorageJson,
  stateFingerprint,
  getCloudRevision,
  STATE_PATH,
  BUCKET,
} from "../src/sync/cloudSync.js";
import { recordProductionBaseline } from "../src/db/baseline.js";

const prefixArg = process.argv.includes("--prefix")
  ? process.argv[process.argv.indexOf("--prefix") + 1]
  : "state-verified-baseline";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archivePath = `backups/${prefixArg}-${stamp}.json`;

console.log("Fetching current production cloud state…");
const res = await fetchStorageJson(STATE_PATH);
if (!res.ok || !res.data) {
  console.error("Failed to fetch cloud state:", res.error || res.status);
  process.exit(1);
}

const fp = stateFingerprint(res.data);
const rev = getCloudRevision(res.data);
const baseline = recordProductionBaseline(res.data);

console.log(`  revision: ${rev}`);
console.log(`  savedAt: ${res.data.savedAt ? new Date(res.data.savedAt).toISOString() : "—"}`);
console.log(`  fingerprint: ${fp.projs} projs, ${fp.pays} pays, ${fp.contacts} contacts`);
console.log(`  baseline snapshot check: ${baseline.snapshotPassed ? "PASS" : "FAIL"}`);

if (!baseline.snapshotPassed) {
  console.error("  ✗ snapshot self-consistency failed — review before archiving");
  process.exit(1);
}

console.log(`Archiving to ${BUCKET}/${archivePath} …`);
const put = await putStorageJson(archivePath, res.data);
if (!put.ok) {
  console.error("Archive PUT failed:", put.status, put.body);
  process.exit(1);
}

console.log("");
console.log("Permanent cloud backup created:");
console.log(`  path: ${archivePath}`);
console.log(`  revision: ${rev}`);
console.log(`  projects: ${fp.projs}, pays: ${fp.pays}, contacts: ${fp.contacts}`);
console.log("state.json was NOT modified.");
