#!/usr/bin/env node
/**
 * STAGING document Storage integration tests (real PDF bytes + metadata row only).
 * Requires: staging-api-server, STAGING_SUPABASE_SERVICE_ROLE_KEY in .env.staging
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadStagingEnv } from "./load-staging-env.mjs";
import { computeDeltaOps } from "../../src/db/deltaApply.js";
import { reconcileDatabase } from "../../src/db/reconcile.js";
import { withStagingClient } from "../../src/db/pg.js";
import { mapDocument } from "../../src/db/transform.js";
import { TABLE_INSERT_ORDER, TABLE_PRIMARY_KEY, tableFqn } from "../../src/db/tableOrder.js";

loadStagingEnv();

const API = process.env.STAGING_API_URL || "http://localhost:3334";
const TEST_PREFIX = "test_storage_";
const JORDAN = "zfjnvrxmo8rj9ui";
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
  const { body } = await api("/api/state");
  if (!body?.state) throw new Error("Failed to fetch state");
  return body.state;
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

async function hardDeleteTestDoc(docId, storagePath) {
  await api("/api/storage/delete", {
    method: "POST",
    body: JSON.stringify({ path: storagePath }),
  }).catch(() => {});
  await withStagingClient(async (client) => {
    await client.query(`DELETE FROM ${tableFqn("documents")} WHERE id LIKE $1`, [`${TEST_PREFIX}%`]);
  });
}

async function main() {
  console.log("=== STAGING DOCUMENT STORAGE TESTS ===\n");

  const health = await api("/api/health");
  if (!health.ok) {
    console.error("Staging API not reachable — run: npm run staging:api");
    process.exit(1);
  }

  await api("/api/storage/ensure-bucket", { method: "POST" });

  const beforeCounts = await withStagingClient((c) => tableCounts(c));
  const state0 = await fetchState();
  const testDocId = `${TEST_PREFIX}doc1`;
  const storagePath = `documents/${JORDAN}/${testDocId}/staging-test.pdf`;
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
    "utf8"
  );

  // 1. Upload PDF to STAGING Storage
  {
    const b64 = pdfBytes.toString("base64");
    const up = await api("/api/storage/upload", {
      method: "POST",
      body: JSON.stringify({
        path: storagePath,
        contentBase64: b64,
        contentType: "application/pdf",
      }),
    });
    record("1. Upload PDF to STAGING Storage", up.ok, {
      summary: `bytes=${pdfBytes.length}`,
      audit: up.body,
    });
  }

  // 2. Insert metadata row only
  {
    await api("/api/audit/clear", { method: "POST" });
    const before = await fetchState();
    const after = clone(before);
    const docRow = {
      id: testDocId,
      pid: JORDAN,
      name: "staging-test.pdf",
      type: "application/pdf",
      size: pdfBytes.length,
      storagePath,
      kind: "general",
      scopeId: "",
    };
    after.contacts = after.contacts.map((c) =>
      c.id === "test_ui_contractor1"
        ? c
        : c
    );
    // attach to project docs array shape in state
    after.docs = [...(after.docs || []), docRow];
    const delta = await api("/api/delta", {
      method: "POST",
      body: JSON.stringify({ before, after }),
    });
    const audit = await api("/api/audit");
    const docOps = (delta.body.ops || []).filter((o) => o.table === "documents");
    const onlyDocs =
      (delta.body.ops || []).length > 0 &&
      (delta.body.ops || []).every((o) => o.table === "documents");
    record("2. Insert document metadata row only", delta.ok && docOps.length === 1 && onlyDocs, {
      summary: `ops=${(delta.body.ops || []).length} tables=${[...new Set((delta.body.ops || []).map((o) => o.table))].join(",")}`,
      ops: delta.body.ops,
      audit: audit.body.entries,
    });
  }

  const afterInsertCounts = await withStagingClient((c) => tableCounts(c));
  const unrelatedChanged = Object.keys(beforeCounts).filter(
    (t) => t !== "documents" && afterInsertCounts[t] !== beforeCounts[t]
  );
  record("2b. No unrelated table writes on document insert", unrelatedChanged.length === 0, {
    summary: unrelatedChanged.length ? `changed: ${unrelatedChanged.join(",")}` : "documents only",
  });

  // 3. Refresh — document still present
  {
    const s = await fetchState();
    const doc = (s.docs || []).find((d) => d.id === testDocId);
    const ok = !!doc && doc.storagePath === storagePath;
    record("3. Refresh — document metadata persists", ok, {
      summary: doc ? doc.name : "missing",
    });
  }

  // 4. Download / open
  {
    const dl = await api("/api/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    const got = dl.body.contentBase64
      ? Buffer.from(dl.body.contentBase64, "base64")
      : null;
    const ok = got && got.equals(pdfBytes);
    record("4. Download/open — bytes match uploaded PDF", ok, {
      summary: got ? `${got.length} bytes` : "fetch failed",
    });
  }

  // 5. Replace storage object (upsert)
  {
    const replaced = Buffer.from(
      "%PDF-1.4\n% replaced staging doc\n%%EOF\n",
      "utf8"
    );
    const up = await api("/api/storage/upload", {
      method: "POST",
      body: JSON.stringify({
        path: storagePath,
        contentBase64: replaced.toString("base64"),
        contentType: "application/pdf",
        upsert: true,
      }),
    });
    const dl = await api("/api/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    const got = Buffer.from(dl.body.contentBase64 || "", "base64");
    record("5. Replace storage object (upsert)", up.ok && got.equals(replaced), {
      summary: `${got.length} bytes after replace`,
    });
  }

  // 6. Soft-delete metadata row
  {
    const before = await fetchState();
    const after = clone(before);
    after.docs = (after.docs || []).filter((d) => d.id !== testDocId);
    await api("/api/audit/clear", { method: "POST" });
    const delta = await api("/api/delta", {
      method: "POST",
      body: JSON.stringify({ before, after }),
    });
    const audit = await api("/api/audit");
    const ok =
      (delta.body.ops || []).length === 1 &&
      delta.body.ops[0].table === "documents" &&
      delta.body.ops[0].op === "soft_delete";
    record("6. Delete document — metadata soft-delete only", ok, {
      summary: `ops=${(delta.body.ops || []).length}`,
      audit: audit.body.entries,
    });
  }

  // 7. Cleanup test document (hard delete metadata + storage object)
  {
    await hardDeleteTestDoc(testDocId, storagePath);
    const s = await fetchState();
    const still = (s.docs || []).some((d) => d.id === testDocId);
    const dl = await api("/api/storage/fetch", {
      method: "POST",
      body: JSON.stringify({ path: storagePath }),
    });
    record("7. Cleanup test document only", !still && !dl.ok, {
      summary: still ? "metadata remains" : "removed",
    });
  }

  // Final reconciliation
  console.log("\n--- Final reconciliation ---");
  const snapshotPath = join(
    process.cwd(),
    "backups/staging-migration-source/live-snapshot-20261004.json"
  );
  const baselineState = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const report = await withStagingClient((client) => reconcileDatabase(client, baselineState));
  record("Final reconciliation vs baseline", report.passed, {
    summary: report.passed ? "PASS" : "FAIL",
  });

  const outDir = join(process.cwd(), "backups/staging-migration-source");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(
    outDir,
    `document-storage-test-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(
    reportPath,
    JSON.stringify({ results, reconciliation: report, generatedAt: new Date().toISOString() }, null, 2)
  );

  console.log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} tests passed`);
  console.log(`Report: ${reportPath}`);
  process.exit(results.some((r) => !r.pass) || !report.passed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
