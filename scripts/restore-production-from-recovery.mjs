/**
 * Admin recovery restore: archive current production cloud, then PUT recovered state
 * with monotonic cloudRevision (same semantics as restoreCloudBackup / protected upload).
 *
 * Usage: node scripts/restore-production-from-recovery.mjs [--json-file <path>]
 */
import crypto from "crypto";
import fs from "fs";
import {
  archiveCloudStateBeforeReplace,
  fetchStorageJson,
  getCloudRevision,
  listCloudStateBackups,
  nextCloudRevision,
  packStateSnapshot,
  prepareCloudSnapshot,
  putStorageJson,
  STATE_PATH,
} from "../src/sync/cloudSync.js";

const DEFAULT_SOURCE =
  "backups/recovery-2026-10-03/canton-localhost-repaired-20261004.json";

const jsonFile =
  process.argv.includes("--json-file")
    ? process.argv[process.argv.indexOf("--json-file") + 1]
    : DEFAULT_SOURCE;

function verifyDollarMetrics(state) {
  const JORDAN_ID = "zfjnvrxmo8rj9ui";
  const jordan = (state.projs || []).find((p) => p.id === JORDAN_ID);
  const jordanPays = (state.pays || []).filter((p) => p.pid === JORDAN_ID);
  const jordanPaySum = Math.round(
    jordanPays.reduce((s, p) => s + (Number(p.amt) || 0), 0),
  );
  const cos = jordan?.changeOrders || [];
  const approvedSum = cos
    .filter((c) => c.status === "approved")
    .reduce((s, c) => s + (Number(c.amt) || 0), 0);
  const contractValue = Math.round((jordan?.originalContract || 0) + approvedSum);
  const cabCo = cos.find((c) => Number(c.amt) === 9450);
  const jordanElec = (state.projs || []).find((p) => p.id === "m4gk3isms3o72gt");
  const cantonSum = Math.round(
    (state.pays || [])
      .filter((p) => p.pid === "p1")
      .reduce((s, p) => s + (Number(p.amt) || 0), 0),
  );
  return {
    projs: (state.projs || []).length,
    pays: (state.pays || []).length,
    contacts: Array.isArray(state.contacts) ? state.contacts.length : 0,
    jordanContract: contractValue,
    jordanExpenses: jordanPaySum,
    cabinetsCO9450: !!cabCo,
    jordanElectrical49000:
      jordanElec?.originalContract === 49000 ||
      jordanElec?.totalBudget === 49000,
    cantonExpenses: cantonSum,
    cloudRevision: getCloudRevision(state),
  };
}

const raw = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
const sourceSha256 = fs
  .readFileSync(jsonFile)
  .toString("utf8");
const sha256 = crypto.createHash("sha256").update(sourceSha256).digest("hex");

console.log("Recovery source:", jsonFile);
console.log("SHA256:", sha256);

const beforeCloud = await fetchStorageJson(STATE_PATH);
if (!beforeCloud.ok) {
  console.error("Failed to fetch current production cloud:", beforeCloud.error);
  process.exit(1);
}

const revBefore = getCloudRevision(beforeCloud.data);
const fpBefore = verifyDollarMetrics(beforeCloud.data || {});
console.log("\nProduction BEFORE restore:");
console.log(JSON.stringify({ cloudRevision: revBefore, metrics: fpBefore }, null, 2));

const archive = await archiveCloudStateBeforeReplace(beforeCloud.data);
if (!archive.ok) {
  console.error("Archive failed — aborting restore:", archive.body);
  process.exit(1);
}
console.log("\nArchived previous production to:", archive.path);

const cloudSnapshot = prepareCloudSnapshot(raw);
const payload = {
  ...packStateSnapshot(cloudSnapshot),
  cloudRevision: nextCloudRevision(revBefore),
  _restoredFrom: jsonFile,
  _restoredAt: Date.now(),
  _recoverySha256: sha256,
};

const put = await putStorageJson(STATE_PATH, payload);
if (!put.ok) {
  console.error("Restore PUT failed:", put.status, put.body);
  process.exit(1);
}

const afterCloud = await fetchStorageJson(STATE_PATH);
if (!afterCloud.ok || !afterCloud.data) {
  console.error("Failed to read back cloud after restore");
  process.exit(1);
}

const revAfter = getCloudRevision(afterCloud.data);
const metricsAfter = verifyDollarMetrics(afterCloud.data);
const backups = await listCloudStateBackups(5);

const expected = {
  projs: 3,
  pays: 81,
  contacts: 18,
  jordanContract: 67575,
  jordanExpenses: 40393,
  cabinetsCO9450: true,
  jordanElectrical49000: true,
  cantonExpenses: 134937,
};

const checks = {
  projs3: metricsAfter.projs === 3,
  pays81: metricsAfter.pays === 81,
  contacts18: metricsAfter.contacts === 18,
  jordanContract67575: metricsAfter.jordanContract === 67575,
  jordanExpenses40393: metricsAfter.jordanExpenses === 40393,
  cabinetsCO9450: metricsAfter.cabinetsCO9450 === true,
  jordanElectrical49000: metricsAfter.jordanElectrical49000 === true,
  cantonExpenses134937: metricsAfter.cantonExpenses === 134937,
  cloudRevisionAdvanced: revAfter === revBefore + 1,
  archiveExists: archive.ok && !!archive.path,
  backupListed: backups.ok && backups.items.some((b) => b.name === archive.path?.split("/").pop()),
};

console.log("\nProduction AFTER restore:");
console.log(
  JSON.stringify(
    {
      cloudRevisionBefore: revBefore,
      cloudRevisionAfter: revAfter,
      archivePath: archive.path,
      metrics: metricsAfter,
      expected,
      checks,
      allPass: Object.values(checks).every(Boolean),
      recentBackups: backups.items?.slice(0, 5).map((b) => b.name),
    },
    null,
    2,
  ),
);

process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
