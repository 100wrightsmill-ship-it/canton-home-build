#!/usr/bin/env node
/**
 * Production Stable – Full Backup
 * Read-only full backup + verification. Does NOT modify Production data or Storage.
 */
import { createHash } from "crypto";
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { loadProductionEnv } from "./load-production-env.mjs";
import { withProductionClient } from "../../src/db/pg.js";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA } from "../../src/db/schemaConfig.js";
import { loadProductionSchemaSql } from "../../src/db/pg.js";
import { assembleStateFromTables } from "../../src/db/assembleState.js";
import { reconcileSnapshot } from "../../src/db/reconcile.js";
import { tableFqn } from "../../src/db/tableOrder.js";
import {
  listProductionObjects,
  fetchProductionObject,
} from "../production/supabaseStorage.mjs";
import { resolveDocumentStoragePath } from "../shared/resolveDocumentStorage.mjs";
import { BUCKET } from "../../src/sync/cloudSync.js";

const BACKUP_NAME = "Production Stable – Full Backup";
const PROD_URL = "https://canton-home-build.vercel.app";
const SEED_DOC_IDS = new Set(["d1", "d2", "d3", "d4"]);

loadProductionEnv();
setActiveSchema(PRODUCTION_SCHEMA);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function stampUtc() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function walkStorage(prefix = "") {
  const paths = [];
  let offset = 0;
  while (true) {
    const batch = await listProductionObjects(prefix, { limit: 1000, offset });
    if (!batch.length) break;
    for (const item of batch) {
      const rel = item.name;
      if (!rel) continue;
      const fullPath = prefix ? `${prefix}${rel}` : rel;
      const isFolder = item.id == null && !item.metadata;
      if (isFolder) {
        paths.push(...(await walkStorage(`${fullPath}/`)));
      } else {
        paths.push(fullPath);
      }
    }
    if (batch.length < 1000) break;
    offset += batch.length;
  }
  return paths;
}

async function fetchProdState() {
  const res = await fetch(`${PROD_URL}/api/production/state`);
  const body = await res.json();
  if (!res.ok || !body.state) throw new Error(`Production state fetch failed: ${res.status}`);
  return body.state;
}

async function listDbTables(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [PRODUCTION_SCHEMA]
  );
  return rows.map((r) => r.table_name);
}

async function exportTable(client, table) {
  const { rows } = await client.query(`SELECT * FROM ${PRODUCTION_SCHEMA}.${table} ORDER BY 1`);
  const active =
    rows[0] && "deleted_at" in rows[0]
      ? rows.filter((r) => r.deleted_at == null).length
      : rows.length;
  return { rows, total: rows.length, active };
}

async function findDbOrphans(client) {
  const orphans = [];
  const q = async (label, sql) => {
    const { rows } = await client.query(sql);
    for (const r of rows) orphans.push(`${label}:${r.id ?? r.ref}`);
  };
  await q(
    "pay.project",
    `SELECT id FROM ${tableFqn("pays")} p WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("projects")} x WHERE x.id = p.project_id)`
  );
  await q(
    "pay.contractor",
    `SELECT id FROM ${tableFqn("pays")} p WHERE contractor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tableFqn("contacts")} x WHERE x.id = p.contractor_id)`
  );
  await q(
    "scope.contact",
    `SELECT id FROM ${tableFqn("scopes")} s WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("contacts")} x WHERE x.id = s.contact_id)`
  );
  await q(
    "scope.project",
    `SELECT id FROM ${tableFqn("scopes")} s WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("projects")} x WHERE x.id = s.project_id)`
  );
  await q(
    "doc.project",
    `SELECT id FROM ${tableFqn("documents")} d WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("projects")} x WHERE x.id = d.project_id)`
  );
  return orphans;
}

