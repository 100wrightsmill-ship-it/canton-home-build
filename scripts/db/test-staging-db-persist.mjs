#!/usr/bin/env node
/**
 * Staging DB persistence integration tests (field-level edits survive refetch).
 *
 * Local:  npm run staging:api  (in another terminal)
 *         npm run db:staging:test:persist
 *
 * Preview: STAGING_API_URL=https://your-preview.vercel.app/api/staging npm run db:staging:test:persist
 */
import { spawnSync } from "child_process";
import { loadStagingEnv } from "./load-staging-env.mjs";
import { createDbPersistQueue } from "../../src/db/dbPersistQueue.js";
import { computeDeltaOps } from "../../src/db/deltaApply.js";
import { withStagingClient } from "../../src/db/pg.js";
import { TABLE_INSERT_ORDER, TABLE_PRIMARY_KEY, tableFqn } from "../../src/db/tableOrder.js";

loadStagingEnv();

const VERCEL_DEPLOYMENT = process.env.STAGING_VERCEL_DEPLOYMENT || "";
const API = process.env.STAGING_API_URL || "http://localhost:3334";
const API_PREFIX = VERCEL_DEPLOYMENT ? "/api/staging" : "";
const TEST_PREFIX = "test_persist_";
const JORDAN = "zfjnvrxmo8rj9ui";

let passed = 0;
let failed = 0;

function assert(cond, msg, detail = "") {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg, detail ? `— ${detail}` : "");
  }
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function stagingSnapshot(state) {
  return {
    projs: state.projs,
    phases: state.phases,
    tasks: state.tasks,
    pays: state.pays,
    contacts: state.contacts,
    docs: state.docs,
    folders: state.folders,
    orders: state.orders,
    msgs: state.msgs,
    notifs: state.notifs,
    cp: state.cp,
  };
}

function vercelCurlApi(path, options = {}) {
  const fullPath = `${API_PREFIX}${path}`;
  const curlArgs = ["-s", "-w", "\n__HTTP_STATUS__:%{http_code}"];
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") curlArgs.push("-X", method);
  curlArgs.push("-H", "Content-Type: application/json");
  if (options.body) curlArgs.push("-d", options.body);

  const args = [
    "curl",
    fullPath,
    "--deployment",
    VERCEL_DEPLOYMENT,
    "--local-config",
    "vercel.staging.json",
    "-y",
    "--",
    ...curlArgs,
  ];
  const run = spawnSync("vercel", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) {
    throw new Error(`vercel curl failed (${fullPath}): ${run.stderr || run.stdout}`);
  }
  const raw = run.stdout || "";
  const statusMatch = raw.match(/__HTTP_STATUS__:(\d+)\s*$/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const jsonText = raw.replace(/\n__HTTP_STATUS__:\d+\s*$/, "").trim();
  let body = {};
  try {
    body = JSON.parse(jsonText);
  } catch {
    body = { raw: jsonText };
  }
  return { status, body, ok: status >= 200 && status < 300 };
}

async function api(path, options = {}) {
  if (VERCEL_DEPLOYMENT) return vercelCurlApi(path, options);
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ok: res.ok };
}

async function fetchState() {
  await api("/api/simulate-offline", {
    method: "POST",
    body: JSON.stringify({ offline: false }),
  });
  const { body, status } = await api("/api/state");
  if (!body?.state) {
    throw new Error(`/api/state failed (${status}): ${JSON.stringify(body)}`);
  }
  return body.state;
}

