/**
 * Regression: Cloud=5 / Loaded=6 on clean refresh with zero edits.
 * Run: node scripts/test-revision-boot.mjs
 */
import {
  loadedRevisionFromCloud,
  stripCloudRevisionFromLocalCache,
  writeLocalCacheSnapshot,
  assessCloudUpload,
  packStateSnapshot,
  fingerprintSignature,
  stateFingerprint,
  isUserConflictKind,
} from "../src/sync/cloudSync.js";

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

const seed = {
  projs: [{ id: "p1" }, { id: "zfjnvrxmo8rj9ui" }],
  pays: new Array(9).fill(0).map((_, i) => ({ id: `py${i}` })),
  contacts: new Array(11).fill(0).map((_, i) => ({ id: `c${i}` })),
};

const cloud5 = {
  cloudRevision: 5,
  projs: [{ id: "p1" }, { id: "zfjnvrxmo8rj9ui" }, { id: "m4gk3isms3o72gt" }],
  pays: new Array(81).fill(0).map((_, i) => ({ id: `py${i}` })),
  contacts: new Array(18).fill(0).map((_, i) => ({ id: `c${i}` })),
  docs: new Array(5).fill(0).map((_, i) => ({ id: `d${i}` })),
};

console.log("1. loadedRevisionFromCloud never adds +1");
{
  assert(loadedRevisionFromCloud(cloud5) === 5, "exact cloud revision 5");
  assert(loadedRevisionFromCloud({}) === 0, "missing field = 0");
  assert(loadedRevisionFromCloud({ cloudRevision: 5 }) !== 6, "never 6 when cloud is 5");
}

console.log("\n2. localStorage must not retain stale cloudRevision 6");
{
  const polluted = { ...cloud5, cloudRevision: 6, cp: "p1" };
  const stripped = stripCloudRevisionFromLocalCache(polluted);
  assert(stripped.cloudRevision === undefined, "stripped from local cache object");
  const mockStorage = {};
  global.localStorage = {
    setItem(k, v) {
      mockStorage[k] = v;
    },
    getItem(k) {
      return mockStorage[k] ?? null;
    },
  };
  writeLocalCacheSnapshot(polluted);
  const stored = JSON.parse(mockStorage.cc_data_v1);
  assert(stored.cloudRevision === undefined, "writeLocalCacheSnapshot drops cloudRevision");
  delete global.localStorage;
}

console.log("\n3. Clean refresh: commit loaded=5 from cloud, no boot upload");
{
  const loadedFromCloud = loadedRevisionFromCloud(cloud5);
  assert(loadedFromCloud === 5, "boot commits loaded 5 from cloud fetch");
  const hydratedFp = fingerprintSignature(stateFingerprint(cloud5));
  const afterHydrateFp = fingerprintSignature(
    stateFingerprint({
      projs: cloud5.projs,
      pays: cloud5.pays,
      contacts: cloud5.contacts,
      docs: cloud5.docs,
      orders: [],
      phases: [],
      tasks: [],
    }),
  );
  assert(hydratedFp === afterHydrateFp, "zero-edit refresh fingerprint unchanged — no upload");
}

console.log("\n4. Cloud=5 / Loaded=6 must block (revision-stale), not upload");
{
  const pending = packStateSnapshot({
    projs: cloud5.projs,
    pays: cloud5.pays,
    contacts: cloud5.contacts,
    docs: cloud5.docs,
    cp: "zfjnvrxmo8rj9ui",
  });
  const a = assessCloudUpload({
    cloudState: cloud5,
    localPayload: pending,
    loadedRevision: 6,
    seedRef: seed,
  });
  assert(!a.allowed && a.kind === "revision-stale", "loaded 6 vs cloud 5 blocked");
  assert(isUserConflictKind(a.kind), "user conflict — no auto-retry");
}

console.log("\n5. Matching revision 5 allows legitimate edit only");
{
  const pending = packStateSnapshot({
    ...cloud5,
    pays: cloud5.pays.slice(0, 80),
  });
  const a = assessCloudUpload({
    cloudState: cloud5,
    localPayload: pending,
    loadedRevision: 5,
    seedRef: seed,
  });
  assert(a.allowed && a.nextRevision === 6, "user edit at rev 5 → next 6 on PUT only");
}

console.log("");
if (failed === 0) {
  console.log(`All ${passed} revision-boot checks passed.`);
  process.exit(0);
} else {
  console.error(`${failed} failed, ${passed} passed.`);
  process.exit(1);
}
