#!/usr/bin/env node
/**
 * Unit tests for DB persist queue (coalesce + zero-edit skip).
 * Run: node scripts/db/test-db-persist-queue.mjs
 */
import { createDbPersistQueue } from "../../src/db/dbPersistQueue.js";
import { computeDeltaOps } from "../../src/db/deltaApply.js";

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

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

const baseState = {
  projs: [{ id: "p1", changeOrders: [] }],
  pays: [
    {
      id: "pay1",
      pid: "p1",
      amt: 100,
      status: "pending",
      paidDate: "",
      source: "cost",
      date: "2026-01-01",
    },
  ],
  contacts: [{ id: "c1", pids: ["p1"], scopes: [], pmts: [], docs: [] }],
  phases: [{ id: "ph1", pid: "p1", status: "pending", progress: 0 }],
  tasks: [],
};

function snapFrom(state) {
  return {
    projs: state.projs,
    phases: state.phases,
    tasks: state.tasks,
    pays: state.pays,
    contacts: state.contacts,
    docs: [],
    folders: [],
    orders: [],
    msgs: [],
    notifs: [],
    cp: "p1",
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("zero-edit produces no delta ops");
  {
    const s = snapFrom(baseState);
    assert(computeDeltaOps(s, clone(s)).length === 0, "identical snapshots → 0 ops");
  }

  console.log("\nmark paid produces update op (same pays.length)");
  {
    const before = snapFrom(baseState);
    const after = clone(before);
    after.pays[0].status = "paid";
    after.pays[0].paidDate = "2026-10-04";
    const ops = computeDeltaOps(before, after);
    assert(ops.length === 1 && ops[0].op === "update", "status change → 1 update op");
    assert(ops[0].row.status === "paid", "update carries paid status");
  }

  console.log("\nqueue: field edit persists on schedule");
  {
    const applied = [];
    const q = createDbPersistQueue({
      applyDelta: async (before, after) => {
        applied.push({ before: clone(before), after: clone(after) });
        return { ops: computeDeltaOps(before, after) };
      },
    });
    const s0 = snapFrom(baseState);
    q.setBaseline(clone(s0));
    const s1 = clone(s0);
    s1.pays[0].status = "paid";
    s1.pays[0].paidDate = "2026-10-04";
    q.schedule(s1);
    await sleep(20);
    assert(applied.length === 1, "one applyDelta call");
    assert(applied[0].after.pays[0].status === "paid", "paid status sent to API");
    assert(q.pendingDeltaCount(s1) === 0, "baseline advanced — zero pending delta");
  }

  console.log("\nqueue: zero-edit schedule writes nothing");
  {
    let calls = 0;
    const q = createDbPersistQueue({
      applyDelta: async () => {
        calls += 1;
      },
    });
    const s = snapFrom(baseState);
    q.setBaseline(clone(s));
    q.schedule(clone(s));
    await sleep(20);
    assert(calls === 0, "no applyDelta on zero-edit refresh");
  }

  console.log("\nqueue: rapid edits coalesce while in flight");
  {
    const applied = [];
    let resolveFirst;
    const firstGate = new Promise((r) => {
      resolveFirst = r;
    });

    const q = createDbPersistQueue({
      applyDelta: async (before, after) => {
        applied.push(clone(after));
        if (applied.length === 1) await firstGate;
        return { ops: [] };
      },
    });

    const s0 = snapFrom(baseState);
    q.setBaseline(clone(s0));

    const s1 = clone(s0);
    s1.pays[0].amt = 200;
    q.schedule(s1);

    await sleep(5);
    const s2 = clone(s1);
    s2.pays[0].status = "paid";
    s2.pays[0].paidDate = "2026-10-04";
    q.schedule(s2);

    const s3 = clone(s2);
    s3.phases[0].status = "complete";
    s3.phases[0].progress = 100;
    q.schedule(s3);

    resolveFirst();
    await sleep(30);

    assert(applied.length === 2, "two serial applyDelta calls (not three dropped)");
    assert(applied[1].pays[0].status === "paid", "final pay status persisted");
    assert(applied[1].phases[0].status === "complete", "final phase status persisted");
    assert(applied[1].pays[0].amt === 200, "intermediate amount included in final coalesced snap");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