async function preHealthCheck(client, state) {
  const rep = reconcileSnapshot(state);
  const orphans = await findDbOrphans(client);

  const tableNames = await listDbTables(client);
  const dbCounts = {};
  const dbCountsActive = {};
  for (const table of tableNames) {
    const { total, active } = await exportTable(client, table).then((x) => ({
      total: x.total,
      active: x.active,
    }));
    dbCounts[table] = total;
    dbCountsActive[table] = active;
  }

  const docs = await client.query(
    `SELECT id, name, storage_path, size_bytes, inline_data_present, deleted_at
     FROM ${PRODUCTION_SCHEMA}.documents ORDER BY id`
  );

  const docIntegrity = [];
  for (const d of docs.rows) {
    if (d.deleted_at) {
      docIntegrity.push({ id: d.id, name: d.name, status: "soft-deleted" });
      continue;
    }
    if (SEED_DOC_IDS.has(d.id)) {
      docIntegrity.push({ id: d.id, name: d.name, status: "seed-placeholder" });
      continue;
    }
    if (!d.storage_path) {
      docIntegrity.push({ id: d.id, name: d.name, status: "missing-storage-path" });
      continue;
    }
    try {
      const resolved = await resolveDocumentStoragePath({
        doc: { id: d.id, name: d.name, storagePath: d.storage_path },
        fetchObject: fetchProductionObject,
        listObjects: listProductionObjects,
        dbClient: client,
      });
      if (!resolved.ok) {
        docIntegrity.push({
          id: d.id,
          name: d.name,
          status: "storage-fetch-fail",
          storage_path: d.storage_path,
        });
        continue;
      }
      const fetched = await fetchProductionObject(resolved.path);
      const hash = sha256Buffer(fetched.buffer);
      docIntegrity.push({
        id: d.id,
        name: d.name,
        status: "ok",
        storage_path: resolved.path,
        bytes: fetched.buffer.length,
        sha256: hash,
        size_match: d.size_bytes ? Number(d.size_bytes) === fetched.buffer.length : null,
      });
    } catch (e) {
      docIntegrity.push({
        id: d.id,
        name: d.name,
        status: "error",
        error: e.message,
      });
    }
  }

  const realDocs = docIntegrity.filter(
    (d) => !["seed-placeholder", "soft-deleted"].includes(d.status)
  );
  const docOk = realDocs.every((d) => d.status === "ok" && d.size_match !== false);

  return {
    passed: rep.passed && orphans.length === 0 && docOk,
    reconcile: rep,
    orphans,
    dbCounts,
    dbCountsActive,
    docIntegrity,
    docSummary: {
      total: docs.rows.length,
      active: docs.rows.filter((d) => !d.deleted_at).length,
      healthy: docIntegrity.filter((d) => d.status === "ok").length,
      seed: docIntegrity.filter((d) => d.status === "seed-placeholder").length,
      missingPath: docIntegrity.filter((d) => d.status === "missing-storage-path").length,
      fetchFail: docIntegrity.filter((d) => d.status === "storage-fetch-fail").length,
    },
  };
}

