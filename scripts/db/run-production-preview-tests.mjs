#!/usr/bin/env node
/**
 * Production DB-mode Preview verification against cc_production (TEST records only).
 *
 * Usage:
 *   PRODUCTION_PREVIEW_URL=https://xxx.vercel.app \
 *   PRODUCTION_PREVIEW_DEPLOYMENT=dpl_xxx \
 *   node scripts/db/run-production-preview-tests.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { loadProductionEnv } from "./load-production-env.mjs";
import { computeDeltaOps } from "../../src/db/deltaApply.js";
import { reconcileDatabase, reconcileSnapshot } from "../../src/db/reconcile.js";
import { withProductionClient } from "../../src/db/pg.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA, PRODUCTION_SUPABASE_URL } from "../../src/db/schemaConfig.js";
import { TABLE_INSERT_ORDER, TABLE_PRIMARY_KEY, tableFqn } from "../../src/db/tableOrder.js";
import { snapshotSha256 } from "../../src/db/safety.js";
import { BUCKET, STATE_PATH } from "../../src/sync/cloudSync.js";

loadProductionEnv();
setActiveSchema(PRODUCTION_SCHEMA);

const PREVIEW_URL = (process.env.PRODUCTION_PREVIEW_URL || process.argv[2] || "").replace(/\/$/, "");
const PREVIEW_DEPLOYMENT = process.env.PRODUCTION_PREVIEW_DEPLOYMENT || process.argv[3] || "";
const API = PREVIEW_URL ? `${PREVIEW_URL}/api/production` : "";
const USE_VERCEL_CURL = Boolean(PREVIEW_DEPLOYMENT);
const TEST_PREFIX = "test_preview_";
const JORDAN = "zfjnvrxmo8rj9ui";
const BASELINE_SNAPSHOT = join(
  process.cwd(),
  "backups/production-cutover-source/live-snapshot-20261004061326.json"
);
const GATE1_SHA256 = "d77974664229a0967ea9d035cd66f48cc59e3ec2283a1f6088f5f91c60759968";
const GATE1_REVISION = 9;
const GATE1_SAVED_AT = 1791088864949;

const EXPECTED = {
  projects: 3,
  pays: 81,
  contacts: 19,
  scopes: 24,
  stages: 60,
  payment_schedules: 29,
  documents: 16,
  jordanContract: 67575,
  jordanExpenses: 40393,
  cantonExpenses: 134937,
  cabinetsCo: 9450,
  jordanElectrical: 49000,
  elderScope: 1500,
};

const results = [];

function record(name, pass, detail = {}) {
  results.push({ name, pass, ...detail });
  console.log(pass ? "  ✓ PASS" : "  ✗ FAIL", name, detail.summary || "");
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function canonicalJson(state) {
  return JSON.stringify(state, null, 2);
}

function numEq(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

function countAssembledDocuments(state) {
  const ids = new Set();
  for (const d of state.docs ?? []) ids.add(d.id);
  for (const c of state.contacts ?? []) {
    for (const d of c.docs ?? []) ids.add(d.id);
  }
  return ids.size;
}

function extractCurlBody(raw) {
  if (!raw) return "";
  const htmlIdx = raw.indexOf("<!DOCTYPE");
  if (htmlIdx >= 0) return raw.slice(htmlIdx);
  const fnIdx = raw.search(/(\(function|import\s)/);
  if (fnIdx >= 0) return raw.slice(fnIdx);
  const jsonMatch = raw.match(/\{[\s\S]*\}\s*$/);
  return jsonMatch ? jsonMatch[0] : raw.trim();
}

function vercelFetchText(path) {
  const result = spawnSync(
    "vercel",
    ["curl", path, "--deployment", PREVIEW_DEPLOYMENT, "--", "--silent", "--show-error"],
    { encoding: "utf8", cwd: process.cwd() }
  );
  return extractCurlBody(result.stdout || "");
}

function vercelCurl(path, options = {}) {
  const args = [
    "curl",
    `/api/production${path}`,
    "--deployment",
    PREVIEW_DEPLOYMENT,
    "--",
    "--silent",
    "--show-error",
    "--write-out",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (options.method && options.method !== "GET") args.push("--request", options.method);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
  if (options.body) args.push("--data", options.body);
  const result = spawnSync("vercel", args, { encoding: "utf8", cwd: process.cwd() });
  const raw = result.stdout || "";
  const statusMatch = raw.match(/__HTTP_STATUS__:(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : result.status || 500;
  const text = raw.replace(/\n__HTTP_STATUS__:\d+$/, "").trim();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status, body, ok: status >= 200 && status < 300, contentType: "application/json" };
}

async function api(path, options = {}) {
  if (USE_VERCEL_CURL) return vercelCurl(path, options);
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, body, ok: res.ok, contentType: res.headers.get("content-type") };
}

function authHeaders() {
  const key =
    process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing PRODUCTION_SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function fetchLiveStateJson() {
  const url = `${(process.env.PRODUCTION_SUPABASE_URL || PRODUCTION_SUPABASE_URL).replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${STATE_PATH}`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`state.json fetch failed: ${res.status}`);
  return res.json();
}

async function tableCounts(client) {
  const counts = {};
  for (const table of TABLE_INSERT_ORDER) {
    const where = table === "contact_projects" ? "" : " WHERE deleted_at IS NULL";
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM ${tableFqn(table)}${where}`
    );
    counts[table] = rows[0].c;
  }
  return counts;
}

async function fetchState() {
  await api("/simulate-offline", {
    method: "POST",
    body: JSON.stringify({ offline: false }),
  });
  const { body, status, contentType } = await api("/state");
  if (!body?.state) {
    throw new Error(`/state failed (${status}, ${contentType}): ${JSON.stringify(body)}`);
  }
  return body.state;
}

async function applyDelta(before, after) {
  const clear = await api("/audit/clear", { method: "POST" });
  if (!clear.ok) {
    throw new Error(
      `audit/clear failed (${clear.status}): ${clear.body.error || clear.body._raw || "unknown"}`
    );
  }
  const { body, status, ok } = await api("/delta", {
    method: "POST",
    body: JSON.stringify({ before, after }),
  });
  if (!ok) {
    throw new Error(`delta failed (${status}): ${body.error || body._raw || "unknown"}`);
  }
  const audit = await api("/audit");
  if (!audit.ok) {
    throw new Error(`audit fetch failed (${audit.status}): ${audit.body.error || audit.body._raw || "unknown"}`);
  }
  return { ops: body.ops || [], applied: body.applied, status, audit: audit.body.entries || [] };
}

async function hardDeleteTestRecords() {
  return withProductionClient(async (client) => {
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
  await api("/simulate-offline", {
    method: "POST",
    body: JSON.stringify({ offline: false }),
  });
  return hardDeleteTestRecords();
}

async function verifyBundle() {
  const html = USE_VERCEL_CURL ? vercelFetchText("/") : await fetch(`${PREVIEW_URL}/`).then((r) => r.text());
  const jsMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
  if (!jsMatch) {
    record("2. Bundle — DB mode (/api/production)", false, {
      summary: "no index-*.js in HTML",
    });
    return;
  }
  const js = USE_VERCEL_CURL
    ? vercelFetchText(jsMatch[1])
    : await fetch(`${PREVIEW_URL}${jsMatch[1]}`).then((r) => r.text());
  const ok =
    js.includes("/api/production") &&
    !js.includes("/production-api") &&
    (js.includes('VITE_PRODUCTION_DB_MODE)==="true"') || js.includes("/api/production"));
  record("2. Bundle — DB mode (/api/production)", ok, {
    summary: ok ? jsMatch[1] : "missing DB mode markers",
  });
}

async function main() {
  if (!PREVIEW_URL) {
    console.error(
      "Usage: PRODUCTION_PREVIEW_URL=... PRODUCTION_PREVIEW_DEPLOYMENT=dpl_... node scripts/db/run-production-preview-tests.mjs"
    );
    process.exit(1);
  }

  console.log("=== PRODUCTION PREVIEW VERIFICATION ===");
  console.log(`Preview URL: ${PREVIEW_URL}`);
  console.log(`Deployment:  ${PREVIEW_DEPLOYMENT || "(direct fetch)"}\n`);

  const stateJsonBefore = await fetchLiveStateJson();
  const shaBefore = snapshotSha256(canonicalJson(stateJsonBefore));

  {
    const health = await api("/health");
    const ok =
      health.ok &&
      health.body?.ok === true &&
      health.body?.mode === "production-db";
    record("1. /api/production/health — JSON mode: production-db", ok, {
      summary: ok ? "production-db" : JSON.stringify(health.body).slice(0, 80),
    });
  }

  await verifyBundle();

  const dbCounts = await withProductionClient((c) => tableCounts(c));
  let state = await fetchState();
  const baselineRep = reconcileSnapshot(state);
  const uiDocCount = countAssembledDocuments(state);

  {
    const ok =
      dbCounts.projects === EXPECTED.projects &&
      dbCounts.pays === EXPECTED.pays &&
      dbCounts.contacts === EXPECTED.contacts &&
      dbCounts.scopes === EXPECTED.scopes &&
      dbCounts.scope_stages === EXPECTED.stages &&
      dbCounts.payment_schedules === EXPECTED.payment_schedules;
    record("2. DB baseline counts — 3/81/19/24/60/29", ok, {
      summary: `projs=${dbCounts.projects} pays=${dbCounts.pays} contacts=${dbCounts.contacts} scopes=${dbCounts.scopes} stages=${dbCounts.scope_stages} pmts=${dbCounts.payment_schedules}`,
    });
  }

  {
    const ok = dbCounts.documents === EXPECTED.documents;
    record("3. DB document rows — Gate 1 baseline", ok, {
      summary: `db_documents=${dbCounts.documents} expected=${EXPECTED.documents}`,
    });
  }

  {
    const ok = uiDocCount === dbCounts.documents;
    record("4. Assembled UI documents match DB rows", ok, {
      summary: `ui_unique=${uiDocCount} db_rows=${dbCounts.documents}`,
    });
  }

  {
    const f = baselineRep.financials;
    const ok =
      numEq(f.jordanContract, EXPECTED.jordanContract) &&
      numEq(f.jordanExpenses, EXPECTED.jordanExpenses) &&
      numEq(f.cantonExpenses, EXPECTED.cantonExpenses) &&
      numEq(f.cabinetsCo, EXPECTED.cabinetsCo) &&
      numEq(f.jordanElectrical, EXPECTED.jordanElectrical) &&
      numEq(f.elderScope, EXPECTED.elderScope);
    record("5. Financial totals — Jordan/Canton/CO/Electrical/Elder", ok, {
      summary: `Jordan $${f.jordanContract} exp $${f.jordanExpenses} | Canton exp $${f.cantonExpenses} | CO $${f.cabinetsCo} | Elec $${f.jordanElectrical} | Elder $${f.elderScope}`,
    });
  }

  {
    const ok = baselineRep.duplicateIds.length === 0 && baselineRep.orphans.length === 0;
    record("6. Zero orphan FKs and duplicate IDs", ok, {
      summary: `orphans=${baselineRep.orphans.length} dups=${baselineRep.duplicateIds.length}`,
    });
  }

  {
    const countsBefore = await withProductionClient((c) => tableCounts(c));
    const s1 = await fetchState();
    await api("/audit/clear", { method: "POST" });
    const noop = await api("/delta", {
      method: "POST",
      body: JSON.stringify({ before: s1, after: s1 }),
    });
    const audit = await api("/audit");
    const s2 = await fetchState();
    const countsAfter = await withProductionClient((c) => tableCounts(c));
    const ok =
      (noop.body.ops || []).length === 0 &&
      (audit.body.entries || []).length === 0 &&
      JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
      computeDeltaOps(s1, s2).length === 0;
    record("7. Zero-edit refresh — zero DB mutations", ok, {
      summary: `ops=${(noop.body.ops || []).length} audit=${(audit.body.entries || []).length}`,
    });
  }

  const testContactId = `${TEST_PREFIX}contractor1`;
  const testScopeId = `${TEST_PREFIX}scope1`;
  const testStageId = `${TEST_PREFIX}stage1`;
  const testPayId = `${TEST_PREFIX}pay1`;
  const testCoId = `${TEST_PREFIX}co1`;
  const testPmtId = `${TEST_PREFIX}pmt1`;
  const testDocId = `${TEST_PREFIX}doc1`;
  const storagePath = `documents/${JORDAN}/${testDocId}/preview-test.pdf`;
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
    "utf8"
  );
  const pdfReplaced = Buffer.from(
    "%PDF-1.4\n% preview replaced doc\n%%EOF\n",
    "utf8"
  );

  {
    const after = clone(state);
    after.contacts = [
      ...after.contacts,
      {
        id: testContactId,
        name: "Preview Test Contractor",
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
    const { ops } = await applyDelta(state, after);
    record("8. Create — TEST contact + junction", ops.some((o) => o.table === "contacts"), {
      summary: `ops=${ops.length}`,
    });
    state = await fetchState();
  }

  {
    const after = clone(state);
    after.contacts = after.contacts.map((c) =>
      c.id === testContactId
        ? {
            ...c,
            scopes: [
              {
                id: testScopeId,
                pid: JORDAN,
                phId: "",
                title: "Preview Test Scope",
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
    const { ops } = await applyDelta(state, after);
    const ok =
      ops.filter((o) => o.op === "insert" && o.table === "scopes").length === 1 &&
      ops.filter((o) => o.op === "insert" && o.table === "scope_stages").length === 1;
    record("9. Create — TEST scope + stage", ok, { summary: `ops=${ops.length}` });
    state = await fetchState();
  }

  {
    const after = clone(state);
    after.pays = [
      ...after.pays,
      {
        id: testPayId,
        pid: JORDAN,
        date: "2026-10-04",
        amt: 123.45,
        to: "Preview Test Vendor",
        method: "Check",
        cat: "Test",
        costCat: "materials",
        contractorId: testContactId,
        scopeId: testScopeId,
        source: "cost",
      },
    ];
    const { ops } = await applyDelta(state, after);
    record("10. Create — TEST expense", ops.length === 1 && ops[0].table === "pays", {
      summary: `ops=${ops.length}`,
    });
    state = await fetchState();
  }

  {
    const after = clone(state);
    after.pays = after.pays.map((p) =>
      p.id === testPayId ? { ...p, amt: 200, notes: "edited" } : p
    );
    const { ops } = await applyDelta(state, after);
    record("11. Edit — TEST expense", ops.length === 1 && ops[0].op === "update", {
      summary: `ops=${ops.length}`,
    });
    state = await fetchState();
  }

  {
    const after = clone(state);
    after.pays = after.pays.filter((p) => p.id !== testPayId);
    const { ops } = await applyDelta(state, after);
    record("12. Delete — TEST expense soft-delete", ops.length === 1 && ops[0].op === "soft_delete", {
      summary: `ops=${ops.length}`,
    });
    state = await fetchState();
  }

  {
    const s = await fetchState();
    const a = clone(s);
    const b = clone(s);
    a.contacts = a.contacts.map((c) =>
      c.id === testContactId ? { ...c, phone: "edit-a" } : c
    );
    b.contacts = b.contacts.map((c) =>
      c.id === testContactId ? { ...c, phone: "edit-b" } : c
    );
    const r1 = await api("/delta", {
      method: "POST",
      body: JSON.stringify({ before: s, after: a }),
    });
    const r2 = await api("/delta", {
      method: "POST",
      body: JSON.stringify({ before: s, after: b }),
    });
    record("13. Same-record concurrency — second write rejected", r1.ok && !r2.ok && r2.status === 409, {
      summary: `first=${r1.status} second=${r2.status}`,
    });
    state = await fetchState();
  }

  {
    const up = await api("/storage/upload", {
      method: "POST",
      body: JSON.stringify({
        path: storagePath,
        contentBase64: pdfBytes.toString("base64"),
        contentType: "application/pdf",
      }),
    });
    record("14. Document — Storage upload (PUT)", up.ok && !up.body._raw?.includes("NOT_FOUND"), {
      summary: up.ok ? `${pdfBytes.length} bytes` : up.body.error || up.body._raw || `status ${up.status}`,
    });

    const before = await fetchState();
    const after = clone(before);
    after.docs = [
      ...(after.docs || []),
      {
        id: testDocId,
        pid: JORDAN,
        name: "preview-test.pdf",
        type: "application/pdf",
        size: pdfBytes.length,
        storagePath,
        kind: "general",
        scopeId: testScopeId,
        data: null,
      },
    ];
    const delta = await applyDelta(before, after);
    record("15. Document — metadata row insert", delta.ops.filter((o) => o.table === "documents").length === 1, {
      summary: `ops=${delta.ops.length}`,
    });

    const refreshed = await fetchState();
    const found =
      [...(refreshed.docs || []), ...refreshed.contacts.flatMap((c) => c.docs || [])].some(
        (d) => d.id === testDocId && d.storagePath === storagePath
      );
    record("16. Document — refresh shows metadata", found, {
      summary: found ? testDocId : "missing after refresh",
    });

    const dl = await api("/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    const got = dl.body.contentBase64 ? Buffer.from(dl.body.contentBase64, "base64") : null;
    record("17. Document — fetch/download bytes match", got?.equals(pdfBytes), {
      summary: got ? `${got.length} bytes` : dl.body.error || "fetch failed",
    });

    const up2 = await api("/storage/upload", {
      method: "POST",
      body: JSON.stringify({
        path: storagePath,
        contentBase64: pdfReplaced.toString("base64"),
        contentType: "application/pdf",
        upsert: true,
      }),
    });
    const dl2 = await api("/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    const got2 = dl2.body.contentBase64 ? Buffer.from(dl2.body.contentBase64, "base64") : null;
    record("18. Document — replace (upsert) + fetch", up2.ok && got2?.equals(pdfReplaced), {
      summary: got2 ? `${got2.length} bytes after replace` : "replace/fetch failed",
    });

    const beforeDel = await fetchState();
    const afterDel = clone(beforeDel);
    afterDel.docs = (afterDel.docs || []).filter((d) => d.id !== testDocId);
    const delDelta = await applyDelta(beforeDel, afterDel);
    const metaDeleted = delDelta.ops.some(
      (o) => o.table === "documents" && o.op === "soft_delete"
    );
    const delStorage = await api("/storage/delete", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    const dl3 = await api("/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    record("19. Document — metadata soft-delete + storage delete", metaDeleted && delStorage.ok && !dl3.ok, {
      summary: `meta=${metaDeleted} storage=${delStorage.ok} fetch_gone=${!dl3.ok}`,
    });
    state = await fetchState();
  }

  console.log("\n--- Cleanup TEST records ---");
  const cleanupCount = await cleanupTestRecords();
  console.log(`  Removed ${cleanupCount} test rows`);

  console.log("\n--- Cleanup smoke Storage objects ---");
  for (const smokePath of [
    "documents/zfjnvrxmo8rj9ui/test_probe/y.pdf",
    "documents/zfjnvrxmo8rj9ui/test_routing/x.pdf",
  ]) {
    const del = await api("/storage/delete", {
      method: "POST",
      body: JSON.stringify({ path: smokePath }),
    });
    console.log(`  ${smokePath}: ${del.ok ? "deleted" : `status ${del.status}`}`);
  }

  console.log("\n--- Final reconciliation ---");
  const baselineState = JSON.parse(readFileSync(BASELINE_SNAPSHOT, "utf8"));
  const report = await withProductionClient((client) => reconcileDatabase(client, baselineState));
  record("20. Final reconciliation vs Gate 1 baseline", report.passed, {
    summary: report.passed ? "PASS" : "FAIL",
  });

  {
    const stateJsonAfter = await fetchLiveStateJson();
    const shaAfter = snapshotSha256(canonicalJson(stateJsonAfter));
    const ok =
      stateJsonAfter.cloudRevision === GATE1_REVISION &&
      stateJsonAfter.savedAt === GATE1_SAVED_AT &&
      shaAfter === GATE1_SHA256 &&
      shaAfter === shaBefore;
    record("21. state.json — zero writes", ok, {
      summary: `rev=${stateJsonAfter.cloudRevision} savedAt=${stateJsonAfter.savedAt}`,
    });
  }

  const outDir = join(process.cwd(), "backups/production-cutover");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(
    outDir,
    `preview-test-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        previewUrl: PREVIEW_URL,
        deploymentId: PREVIEW_DEPLOYMENT,
        results,
        reconciliation: report,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  console.log(`Report: ${reportPath}`);

  process.exit(failed || !report.passed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
