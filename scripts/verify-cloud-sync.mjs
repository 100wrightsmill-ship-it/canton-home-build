/**
 * Unit tests for cloud sync protection (no network).
 * Run: node scripts/verify-cloud-sync.mjs
 */
import {
  resolveBootState,
  packStateSnapshot,
  slimLocalSnapshot,
  prepareCloudSnapshot,
  documentStoragePath,
  SYNC_SCHEMA_VERSION,
  stateFingerprint,
  detectMassDataLoss,
  isSeedLikeState,
  hasRealUserData,
  assessCloudUpload,
  getCloudRevision,
  nextCloudRevision,
  isRevisionStale,
  fingerprintSignature,
  formatFingerprintSummary,
} from "../src/sync/cloudSync.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

const seed = {
  projs: [{ id: "p1" }, { id: "zfjnvrxmo8rj9ui" }],
  pays: new Array(9).fill(0).map((_, i) => ({ id: `py${i}` })),
  contacts: new Array(11).fill(0).map((_, i) => ({ id: `c${i}` })),
};

const richCloud = {
  cloudRevision: 5,
  projs: [{ id: "p1" }, { id: "p2" }, { id: "zfjnvrxmo8rj9ui" }],
  pays: new Array(81).fill(0).map((_, i) => ({ id: `py${i}` })),
  contacts: new Array(18).fill(0).map((_, i) => ({ id: `c${i}` })),
  savedAt: 100,
};

const staleLocal = {
  projs: seed.projs,
  pays: seed.pays,
  contacts: seed.contacts,
  savedAt: 999999,
};

console.log("cloudRevision helpers");
{
  assert(getCloudRevision({ cloudRevision: 5 }) === 5, "reads revision");
  assert(getCloudRevision({}) === 0, "legacy missing revision = 0");
  assert(nextCloudRevision(5) === 6, "next revision increments");
  assert(isRevisionStale({ cloudRevision: 6 }, 5), "stale when cloud advanced");
  assert(!isRevisionStale({ cloudRevision: 5 }, 5), "not stale when equal");
}

console.log("stateFingerprint / seed detection");
{
  const s = stateFingerprint(seed);
  assert(s.projs === 2 && s.pays === 9 && s.contacts === 11, "seed fingerprint counts");
  assert(isSeedLikeState(staleLocal, seed), "stale local matches seed counts");
  assert(hasRealUserData(richCloud, seed), "rich cloud is real user data");
}

console.log("detectMassDataLoss");
{
  const base = stateFingerprint(richCloud);
  const bad = stateFingerprint(staleLocal);
  const loss = detectMassDataLoss(base, bad);
  assert(loss.blocked, "81 pays → 9 pays blocked");
  assert(loss.reasons.some((r) => r.includes("pays")), "reports pays drop");
}
{
  const base = stateFingerprint(richCloud);
  const oneDelete = { ...richCloud, pays: richCloud.pays.slice(0, 80) };
  const loss = detectMassDataLoss(base, stateFingerprint(oneDelete));
  assert(!loss.blocked, "single pay delete allowed (81→80)");
}

console.log("resolveBootState — cloud-first, savedAt ignored");
{
  const r = resolveBootState(richCloud, staleLocal, seed, { cloudFetchOk: true });
  assert(r.source === "cloud", "always cloud when fetch OK (even if local savedAt newer)");
  assert(r.cloudRevision === 5, "returns cloud revision");
  assert(r.staleLocalRejected === true, "flags stale local cache");
}
{
  const r = resolveBootState(richCloud, staleLocal, seed, { cloudFetchOk: false });
  assert(r.source === "cloud", "cloud data still used when present offline");
}
{
  const r = resolveBootState(null, null, seed);
  assert(r.source === "seed", "empty cloud and local → seed");
}

console.log("assessCloudUpload — revision stale blocks write");
{
  const pending = packStateSnapshot({
    ...richCloud,
    pays: richCloud.pays.slice(0, 80),
  });
  const a = assessCloudUpload({
    cloudState: { ...richCloud, cloudRevision: 6 },
    localPayload: pending,
    loadedRevision: 5,
    seedRef: seed,
  });
  assert(!a.allowed && a.kind === "revision-stale", "rev 6 vs loaded 5 → blocked");
}
{
  const pending = packStateSnapshot(staleLocal);
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: pending,
    loadedRevision: 5,
    seedRef: seed,
  });
  assert(!a.allowed, "seed-like payload blocked even if revision matches");
  assert(a.kind === "seed-blocked" || a.kind === "mass-loss", "seed or mass-loss guard");
}

console.log("assessCloudUpload — real failure: cloud 3/81 rev 5, stale device rev 5");
{
  const pending = packStateSnapshot(staleLocal);
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: pending,
    loadedRevision: 5,
    seedRef: seed,
  });
  assert(!a.allowed, "stale 2/9 cannot upload when loaded rev still 5");
}

console.log("assessCloudUpload — allowed when revision matches and data OK");
{
  const pending = packStateSnapshot({
    ...richCloud,
    pays: richCloud.pays.slice(0, 80),
  });
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: pending,
    loadedRevision: 5,
    seedRef: seed,
  });
  assert(a.allowed, "one pay delete with matching revision allowed");
  assert(a.nextRevision === 6, "next revision is 6");
}

console.log("assessCloudUpload — first write to empty cloud");
{
  const pending = packStateSnapshot(seed);
  const a = assessCloudUpload({
    cloudState: null,
    localPayload: pending,
    loadedRevision: 0,
    seedRef: seed,
  });
  assert(a.allowed && a.nextRevision === 1, "first cloud write gets revision 1");
}

console.log("assessCloudUpload — no loaded revision blocks");
{
  const pending = packStateSnapshot(richCloud);
  const a = assessCloudUpload({
    cloudState: richCloud,
    localPayload: pending,
    loadedRevision: null,
    seedRef: seed,
  });
  assert(!a.allowed && a.kind === "revision-not-loaded", "must load cloud revision first");
}

console.log("packStateSnapshot strips stale cloudRevision from payload");
{
  const packed = packStateSnapshot({ projs: [], cp: "x", cloudRevision: 99 });
  assert(packed.cloudRevision === undefined, "does not copy old cloudRevision");
  assert(typeof packed.savedAt === "number", "sets savedAt for display only");
}

console.log("helpers");
{
  const fat = {
    docs: [{ id: "d1", data: "data:application/pdf;base64,abc" }],
    contacts: [{ id: "c1", docs: [{ id: "d2", data: "x" }] }],
  };
  const slim = slimLocalSnapshot(fat);
  assert(slim._localSlim === true, "marks slim snapshot");
}
{
  const p = documentStoragePath("p1", "doc1", "My Report.pdf");
  assert(p.includes("documents/p1/doc1/"), "builds storage path");
}
{
  const sig1 = fingerprintSignature(stateFingerprint(richCloud));
  const sig2 = fingerprintSignature(stateFingerprint(staleLocal));
  assert(sig1 !== sig2, "fingerprints differ for rich vs stale");
  assert(formatFingerprintSummary(stateFingerprint(richCloud)).includes("81 pays"), "summary readable");
}

console.log("");
if (failed === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`${failed} failed, ${passed} passed.`);
  process.exit(1);
}