async function postDelta(before, after) {
  const { body, ok, status } = await api("/api/delta", {
    method: "POST",
    body: JSON.stringify({ before, after }),
  });
  if (!ok) {
    throw new Error(`/api/delta failed (${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function clearAudit() {
  await api("/api/audit/clear", { method: "POST" });
}

async function auditCount() {
  const { body } = await api("/api/audit");
  return (body.entries || []).length;
}

async function hardDeleteTestRecords() {
  if (!process.env.STAGING_DATABASE_URL) return 0;
  return withStagingClient(async (client) => {
    let total = 0;
    await client.query("BEGIN");
    try {
      await client.query(
        `DELETE FROM ${tableFqn("contact_projects")} WHERE contact_id LIKE $1`,
        [`${TEST_PREFIX}%`],
      );
      for (const table of [...TABLE_INSERT_ORDER].reverse()) {
        if (table === "contact_projects") continue;
        const pk = TABLE_PRIMARY_KEY[table]?.[0] || "id";
        if (pk !== "id") continue;
        const { rowCount } = await client.query(
          `DELETE FROM ${tableFqn(table)} WHERE id LIKE $1`,
          [`${TEST_PREFIX}%`],
        );
        total += rowCount;
      }
      await client.query("COMMIT");
      return total;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== STAGING DB PERSISTENCE TESTS ===");
  console.log(
    "API:",
    VERCEL_DEPLOYMENT ? `vercel curl → ${VERCEL_DEPLOYMENT}${API_PREFIX}` : API,
    "\n",
  );

  const health = await api("/api/health");
  if (!health.ok || health.body?.mode !== "staging-db") {
    console.error("Staging API not reachable or wrong mode:", health.body);
    process.exit(1);
  }

  await hardDeleteTestRecords();

  let state = await fetchState();
  const testPayId = `${TEST_PREFIX}pay1`;
  const testPhaseId = `${TEST_PREFIX}phase1`;

  // Setup: pending pay + pending phase
  {
    let after = clone(state);
    after.pays = [
      ...after.pays,
      {
        id: testPayId,
        pid: JORDAN,
        date: "2026-10-04",
        amt: 500,
        to: "Persist Test Vendor",
        method: "Check",
        cat: "Test",
        costCat: "materials",
        status: "pending",
        paidDate: "",
        source: "cost",
        notes: "initial",
      },
    ];
    after.phases = [
      ...after.phases,
      {
        id: testPhaseId,
        pid: JORDAN,
        name: "Persist Test Phase",
        he: "Persist Test Phase",
        group: "Test",
        ord: 999,
        status: "pending",
        progress: 0,
        who: null,
        checklists: [],
      },
    ];
    const r = await postDelta(state, after);
    assert(r.ops?.length >= 2, "setup: create test pay + phase");
    state = await fetchState();
  }

  // 1. Pending → Paid → refetch
  console.log("\n1. Pending → Paid survives refetch");
  {
    const before = stagingSnapshot(state);
    const pay = state.pays.find((p) => p.id === testPayId);
    assert(pay?.status === "pending", "precondition: pay pending", pay?.status);

    let after = clone(state);
    after.pays = after.pays.map((p) =>
      p.id === testPayId
        ? { ...p, status: "paid", paidDate: "2026-10-04" }
        : p,
    );
    assert(computeDeltaOps(before, stagingSnapshot(after)).length === 1, "delta detects status-only pay change");

    await postDelta(before, stagingSnapshot(after));
    const refetched = await fetchState();
    const got = refetched.pays.find((p) => p.id === testPayId);
    assert(got?.status === "paid", "pay stays paid after refetch", `got ${got?.status}`);
    assert(got?.paidDate === "2026-10-04", "paidDate persisted", got?.paidDate);
    state = refetched;
  }

  // 2. Stage Pending → Completed → refetch
  console.log("\n2. Phase Pending → Completed survives refetch");
  {
    const before = stagingSnapshot(state);
    let after = clone(state);
    after.phases = after.phases.map((ph) =>
      ph.id === testPhaseId
        ? { ...ph, status: "complete", progress: 100 }
        : ph,
    );
    assert(computeDeltaOps(before, stagingSnapshot(after)).length === 1, "delta detects phase status change");

    await postDelta(before, stagingSnapshot(after));
    const refetched = await fetchState();
    const got = refetched.phases.find((ph) => ph.id === testPhaseId);
    assert(got?.status === "complete", "phase stays complete after refetch", `got ${got?.status}`);
    assert(got?.progress === 100, "progress persisted", String(got?.progress));
    state = refetched;
  }

  // 3. Edit amount / date / text → refetch
  console.log("\n3. amount / date / text edits survive refetch");
  {
    const before = stagingSnapshot(state);
    let after = clone(state);
    after.pays = after.pays.map((p) =>
      p.id === testPayId
        ? {
            ...p,
            amt: 777.77,
            date: "2026-11-15",
            notes: "edited-text-persist",
            to: "Updated Vendor Name",
          }
        : p,
    );
    const ops = computeDeltaOps(before, stagingSnapshot(after));
    assert(ops.length === 1 && ops[0].op === "update", "field edits → one update op");

    await postDelta(before, stagingSnapshot(after));
    const refetched = await fetchState();
    const got = refetched.pays.find((p) => p.id === testPayId);
    assert(got?.amt === 777.77, "amount persisted", String(got?.amt));
    assert(got?.date === "2026-11-15", "date persisted", got?.date);
    assert(got?.notes === "edited-text-persist", "notes persisted", got?.notes);
    assert(got?.to === "Updated Vendor Name", "vendor text persisted", got?.to);
    state = refetched;
  }

  // 4. Rapid edits coalesced through persist queue (simulates in-flight save)
  console.log("\n4. Rapid edits while save in-flight — final values persist");
  {
    state = await fetchState();
    const before0 = stagingSnapshot(state);
    let applyCount = 0;
    let releaseFirst;
    const firstGate = new Promise((r) => {
      releaseFirst = r;
    });

    const q = createDbPersistQueue({
      applyDelta: async (before, after) => {
        applyCount += 1;
        if (applyCount === 1) await firstGate;
        return postDelta(before, after);
      },
    });
    q.setBaseline(before0);

    const s1 = clone(state);
    s1.pays = s1.pays.map((p) =>
      p.id === testPayId ? { ...p, amt: 888 } : p,
    );
    q.schedule(stagingSnapshot(s1));

    await sleep(10);
    const s2 = clone(s1);
    s2.pays = s2.pays.map((p) =>
      p.id === testPayId ? { ...p, status: "pending", paidDate: "" } : p,
    );
    s2.phases = s2.phases.map((ph) =>
      ph.id === testPhaseId ? { ...ph, status: "pending", progress: 50 } : ph,
    );
    q.schedule(stagingSnapshot(s2));

    const s3 = clone(s2);
    s3.pays = s3.pays.map((p) =>
      p.id === testPayId
        ? { ...p, status: "paid", paidDate: "2026-12-01", notes: "rapid-final" }
        : p,
    );
    s3.phases = s3.phases.map((ph) =>
      ph.id === testPhaseId ? { ...ph, status: "complete", progress: 100 } : ph,
    );
    q.schedule(stagingSnapshot(s3));

    releaseFirst();
    await q.flush();

    assert(applyCount === 2, "queue drained with two serial saves (not dropped)", `applyCount=${applyCount}`);

    const refetched = await fetchState();
    const pay = refetched.pays.find((p) => p.id === testPayId);
    const phase = refetched.phases.find((ph) => ph.id === testPhaseId);
    assert(pay?.amt === 888, "rapid: amount from first edit kept", String(pay?.amt));
    assert(pay?.status === "paid" && pay?.paidDate === "2026-12-01", "rapid: final paid status kept");
    assert(pay?.notes === "rapid-final", "rapid: final notes kept", pay?.notes);
    assert(
      phase?.status === "complete" && phase?.progress === 100,
      "rapid: final phase progress kept",
      `status=${phase?.status} progress=${phase?.progress}`,
    );
    state = refetched;
  }

  // 5. Zero-edit refresh → zero writes
  console.log("\n5. Zero-edit refresh → zero writes");
  {
    state = await fetchState();
    const snap = stagingSnapshot(state);
    await clearAudit();
    const r = await postDelta(snap, clone(snap));
    const writes = await auditCount();
    assert((r.ops || []).length === 0, "zero-edit delta returns 0 ops");
    assert(writes === 0, "zero-edit produces no audit writes", `audit entries=${writes}`);
  }

  // 6. Create / delete still work
  console.log("\n6. Create and delete still work");
  {
    state = await fetchState();
    const extraId = `${TEST_PREFIX}pay2`;
    let after = clone(state);
    after.pays = [
      ...after.pays,
      {
        id: extraId,
        pid: JORDAN,
        date: "2026-10-05",
        amt: 42,
        to: "Delete Me",
        method: "Cash",
        cat: "Test",
        costCat: "materials",
        status: "pending",
        paidDate: "",
        source: "cost",
      },
    ];
    let r = await postDelta(stagingSnapshot(state), stagingSnapshot(after));
    assert(r.ops?.some((o) => o.op === "insert" && o.table === "pays"), "create: insert op");

    state = await fetchState();
    assert(state.pays.some((p) => p.id === extraId), "create: row visible after refetch");

    after = clone(state);
    after.pays = after.pays.filter((p) => p.id !== extraId);
    r = await postDelta(stagingSnapshot(state), stagingSnapshot(after));
    assert(r.ops?.some((o) => o.op === "soft_delete" && o.table === "pays"), "delete: soft_delete op");

    state = await fetchState();
    assert(!state.pays.some((p) => p.id === extraId), "delete: row gone after refetch");
  }

  // Cleanup test records
  await hardDeleteTestRecords();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
