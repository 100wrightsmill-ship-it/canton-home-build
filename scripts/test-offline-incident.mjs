/**
 * Simulates the Supabase outage incident (read-only logic tests, no cloud writes).
 * Run: node scripts/test-offline-incident.mjs
 */
import {
  resolveBootState,
  assessCloudUpload,
  packStateSnapshot,
  getCloudRevision,
  stateFingerprint,
  isSeedLikeState,
} from "../src/sync/cloudSync.js";

const seed = {
  cp: "zfjnvrxmo8rj9ui",
  projs: [{ id: "p1" }, { id: "zfjnvrxmo8rj9ui" }],
  pays: new Array(9).fill(0).map((_, i) => ({ id: `py${i}` })),
  contacts: new Array(11).fill(0).map((_, i) => ({ id: `c${i}` })),
};

const richCloud = {
  cloudRevision: 1,
  savedAt: 1785428355986,
  projs: [
    { id: "p1", name: "Canton Home Build" },
    { id: "zfjnvrxmo8rj9ui", name: "Jordan" },
    { id: "m4gk3isms3o72gt", name: "Jordan Electrical" },
  ],
  pays: new Array(81).fill(0).map((_, i) => ({ id: `py${i}`, pid: "p1", amt: 100 })),
  contacts: new Array(18).fill(0).map((_, i) => ({ id: `c${i}` })),
};

const staleLocal = {
  ...seed,
  savedAt: 9999999999999,
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

console.log("Incident: cloud 3/81, Supabase down, browser has stale 2/9\n");

console.log("A. Boot when cloud fetch fails (DNS / paused Supabase)");
{
  const boot = resolveBootState(null, staleLocal, seed, { cloudFetchOk: false });
  assert(boot.source === "local-offline", "shows local-offline, not cloud or seed");
  assert(boot.offline === true, "marked offline");
  assert(boot.cloudRevision === null, "revision unknown — uploads blocked");
  assert(boot.staleLocal === true, "stale seed-like local flagged");
  assert(boot.data.projs.length === 2, "displays stale 2 projects");
  assert(boot.data.pays.length === 9, "displays stale 9 pays");
  assert(isSeedLikeState(boot.data, seed), "stale local is seed-like");
}

console.log("\nB. Boot must NOT fall back to seed when cloud fetch fails");
{
  const bootNoLocal = resolveBootState(null, null, seed, { cloudFetchOk: false });
  assert(bootNoLocal.source === "empty-offline", "empty-offline when no local cache");
  assert(bootNoLocal.data.projs.length === 0, "empty shell, not seed 2 projects");
  assert(bootNoLocal.cloudRevision === null, "revision unknown");
}

console.log("\nC. Stale local must NEVER upload while revision unknown");
{
  const pending = packStateSnapshot(staleLocal);
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: pending,
    loadedRevision: null,
    seedRef: seed,
  });
  assert(!a.allowed, "null revision blocks upload");
  assert(
    a.kind === "revision-not-loaded" || a.kind === "seed-blocked",
    `blocked as ${a.kind}`,
  );
}

console.log("\nD. Stale local must NEVER upload even if device thinks rev matches");
{
  const pending = packStateSnapshot(staleLocal);
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: pending,
    loadedRevision: 1,
    seedRef: seed,
  });
  assert(!a.allowed, "seed-like 2/9 blocked against real cloud 3/81");
  assert(
    a.kind === "seed-blocked" || a.kind === "mass-loss",
    `blocked as ${a.kind}`,
  );
}

console.log("\nE. Cloud returns — boot loads cloud 3/81 with revision");
{
  const boot = resolveBootState(richCloud, staleLocal, seed, { cloudFetchOk: true });
  assert(boot.source === "cloud", "loads cloud when fetch succeeds");
  assert(boot.data.projs.length === 3, "3 projects from cloud");
  assert(boot.data.pays.length === 81, "81 pays from cloud");
  assert(boot.cloudRevision === 1, "revision 1 loaded");
  assert(boot.staleLocalRejected === true, "stale local rejected");
}

console.log("\nF. Legitimate edit allowed at matching revision after cloud load");
{
  const edit = packStateSnapshot({
    ...richCloud,
    pays: richCloud.pays.slice(0, 80),
  });
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: edit,
    loadedRevision: 1,
    seedRef: seed,
  });
  assert(a.allowed, "single pay delete allowed at rev 1");
  assert(a.nextRevision === 2, "next revision would be 2");
}

console.log("\nG. Fingerprint sanity on rich cloud");
{
  const fp = stateFingerprint(richCloud);
  assert(fp.projs === 3 && fp.pays === 81 && fp.contacts === 18, "3/81/18");
}

console.log("");
if (failed === 0) {
  console.log(`All ${passed} incident checks passed.`);
  process.exit(0);
} else {
  console.error(`${failed} failed, ${passed} passed.`);
  process.exit(1);
}
