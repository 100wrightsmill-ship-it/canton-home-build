#!/usr/bin/env node
/**
 * Post-promotion production verification (read-only + zero-edit noop).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { loadProductionEnv } from "./load-production-env.mjs";
import { withProductionClient } from "../../src/db/pg.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA, PRODUCTION_SUPABASE_URL } from "../../src/db/schemaConfig.js";
import { TABLE_INSERT_ORDER, TABLE_PRIMARY_KEY, tableFqn } from "../../src/db/tableOrder.js";
import { reconcileDatabase, reconcileSnapshot } from "../../src/db/reconcile.js";
import { computeDeltaOps } from "../../src/db/deltaApply.js";
import { snapshotSha256 } from "../../src/db/safety.js";
import { BUCKET, STATE_PATH } from "../../src/sync/cloudSync.js";
import {
  getProductionSupabaseUrl,
  getProductionServiceRoleKey,
  PRODUCTION_BUCKET,
} from "../production/supabaseStorage.mjs";

const PROD = "https://canton-home-build.vercel.app";
const GATE1_SHA256 =
  "d77974664229a0967ea9d035cd66f48cc59e3ec2283a1f6088f5f91c60759968";
const DOC_PATH =
  "documents/p1/z0nydrtms57v3b1/Elizabeth_Hunt_Proposal_21800_UPDATED.pdf";
const BASELINE = join(
  process.cwd(),
  "backups/production-cutover-source/live-snapshot-20261004061326.json"
);
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

loadProductionEnv();
setActiveSchema(PRODUCTION_SCHEMA);

const results = [];
function pass(n, msg) {
  results.push({ n, pass: true, msg });
  console.log("  ✓ PASS", n, msg);
}
function fail(n, msg) {
  results.push({ n, pass: false, msg });
  console.log("  ✗ FAIL", n, msg);
}

async function api(path, opts = {}) {
  const res = await fetch(`${PROD}/api/production${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, ok: res.ok, body };
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

async function main() {
  console.log("=== POST-PROMOTION PRODUCTION VERIFICATION ===");
  console.log(`URL: ${PROD}\n`);

  const health = await api("/health");
  if (
    health.body?.ok === true &&
    health.body?.mode === "production-db" &&
    health.body?.offline === false
  ) {
    pass("2", JSON.stringify(health.body));
  } else {
    fail("2", JSON.stringify(health.body));
  }

  await api("/simulate-offline", {
    method: "POST",
    body: JSON.stringify({ offline: false }),
  });
  const state = (await api("/state")).body.state;
  if (!state) {
    fail("3-9", "Could not fetch assembled state");
    process.exit(1);
  }

  const rep = reconcileSnapshot(state);
  const dbCounts = await withProductionClient(tableCounts);

  const countsOk =
    dbCounts.projects === EXPECTED.projects &&
    dbCounts.pays === EXPECTED.pays &&
    dbCounts.contacts === EXPECTED.contacts &&
    dbCounts.scopes === EXPECTED.scopes &&
    dbCounts.scope_stages === EXPECTED.stages &&
    dbCounts.payment_schedules === EXPECTED.payment_schedules &&
    dbCounts.documents === EXPECTED.documents;
  if (countsOk) {
    pass(
      "3",
      `${EXPECTED.projects}/${EXPECTED.pays}/${EXPECTED.contacts}/${EXPECTED.scopes}/${EXPECTED.stages}/${EXPECTED.payment_schedules}/${EXPECTED.documents}`
    );
  } else {
    fail("3", JSON.stringify(dbCounts));
  }

  const f = rep.financials;
  const numEq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
  const finOk =
    numEq(f.jordanContract, EXPECTED.jordanContract) &&
    numEq(f.jordanExpenses, EXPECTED.jordanExpenses) &&
    numEq(f.cantonExpenses, EXPECTED.cantonExpenses) &&
    numEq(f.cabinetsCo, EXPECTED.cabinetsCo) &&
    numEq(f.jordanElectrical, EXPECTED.jordanElectrical) &&
    numEq(f.elderScope, EXPECTED.elderScope);
  if (finOk) {
    pass(
      "4",
      `Jordan $${f.jordanContract} exp $${f.jordanExpenses} | Canton $${f.cantonExpenses} | CO $${f.cabinetsCo} | Elec $${f.jordanElectrical} | Elder $${f.elderScope}`
    );
  } else {
    fail("4", JSON.stringify(f));
  }

  const countsBefore = { ...dbCounts };
  await api("/audit/clear", { method: "POST" });
  const s1 = (await api("/state")).body.state;
  const noop = await api("/delta", {
    method: "POST",
    body: JSON.stringify({ before: s1, after: s1 }),
  });
  const audit = await api("/audit");
  const s2 = (await api("/state")).body.state;
  const countsAfter = await withProductionClient(tableCounts);
  const zeroEditOk =
    (noop.body.ops || []).length === 0 &&
    (audit.body.entries || []).length === 0 &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    computeDeltaOps(s1, s2).length === 0;
  if (zeroEditOk) {
    pass("5", "ops=0 audit=0 counts unchanged");
  } else {
    fail(
      "5",
      `ops=${(noop.body.ops || []).length} audit=${(audit.body.entries || []).length}`
    );
  }

  const dl = await api("/storage/fetch", {
    method: "POST",
    body: JSON.stringify({ path: DOC_PATH }),
  });
  const bytes = dl.body?.contentBase64
    ? Buffer.from(dl.body.contentBase64, "base64").length
    : 0;
  if (dl.ok && bytes > 1000) {
    pass("6", `${DOC_PATH} — ${bytes} bytes`);
  } else {
    fail("6", `status=${dl.status} bytes=${bytes}`);
  }

  const baselineState = JSON.parse(readFileSync(BASELINE, "utf8"));
  const report = await withProductionClient((c) => reconcileDatabase(c, baselineState));
  if (report.passed && report.checks.length === 37) {
    pass("7", "37/37 PASS");
  } else {
    fail(
      "7",
      `${report.checks.filter((x) => x.pass).length}/37 — ${report.checks
        .filter((x) => !x.pass)
        .map((x) => x.name)
        .join(", ")}`
    );
  }

  const key = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
  const url = (process.env.PRODUCTION_SUPABASE_URL || PRODUCTION_SUPABASE_URL).replace(
    /\/$/,
    ""
  );
  const sjRes = await fetch(`${url}/storage/v1/object/${BUCKET}/${STATE_PATH}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const sj = await sjRes.json();
  const sha = snapshotSha256(JSON.stringify(sj, null, 2));
  if (sj.cloudRevision === 9 && sj.savedAt === 1791088864949 && sha === GATE1_SHA256) {
    pass("8", "rev=9 savedAt=1791088864949 SHA256 match");
  } else {
    fail("8", `rev=${sj.cloudRevision} savedAt=${sj.savedAt} sha=${sha}`);
  }

  let testRows = 0;
  await withProductionClient(async (client) => {
    for (const table of TABLE_INSERT_ORDER) {
      const pk = TABLE_PRIMARY_KEY[table]?.[0] || "id";
      if (pk === "contact_id") {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${tableFqn(table)} WHERE contact_id LIKE $1`,
          ["test_preview_%"]
        );
        testRows += rows[0].c;
      } else if (pk === "id") {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${tableFqn(table)} WHERE id LIKE $1`,
          ["test_preview_%"]
        );
        testRows += rows[0].c;
      }
    }
  });

  const base = getProductionSupabaseUrl();
  const srk = getProductionServiceRoleKey();
  const hdr = { apikey: srk, Authorization: `Bearer ${srk}` };
  let testStorage = 0;
  for (const p of [
    "documents/zfjnvrxmo8rj9ui/test_preview_doc1/preview-test.pdf",
    "documents/zfjnvrxmo8rj9ui/test_probe/y.pdf",
    "documents/zfjnvrxmo8rj9ui/test_routing/x.pdf",
  ]) {
    const r = await fetch(`${base}/storage/v1/object/${PRODUCTION_BUCKET}/${p}`, {
      headers: hdr,
      method: "HEAD",
    });
    if (r.status === 200) testStorage++;
  }

  if (testRows === 0 && testStorage === 0) {
    pass("9", "zero TEST DB rows and Storage objects");
  } else {
    fail("9", `testRows=${testRows} testStorage=${testStorage}`);
  }

  const allPass = results.every((r) => r.pass);
  console.log("");
  console.log(allPass ? "ALL CHECKS 2-9 PASS" : "FAILURES DETECTED");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
