/**
 * Post-deploy verification against live production cloud (read-only + simulation).
 * Run: node scripts/verify-production-sync.mjs
 */
import {
  fetchStorageJson,
  listCloudStateBackups,
  assessCloudUpload,
  getCloudRevision,
  stateFingerprint,
  packStateSnapshot,
  STATE_PATH,
} from "../src/sync/cloudSync.js";

const seed = {
  projs: [{ id: "p1" }, { id: "zfjnvrxmo8rj9ui" }],
  pays: new Array(9).fill(0).map((_, i) => ({ id: `py${i}` })),
  contacts: new Array(11).fill(0).map((_, i) => ({ id: `c${i}` })),
};

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

console.log("1. Fetch live production cloud state.json");
const cloudRes = await fetchStorageJson(STATE_PATH);
assert(cloudRes.ok, `cloud fetch ok (status ${cloudRes.status})`);
const cloud = cloudRes.data;
const cloudRev = getCloudRevision(cloud);
const cloudFp = stateFingerprint(cloud);
console.log(`     revision: ${cloudRev} (legacy states start at 0)`);
console.log(`     fingerprint: ${cloudFp.projs} projs, ${cloudFp.pays} pays, ${cloudFp.contacts} contacts`);
console.log(`     savedAt: ${cloud?.savedAt ? new Date(cloud.savedAt).toISOString() : "—"}`);

console.log("\n2. Simulate stale seed device (2/9/11) at same loaded revision");
const staleLocal = {
  projs: seed.projs,
  pays: seed.pays,
  contacts: seed.contacts,
};
const staleUpload = assessCloudUpload({
  cloudState: cloud,
  localPayload: packStateSnapshot(staleLocal),
  loadedRevision: cloudRev,
  seedRef: seed,
});
assert(!staleUpload.allowed, "stale seed-like upload blocked");
assert(
  staleUpload.kind === "seed-blocked" || staleUpload.kind === "mass-loss",
  `blocked kind: ${staleUpload.kind}`,
);

console.log("\n3. Simulate stale device after cloud advanced (revision mismatch)");
const advancedUpload = assessCloudUpload({
  cloudState: { ...cloud, cloudRevision: cloudRev + 1 },
  localPayload: packStateSnapshot(cloud),
  loadedRevision: cloudRev,
  seedRef: seed,
});
assert(!advancedUpload.allowed && advancedUpload.kind === "revision-stale", "revision-stale blocks upload");

console.log("\n4. Simulate legitimate edit at matching revision (single pay delete)");
if (cloudFp.pays > 1) {
  const legit = assessCloudUpload({
    cloudState: cloud,
    localPayload: packStateSnapshot({
      ...cloud,
      pays: (cloud.pays || []).slice(0, cloudFp.pays - 1),
    }),
    loadedRevision: cloudRev,
    seedRef: seed,
  });
  assert(legit.allowed, "single-record change allowed at matching revision");
  assert(legit.nextRevision === cloudRev + 1, `next revision would be ${cloudRev + 1}`);
} else {
  console.log("  ~ skipped (cloud has ≤1 pay)");
}

console.log("\n5. List cloud backup history (backups/state-*)");
const backups = await listCloudStateBackups(10);
assert(backups.ok, "backup list API reachable");
console.log(`     existing versioned backups: ${backups.items.length}`);
if (backups.items.length > 0) {
  backups.items.slice(0, 3).forEach((b) => console.log(`       - ${b.name}`));
} else {
  console.log("     (none yet — first post-deploy cloud write will archive current state)");
}

console.log("\n6. Production bundle markers");
const html = await fetch("https://canton-home-build.vercel.app/").then((r) => r.text());
const jsMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
assert(jsMatch, "found production JS bundle path");
const jsUrl = `https://canton-home-build.vercel.app${jsMatch[1]}`;
const js = await fetch(jsUrl).then((r) => r.text());
const markers = [
  "cloudRevision",
  "revision-stale",
  "Cloud Backup History",
  "archiveCloudStateBeforeReplace",
  "seed-blocked",
];
for (const m of markers) {
  assert(js.includes(m), `bundle contains "${m}"`);
}

console.log("\n" + (failed === 0 ? `All ${passed} checks passed.` : `${failed} failed, ${passed} passed.`));
process.exit(failed ? 1 : 0);
