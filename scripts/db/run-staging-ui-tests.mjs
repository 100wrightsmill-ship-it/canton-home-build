#!/usr/bin/env node
/**
 * Staging application UI-equivalent tests via row-level API.
 * Requires: staging-api-server running, STAGING_DATABASE_URL in .env.staging
 */
import { loadStagingEnv } from "./load-staging-env.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { computeDeltaOps } from "../../src/db/deltaApply.js";
import { reconcileDatabase } from "../../src/db/reconcile.js";
import { withStagingClient } from "../../src/db/pg.js";
import { TABLE_INSERT_ORDER, TABLE_PRIMARY_KEY, tableFqn } from "../../src/db/tableOrder.js";

loadStagingEnv();

const API = process.env.STAGING_API_URL || "http://localhost:3334";
const TEST_PREFIX = "test_ui_";
const JORDAN = "zfjnvrxmo8rj9ui";
const CANTON = "p1";
const JORDAN_ELEC = "m4gk3isms3o72gt";

const results = [];

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ok: res.ok };
}

function record(name, pass, detail = {}) {
  results.push({ name, pass, ...detail });
  console.log(pass ? "  ✓ PASS" : "  ✗ FAIL", name, detail.summary || "");
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
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

async function applyDelta(before, after) {
  await api("/api/audit/clear", { method: "POST" });
  const { body } = await api("/api/delta", {
    method: "POST",
    body: JSON.stringify({ before, after }),
  });
  const audit = await api("/api/audit");
  return { ops: body.ops || [], audit: audit.body.entries || [] };
}

function stripTestRecords(state) {
  const after = clone(state);
  after.contacts = after.contacts.filter((c) => !c.id.startsWith(TEST_PREFIX));
  after.pays = after.pays.filter((p) => !p.id.startsWith(TEST_PREFIX));
  after.docs = (after.docs || []).filter((d) => !d.id.startsWith(TEST_PREFIX));
  after.projs = after.projs.map((p) => ({
    ...p,
    changeOrders: (p.changeOrders || []).filter((co) => !co.id.startsWith(TEST_PREFIX)),
  }));
  after.contacts = after.contacts.map((c) => ({
    ...c,
    scopes: (c.scopes || []).filter((s) => !s.id.startsWith(TEST_PREFIX)),
    pmts: (c.pmts || []).filter((p) => !p.id.startsWith(TEST_PREFIX)),
    docs: (c.docs || []).filter((d) => !d.id.startsWith(TEST_PREFIX)),
  }));
  return after;
}

async function hardDeleteTestRecords() {
  return withStagingClient(async (client) => {
    let total = 0;
    await client.query("BEGIN");
    try {
      const junction = await client.query(
        `DELETE FROM ${tableFqn("contact_projects")} WHERE contact_id LIKE $1 RETURNING contact_id`,
        [`${TEST_PREFIX}%`]
      );
      total += junction.rowCount;

      for (const table of [...TABLE_INSERT_ORDER].reverse()) {
        if (table === "contact_projects") continue;
        const pk = TABLE_PRIMARY_KEY[table]?.[0] || "id";
        if (pk !== "id") continue;
        const { rowCount } = await client.query(
          `DELETE FROM ${tableFqn(table)} WHERE id LIKE $1`,
          [`${TEST_PREFIX}%`]
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

async function cleanupTestRecords() {
  await api("/api/simulate-offline", {
    method: "POST",
    body: JSON.stringify({ offline: false }),
  });
  return hardDeleteTestRecords();
}

async function runFinalReconciliation() {
  const snapshotPath = join(
    process.cwd(),
    "backups/staging-migration-source/live-snapshot-20261004.json"
  );
  const baselineState = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const report = await withStagingClient((client) => reconcileDatabase(client, baselineState));
  record("Final reconciliation vs 3/81/19 baseline", report.passed, {
    summary: report.passed ? "PASS" : "FAIL",
  });
  return report;
}

async function main() {
  if (process.argv.includes("--cleanup-only")) {
    const n = await cleanupTestRecords();
    console.log(`Removed ${n} cleanup ops`);
    const report = await runFinalReconciliation();
    process.exit(report.passed ? 0 : 1);
  }
  console.log("=== STAGING UI TEST SUITE ===\n");
  const health = await api("/api/health");
  if (!health.ok) {
    console.error("Staging API not reachable at", API, "- run: npm run staging:api");
    process.exit(1);
  }

  let state = await fetchState();
  const baseline = clone(state);

  // 1. Projects render data
  {
    const p = state.projs || [];
    const ok =
      p.length === 3 &&
      p.some((x) => x.id === CANTON) &&
      p.some((x) => x.id === JORDAN) &&
      p.some((x) => x.id === JORDAN_ELEC) &&
      state.pays.length === 81 &&
      state.contacts.length === 19;
    record("1. Open Canton, Jordan, Jordan Electrical — data present", ok, {
      summary: `projs=${p.length} pays=${state.pays.length} contacts=${state.contacts.length}`,
    });
  }

  // 2. Add contractor
  let after = clone(state);
  const testContactId = `${TEST_PREFIX}contractor1`;
  after.contacts = [
    ...after.contacts,
    {
      id: testContactId,
      name: "UI Test Contractor",
      co: "Test Co",
      phone: "",
      email: "",
      type: "contractor",
      trade: "Testing",
      rating: 3,
      license: "",
      insurance: "",
      pids: [JORDAN],
      docs: [],
      pmts: [],
      scopes: [],
    },
  ];
  {
    const { ops, audit } = await applyDelta(state, after);
    const inserts = audit.filter((e) => e.op === "insert");
    const tables = [...new Set(inserts.map((e) => e.table))];
    const ok =
      ops.some((o) => o.table === "contacts" && o.op === "insert") &&
      ops.some((o) => o.table === "contact_projects" && o.op === "insert") &&
      tables.every((t) => ["contacts", "contact_projects"].includes(t) || inserts.length <= 2);
    record("2. Add contractor — one contact + junction row", ok, {
      summary: `ops=${ops.length} tables=${tables.join(",")}`,
      ops,
      audit,
    });
    state = await fetchState();
  }

  // 3. Add scope + stages
  after = clone(state);
  const testScopeId = `${TEST_PREFIX}scope1`;
  const testStageId = `${TEST_PREFIX}stage1`;
  after.contacts = after.contacts.map((c) =>
    c.id === testContactId
      ? {
          ...c,
          scopes: [
            {
              id: testScopeId,
              pid: JORDAN,
              phId: "",
              title: "UI Test Scope",
              desc: "test",
              status: "active",
              price: 999,
              stages: [
                {
                  id: testStageId,
                  name: "Stage 1",
                  desc: "",
                  start: "",
                  end: "",
                  status: "not_started",
                },
              ],
              costs: [],
            },
          ],
        }
      : c
  );
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok =
      ops.filter((o) => o.op === "insert" && o.table === "scopes").length === 1 &&
      ops.filter((o) => o.op === "insert" && o.table === "scope_stages").length === 1;
    record("3. Add scope + stages — scoped inserts only", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 4. Add expense
  after = clone(state);
  const testPayId = `${TEST_PREFIX}pay1`;
  after.pays = [
    ...after.pays,
    {
      id: testPayId,
      pid: JORDAN,
      date: "2026-10-04",
      amt: 123.45,
      to: "UI Test Vendor",
      method: "Check",
      cat: "Test",
      costCat: "materials",
      contractorId: testContactId,
      scopeId: testScopeId,
      source: "cost",
    },
  ];
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok = ops.length === 1 && ops[0].table === "pays" && ops[0].op === "insert";
    record("4. Add expense — one pay row", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 5. Edit expense
  after = clone(state);
  after.pays = after.pays.map((p) =>
    p.id === testPayId ? { ...p, amt: 200, notes: "edited" } : p
  );
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok = ops.length === 1 && ops[0].table === "pays" && ops[0].op === "update";
    record("5. Edit expense — one pay update", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 6. Delete test expense (soft delete)
  after = clone(state);
  after.pays = after.pays.filter((p) => p.id !== testPayId);
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok = ops.length === 1 && ops[0].table === "pays" && ops[0].op === "soft_delete";
    record("6. Delete expense — one pay soft-delete", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 7. Change order
  after = clone(state);
  const testCoId = `${TEST_PREFIX}co1`;
  after.projs = after.projs.map((p) =>
    p.id === JORDAN
      ? {
          ...p,
          changeOrders: [
            ...(p.changeOrders || []),
            {
              id: testCoId,
              title: "UI Test CO",
              amt: 500,
              status: "approved",
              date: "2026-10-04",
              scopeNotes: "",
              notes: "",
              attachments: [],
            },
          ],
        }
      : p
  );
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok = ops.some((o) => o.table === "project_change_orders" && o.op === "insert");
    record("7. Add change order — one CO row", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 8. Payment schedule
  after = clone(state);
  const testPmtId = `${TEST_PREFIX}pmt1`;
  after.contacts = after.contacts.map((c) =>
    c.id === testContactId
      ? {
          ...c,
          pmts: [
            {
              id: testPmtId,
              num: 1,
              amt: 500,
              due: "2026-11-01",
              milestone: "Test",
              linkedStage: testStageId,
              status: "pending",
              paidDate: "",
              method: "",
              conf: "",
              scopeId: testScopeId,
            },
          ],
        }
      : c
  );
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok = ops.filter((o) => o.table === "payment_schedules").length === 1;
    record("8. Payment schedule — one schedule row", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 9. Document metadata (no binary — staging metadata only)
  after = clone(state);
  const testDocId = `${TEST_PREFIX}doc1`;
  after.contacts = after.contacts.map((c) =>
    c.id === testContactId
      ? {
          ...c,
          docs: [
            {
              id: testDocId,
              pid: JORDAN,
              name: "ui-test.pdf",
              type: "application/pdf",
              size: 100,
              scopeId: testScopeId,
              kind: "general",
              storagePath: `documents/${JORDAN}/${testDocId}/ui-test.pdf`,
              data: null,
            },
          ],
        }
      : c
  );
  {
    const { ops, audit } = await applyDelta(state, after);
    const ok = ops.filter((o) => o.table === "documents").length === 1;
    record("9. Document metadata — one document row", ok, { summary: `ops=${ops.length}`, ops, audit });
    state = await fetchState();
  }

  // 10. Concurrent edits different records (parallel deltas) — test rows only
  {
    const s = await fetchState();
    const a = clone(s);
    const b = clone(s);
    a.contacts = a.contacts.map((c) =>
      c.id === testContactId ? { ...c, phone: "111-111-1111" } : c
    );
    b.contacts = b.contacts.map((c) =>
      c.id === testContactId
        ? {
            ...c,
            scopes: (c.scopes || []).map((sc) =>
              sc.id === testScopeId ? { ...sc, title: "Concurrent scope edit" } : sc
            ),
          }
        : c
    );
    const [r1, r2] = await Promise.all([
      api("/api/delta", { method: "POST", body: JSON.stringify({ before: s, after: a }) }),
      api("/api/delta", { method: "POST", body: JSON.stringify({ before: s, after: b }) }),
    ]);
    const ok = r1.ok && r2.ok;
    record("10. Concurrent different records — both succeed", ok, {
      summary: `status ${r1.status}/${r2.status}`,
    });
    state = await fetchState();
  }

  // 11. Same-record conflict — test contact only (never mutate baseline rows)
  {
    const s = await fetchState();
    if (!s.contacts.some((c) => c.id === testContactId)) {
      record("11. Same-record conflict", false, { summary: "no test contact" });
    } else {
      const a = clone(s);
      const b = clone(s);
      a.contacts = a.contacts.map((c) =>
        c.id === testContactId ? { ...c, phone: "edit-a" } : c
      );
      b.contacts = b.contacts.map((c) =>
        c.id === testContactId ? { ...c, phone: "edit-b" } : c
      );
      const r1 = await api("/api/delta", {
        method: "POST",
        body: JSON.stringify({ before: s, after: a }),
      });
      const r2 = await api("/api/delta", {
        method: "POST",
        body: JSON.stringify({ before: s, after: b }),
      });
      const ok = r1.ok && !r2.ok && r2.status === 409;
      record("11. Same-record conflict — second write rejected", ok, {
        summary: `first=${r1.status} second=${r2.status}`,
      });
    }
    state = await fetchState();
  }

  // 12. Zero writes on no-op delta
  {
    const s = await fetchState();
    await api("/api/audit/clear", { method: "POST" });
    const { body } = await api("/api/delta", {
      method: "POST",
      body: JSON.stringify({ before: s, after: s }),
    });
    const audit = await api("/api/audit");
    const ok = (body.ops || []).length === 0 && (audit.body.entries || []).length === 0;
    record("12. Refresh/zero-edit — zero DB writes", ok, {
      summary: `ops=${(body.ops || []).length}`,
    });
  }

  // 13. Offline — API returns 503, no writes
  {
    await api("/api/simulate-offline", { method: "POST", body: JSON.stringify({ offline: true }) });
    const blocked = await api("/api/delta", {
      method: "POST",
      body: JSON.stringify({
        before: baseline,
        after: { ...baseline, cp: JORDAN },
      }),
    });
    await api("/api/simulate-offline", { method: "POST", body: JSON.stringify({ offline: false }) });
    const ok = blocked.status === 503;
    record("13. Supabase/API unavailable — read-only, no writes", ok, {
      summary: `delta status=${blocked.status}`,
    });
  }

  // Cleanup test records
  console.log("\n--- Cleanup test records ---");
  const cleanupCount = await cleanupTestRecords();
  console.log(`  Removed ${cleanupCount} test ops`);

  // Final reconciliation vs original snapshot file
  console.log("\n--- Final reconciliation ---");
  const report = await runFinalReconciliation();
  const reconPass = report.passed;

  const outDir = join(process.cwd(), "backups/staging-migration-source");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `ui-test-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify({ results, reconciliation: report, generatedAt: new Date().toISOString() }, null, 2)
  );

  console.log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${passed}/${results.length} tests passed`);
  console.log(`Report: ${reportPath}`);

  process.exit(failed || !reconPass ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
