#!/usr/bin/env node
/**
 * Static/unit safety tests for production cutover tooling (no DB, no network).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  assertStagingDatabaseUrl,
  assertProductionDatabaseUrl,
  requireProductionConfirmation,
  validateCutoverSource,
  buildCutoverManifest,
  assertDeployGatePassed,
  PRODUCTION_CONFIRM_ENV,
  PRODUCTION_CONFIRM_VALUE,
} from "../../src/db/safety.js";
import {
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  STAGING_SCHEMA,
  PRODUCTION_SCHEMA,
} from "../../src/db/schemaConfig.js";
import { setActiveSchema, getActiveSchema } from "../../src/db/schemaContext.js";
import {
  setForceBlockStateJson,
  assertStateJsonWriteAllowed,
  assertDbModeOnly,
} from "../../src/db/dbModeGuard.js";
import { reconcileSnapshot } from "../../src/db/reconcile.js";
import { putStorageJson, STATE_PATH } from "../../src/sync/cloudSync.js";
import { recordProductionBaseline } from "../../src/db/baseline.js";

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

function assertThrows(fn, msg, predicate) {
  try {
    fn();
    failed += 1;
    console.error("  ✗", msg, "(expected throw)");
  } catch (e) {
    if (!predicate || predicate(e)) {
      passed += 1;
      console.log("  ✓", msg);
    } else {
      failed += 1;
      console.error("  ✗", msg, `— wrong error: ${e.message}`);
    }
  }
}

async function main() {
  const stagingUrl = `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`;
  const productionUrl = `postgresql://postgres:pw@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`;

  console.log("project reference isolation");
  {
    assertThrows(
      () => assertProductionDatabaseUrl(stagingUrl),
      "production script rejects staging database URL",
      (e) => e.message.includes("staging project")
    );
    assertThrows(
      () => assertStagingDatabaseUrl(productionUrl),
      "staging script rejects production database URL",
      (e) => e.message.includes("production project")
    );
    try {
      assertProductionDatabaseUrl(productionUrl);
      assert(true, "production URL accepted");
    } catch {
      assert(false, "production URL accepted");
    }
    try {
      assertStagingDatabaseUrl(stagingUrl);
      assert(true, "staging URL accepted");
    } catch {
      assert(false, "staging URL accepted");
    }
    assert(STAGING_PROJECT_REF !== PRODUCTION_PROJECT_REF, "staging and production refs differ");
    assert(STAGING_SCHEMA !== PRODUCTION_SCHEMA, "staging and production schema names differ");
  }

  console.log("production confirmation flag");
  {
    const prev = process.env[PRODUCTION_CONFIRM_ENV];
    delete process.env[PRODUCTION_CONFIRM_ENV];
    assertThrows(
      () => requireProductionConfirmation(),
      "production scripts refuse without I_CONFIRM_PRODUCTION_CUTOVER=yes",
      (e) => e.message.includes(PRODUCTION_CONFIRM_ENV)
    );
    process.env[PRODUCTION_CONFIRM_ENV] = PRODUCTION_CONFIRM_VALUE;
    try {
      requireProductionConfirmation();
      assert(true, "production confirmation accepted when flag set");
    } catch {
      assert(false, "production confirmation accepted when flag set");
    }
    if (prev === undefined) delete process.env[PRODUCTION_CONFIRM_ENV];
    else process.env[PRODUCTION_CONFIRM_ENV] = prev;
  }

  console.log("cutover source manifest validation");
  {
    const dir = join(tmpdir(), `cc-cutover-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const snapshotPath = join(dir, "live-snapshot-test.json");
    const manifestPath = join(dir, "live-snapshot-test.manifest.json");
    const state = {
      projs: [{ id: "p1", name: "Test" }],
      pays: [],
      contacts: [],
      cloudRevision: 1,
    };
    const raw = JSON.stringify(state);
    writeFileSync(snapshotPath, raw);
    const cutoverRunId = "test-run-001";
    writeFileSync(
      manifestPath,
      JSON.stringify(buildCutoverManifest({ snapshotPath, state, cutoverRunId }), null, 2)
    );

    const valid = validateCutoverSource({ snapshotPath, manifestPath, cutoverRunId });
    assert(valid.manifest.cutoverRunId === cutoverRunId, "valid cutover source accepted");

    writeFileSync(snapshotPath, JSON.stringify({ ...state, pays: [{ id: "x" }] }));
    assertThrows(
      () => validateCutoverSource({ snapshotPath, manifestPath, cutoverRunId }),
      "modified snapshot rejected (SHA256 mismatch)",
      (e) => e.message.includes("SHA256")
    );

    writeFileSync(snapshotPath, raw);
    assertThrows(
      () => validateCutoverSource({ snapshotPath, manifestPath, cutoverRunId: "wrong-id" }),
      "wrong cutover run ID rejected",
      (e) => e.message.includes("run ID")
    );

    const stagingManifest = join(dir, "staging.manifest.json");
    writeFileSync(
      stagingManifest,
      JSON.stringify({
        purpose: "staging-migration",
        sha256: buildCutoverManifest({ snapshotPath, state, cutoverRunId: "x" }).sha256,
      }),
      null,
      2
    );
    assertThrows(
      () => validateCutoverSource({ snapshotPath, manifestPath: stagingManifest }),
      "staging migration manifest rejected for production cutover",
      (e) => e.message.includes("production-cutover")
    );

    rmSync(dir, { recursive: true, force: true });
  }

  console.log("reconciliation — dynamic baseline (no hardcoded counts)");
  {
    const snapshotPath = join(
      process.cwd(),
      "backups/staging-migration-source/live-snapshot-20261004.json"
    );
    const state = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const report = reconcileSnapshot(state);
    assert(report.passed, "oct4 snapshot self-consistency passes");
    const baseline = recordProductionBaseline(state);
    assert(baseline.counts.projects === 3, "baseline records actual project count");
    assert(baseline.counts.contacts === 19, "baseline records 19 contacts (not stale 18)");
    for (const c of report.checks) {
      assert(c.actual === c.expected, `dynamic check passes: ${c.name}`);
    }
  }

  console.log("DB mode blocks state.json writes");
  {
    setForceBlockStateJson(true);
    assertThrows(
      () => assertStateJsonWriteAllowed("test"),
      "assertStateJsonWriteAllowed throws in DB mode",
      (e) => e.message.includes("blocked")
    );
    let putBlocked = false;
    try {
      await putStorageJson(STATE_PATH, { test: 1 });
    } catch (e) {
      putBlocked = e.message.includes("blocked");
    }
    assert(putBlocked, "putStorageJson rejects state.json in DB mode");
    setForceBlockStateJson(false);
  }

  console.log("state.json mode blocks normalized DB client writes");
  {
    setForceBlockStateJson(false);
    assertThrows(
      () => assertDbModeOnly("test DB write"),
      "assertDbModeOnly throws when not in DB mode",
      (e) => e.message.includes("blocked")
    );
  }

  console.log("deploy gate blocks DB-mode deployment on reconciliation failure");
  {
    const dir = join(tmpdir(), `cc-gate-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const failReport = join(dir, "fail.json");
    const passReport = join(dir, "pass.json");
    writeFileSync(failReport, JSON.stringify({ passed: false, checks: [{ name: "db.pays", pass: false }] }));
    writeFileSync(passReport, JSON.stringify({ passed: true, checks: [{ name: "db.pays", pass: true }] }));

    assertThrows(
      () => assertDeployGatePassed(failReport),
      "deploy gate rejects failed reconciliation",
      (e) => e.message.includes("FAILED")
    );
    const ok = assertDeployGatePassed(passReport);
    assert(ok.passed === true, "deploy gate accepts passed reconciliation");

    rmSync(dir, { recursive: true, force: true });
  }

  console.log("App.jsx mode isolation (static source check)");
  {
    const appSrc = readFileSync(join(process.cwd(), "src/App.jsx"), "utf8");
    assert(appSrc.includes("isDbMode()"), "App uses isDbMode guard");
    assert(appSrc.includes("if (isDbMode()) return"), "auto-save skipped in DB mode");
    assert(appSrc.includes("productionFetchState"), "production API client wired");
    assert(appSrc.includes("isProductionDbMode()"), "production fetch gated by mode");
  }

  console.log("schema context");
  {
    setActiveSchema(PRODUCTION_SCHEMA);
    assert(getActiveSchema() === PRODUCTION_SCHEMA, "setActiveSchema switches to cc_production");
    setActiveSchema(STAGING_SCHEMA);
    assert(getActiveSchema() === STAGING_SCHEMA, "setActiveSchema restores cc_staging");
  }

  console.log("production script entrypoints require confirmation (static)");
  {
    for (const script of [
      "fetch-production-source.mjs",
      "apply-production-schema.mjs",
      "run-production-migration.mjs",
      "backup-production-storage.mjs",
      "reconcile-production.mjs",
    ]) {
      const src = readFileSync(join(process.cwd(), "scripts/db", script), "utf8");
      assert(src.includes("requireProductionConfirmation"), `${script} requires production confirmation`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