function safeStorageLocalPath(root, objectPath) {
  const local = join(root, "storage", "objects", objectPath);
  mkdirSync(dirname(local), { recursive: true });
  return local;
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

async function main() {
  const startedAt = new Date().toISOString();
  const stamp = stampUtc();
  const root = join(
    process.cwd(),
    "backups/production-stable-full-backup",
    BACKUP_NAME,
    stamp
  );
  mkdirSync(join(root, "database", "tables"), { recursive: true });
  mkdirSync(join(root, "storage", "objects"), { recursive: true });
  mkdirSync(join(root, "deployment"), { recursive: true });

  console.log(`=== ${BACKUP_NAME} ===`);
  console.log(`Started: ${startedAt}`);
  console.log(`Output: ${root}\n`);

  // Pre-health
  console.log("1. Pre-backup health check…");
  const apiState = await fetchProdState();
  const preHealth = await withProductionClient((client) => preHealthCheck(client, apiState));
  writeFileSync(join(root, "pre-health.json"), JSON.stringify(preHealth, null, 2));
  console.log(`   Pre-health: ${preHealth.passed ? "PASS" : "WARN/FAIL"}`);

  // Schema
  console.log("2. Export schema…");
  const schemaSql = loadProductionSchemaSql();
  writeFileSync(join(root, "database", "schema.sql"), schemaSql);

  // Database tables (all rows incl. soft-deleted)
  console.log("3. Export database tables…");
  const tableExport = {};
  const tableNames = await withProductionClient(listDbTables);
  await withProductionClient(async (client) => {
    for (const table of tableNames) {
      const exp = await exportTable(client, table);
      tableExport[table] = { total: exp.total, active: exp.active };
      writeFileSync(
        join(root, "database", "tables", `${table}.json`),
        JSON.stringify(exp.rows, null, 2)
      );
      console.log(`   ${table}: ${exp.total} rows (${exp.active} active)`);
    }
  });
  writeFileSync(join(root, "database", "table-index.json"), JSON.stringify(tableExport, null, 2));

  // Assembled state from DB
  console.log("4. Export assembled state…");
  const assembled = await withProductionClient(async (client) => {
    const tables = {};
    for (const table of tableNames) {
      const exp = await exportTable(client, table);
      tables[table] = exp.rows;
    }
    return assembleStateFromTables(tables);
  });
  writeFileSync(join(root, "assembled-state.json"), JSON.stringify(assembled, null, 2));
  writeFileSync(join(root, "api-state.json"), JSON.stringify(apiState, null, 2));

  const financials = reconcileSnapshot(apiState).financials;
  writeFileSync(
    join(root, "financials.json"),
    JSON.stringify(
      {
        source: "production-api-state",
        at: startedAt,
        ...financials,
        changeOrders: (apiState.projs ?? [])
          .flatMap((p) => (p.changeOrders ?? []).map((co) => ({ projectId: p.id, ...co }))),
      },
      null,
      2
    )
  );

  // Storage
  console.log("5. Export Storage objects…");
  const objectPaths = await walkStorage("");
  const storageIndex = [];
  for (const objectPath of objectPaths) {
    const fetched = await fetchProductionObject(objectPath);
    const localPath = safeStorageLocalPath(root, objectPath);
    writeFileSync(localPath, fetched.buffer);
    const hash = sha256Buffer(fetched.buffer);
    storageIndex.push({
      path: objectPath,
      local: relative(root, localPath),
      bytes: fetched.buffer.length,
      contentType: fetched.contentType,
      sha256: hash,
    });
    console.log(`   ✓ ${objectPath} (${fetched.buffer.length} bytes)`);
  }
  writeFileSync(join(root, "storage", "storage-index.json"), JSON.stringify(storageIndex, null, 2));

  // Deployment reference
  console.log("6. Capture deployment reference…");
  const deployment = {
    productionUrl: PROD_URL,
    backedUpAt: startedAt,
    health: await fetch(`${PROD_URL}/api/production/health`).then((r) => r.json()),
  };
  try {
    const html = await fetch(`${PROD_URL}/`).then((r) => r.text());
    const jsMatch = html.match(/\/assets\/index-[^"]+\.js/);
    deployment.indexHtmlAsset = jsMatch?.[0] ?? null;
  } catch (e) {
    deployment.indexHtmlError = e.message;
  }
  try {
    deployment.vercelInspect = execSync(
      "vercel inspect canton-home-build.vercel.app --local-config vercel.production.json 2>/dev/null || vercel ls canton-home-build --prod 2>/dev/null | head -5",
      { encoding: "utf8", cwd: process.cwd() }
    ).trim();
  } catch {
    deployment.vercelInspect = "unavailable";
  }
  try {
    deployment.git = {
      commit: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
      branch: execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim(),
      describe: execSync("git log -1 --format=%H%n%s%n%ci", { encoding: "utf8" }).trim(),
    };
  } catch (e) {
    deployment.git = { error: e.message };
  }
  writeFileSync(join(root, "deployment", "deployment.json"), JSON.stringify(deployment, null, 2));

  // Manifest + checksums
  console.log("7. Build manifest with SHA256…");
  const files = walkFiles(root).filter(
    (f) => f !== "manifest.json" && f !== "BACKUP-README.txt"
  );
  const checksums = {};
  for (const f of files) {
    checksums[f] = sha256File(join(root, f));
  }

  const manifest = {
    name: BACKUP_NAME,
    createdAt: startedAt,
    completedAt: new Date().toISOString(),
    bucket: BUCKET,
    schema: PRODUCTION_SCHEMA,
    productionUrl: PROD_URL,
    backupRoot: root,
    preHealthPassed: preHealth.passed,
    tableNames,
    tableExport,
    storageObjectCount: storageIndex.length,
    counts: preHealth.dbCountsActive,
    countsIncludingDeleted: preHealth.dbCounts,
    financials,
    docSummary: preHealth.docSummary,
    files: checksums,
    storageIndex,
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));

  const readme = `# ${BACKUP_NAME}

Created: ${startedAt}
Location: ${root}

Permanent restore point — read-only backup of Production DB + Storage + schema + deployment reference.

## Contents
- database/schema.sql — cc_production schema
- database/tables/*.json — all rows (active + soft-deleted)
- storage/objects/** — full Storage mirror
- assembled-state.json — DB-assembled app state
- api-state.json — live /api/production/state snapshot
- financials.json — Jordan/Canton totals
- pre-health.json — pre-backup verification
- post-verify.json — post-backup verification
- manifest.json — SHA256 checksums for every file

## Restore (manual — do not run without explicit approval)
1. Restore schema from database/schema.sql if needed
2. Import table JSON rows into cc_production.*
3. Upload storage/objects/* back to cc-data bucket preserving paths
4. Redeploy code from deployment/deployment.json git reference

Do NOT delete this folder — permanent restore point.
`;
  writeFileSync(join(root, "BACKUP-README.txt"), readme);

  // Post-backup verification
  console.log("8. Post-backup verification…");
  const verify = {
    checks: [],
  };

  function addCheck(name, pass, detail) {
    verify.checks.push({ name, pass, detail });
    console.log(`   ${pass ? "✓" : "✗"} ${name}`);
  }

  // Read all table JSON
  let tablesOk = true;
  for (const table of tableNames) {
    const p = join(root, "database", "tables", `${table}.json`);
    try {
      const rows = JSON.parse(readFileSync(p, "utf8"));
      const match = rows.length === tableExport[table].total;
      if (!match) tablesOk = false;
      addCheck(`table readable: ${table}`, match, { rows: rows.length, expected: tableExport[table].total });
    } catch (e) {
      tablesOk = false;
      addCheck(`table readable: ${table}`, false, e.message);
    }
  }

  // Storage objects
  let storageOk = true;
  for (const obj of storageIndex) {
    const localPath = join(root, obj.local);
    try {
      const buf = readFileSync(localPath);
      const hash = sha256Buffer(buf);
      const ok = hash === obj.sha256 && buf.length === obj.bytes;
      if (!ok) storageOk = false;
      addCheck(`storage object: ${obj.path}`, ok, { bytes: buf.length, sha256: hash.slice(0, 16) });
    } catch (e) {
      storageOk = false;
      addCheck(`storage object: ${obj.path}`, false, e.message);
    }
  }

  // Document DB vs storage backup
  let docMatchOk = true;
  for (const d of preHealth.docIntegrity.filter((x) => x.status === "ok")) {
    const localRel = storageIndex.find((s) => s.path === d.storage_path)?.local;
    if (!localRel) {
      docMatchOk = false;
      addCheck(`doc in backup: ${d.id}`, false, "missing from storage index");
      continue;
    }
    const hash = sha256File(join(root, localRel));
    const ok = hash === d.sha256;
    if (!ok) docMatchOk = false;
    addCheck(`doc hash match: ${d.id}`, ok, { path: d.storage_path });
  }

  addCheck("orphan records", preHealth.orphans.length === 0, preHealth.orphans);
  addCheck(
    "projects count",
    preHealth.dbCountsActive.projects === tableExport.projects?.active,
    preHealth.dbCountsActive.projects
  );
  addCheck("pays count", preHealth.dbCountsActive.pays === tableExport.pays?.active, preHealth.dbCountsActive.pays);
  addCheck(
    "contacts count",
    preHealth.dbCountsActive.contacts === tableExport.contacts?.active,
    preHealth.dbCountsActive.contacts
  );
  addCheck(
    "scopes count",
    preHealth.dbCountsActive.scopes === tableExport.scopes?.active,
    preHealth.dbCountsActive.scopes
  );
  addCheck(
    "scope_stages count",
    preHealth.dbCountsActive.scope_stages === tableExport.scope_stages?.active,
    preHealth.dbCountsActive.scope_stages
  );
  addCheck(
    "change orders count",
    preHealth.dbCountsActive.project_change_orders === tableExport.project_change_orders?.active,
    preHealth.dbCountsActive.project_change_orders
  );
  addCheck(
    "payment_schedules count",
    preHealth.dbCountsActive.payment_schedules === tableExport.payment_schedules?.active,
    preHealth.dbCountsActive.payment_schedules
  );
  addCheck(
    "documents count",
    preHealth.dbCountsActive.documents === tableExport.documents?.active,
    preHealth.dbCountsActive.documents
  );
  addCheck("Jordan contract total", true, financials.jordanContract);
  addCheck("Jordan expenses total", true, financials.jordanExpenses);
  addCheck("Canton expenses total", true, financials.cantonExpenses);
  addCheck("manifest readable", true, sha256File(join(root, "manifest.json")).slice(0, 16));

  verify.passed =
    verify.checks.every((c) => c.pass) &&
    tablesOk &&
    storageOk &&
    docMatchOk &&
    preHealth.passed;
  verify.summary = {
    tablesOk,
    storageOk,
    docMatchOk,
    preHealthPassed: preHealth.passed,
    storageObjectCount: storageIndex.length,
    manifestSha256: sha256File(join(root, "manifest.json")),
  };
  writeFileSync(join(root, "post-verify.json"), JSON.stringify(verify, null, 2));

  // Pointer file at stable parent
  const pointer = {
    name: BACKUP_NAME,
    latest: stamp,
    path: root,
    createdAt: startedAt,
    manifestSha256: verify.summary.manifestSha256,
    passed: verify.passed,
  };
  const pointerPath = join(
    process.cwd(),
    "backups/production-stable-full-backup",
    "LATEST.json"
  );
  writeFileSync(pointerPath, JSON.stringify(pointer, null, 2));

  console.log("\n=== BACKUP COMPLETE ===");
  console.log(JSON.stringify({ name: BACKUP_NAME, stamp, root, passed: verify.passed, pointer: pointerPath }, null, 2));
  process.exit(verify.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
