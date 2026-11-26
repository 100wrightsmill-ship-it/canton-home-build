import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  PRODUCTION_SCHEMA,
  STAGING_SCHEMA,
} from "./schemaConfig.js";
import { getActiveSchema } from "./schemaContext.js";
import { resolveProductionSupabaseSecret } from "./supabaseKeys.js";

export const PRODUCTION_CONFIRM_ENV = "I_CONFIRM_PRODUCTION_CUTOVER";
export const PRODUCTION_CONFIRM_VALUE = "yes";

export function requireProductionConfirmation() {
  if (process.env[PRODUCTION_CONFIRM_ENV] !== PRODUCTION_CONFIRM_VALUE) {
    throw new Error(
      `Production operation blocked. Set ${PRODUCTION_CONFIRM_ENV}=${PRODUCTION_CONFIRM_VALUE} to proceed.`
    );
  }
}

/** DB-mode API storage writes — service role on server; cutover scripts use requireProductionConfirmation instead. */
export function assertProductionApiStorageWriteAllowed() {
  if (process.env[PRODUCTION_CONFIRM_ENV] === PRODUCTION_CONFIRM_VALUE) return;
  const key = resolveProductionSupabaseSecret();
  if (!key) {
    throw new Error(
      "Production storage write blocked: PRODUCTION_SUPABASE_SECRET_KEY or PRODUCTION_SUPABASE_SERVICE_ROLE_KEY required for API storage operations"
    );
  }
}

export function extractProjectRefFromDatabaseUrl(url) {
  if (!url) return null;
  const poolerUser = url.match(/postgresql:\/\/postgres\.([a-z0-9]+):/i);
  if (poolerUser) return poolerUser[1];
  const hostMatch = url.match(/@db\.([^.]+)\.supabase\.co/i);
  if (hostMatch) return hostMatch[1];
  const urlMatch = url.match(/([a-z0-9]{20})\.supabase\.co/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

export function assertProductionPoolerUrl(url) {
  if (!url) {
    throw new Error("Production serverless blocked: PRODUCTION_DATABASE_POOLER_URL is required");
  }
  if (!url.includes("pooler.supabase.com") || !url.includes(":6543")) {
    throw new Error(
      "Production serverless blocked: pooler URL must use shared transaction pooler (pooler.supabase.com:6543)"
    );
  }
  assertProductionDatabaseUrl(url);
}

export function assertStagingPoolerUrl(url) {
  if (!url) {
    throw new Error("Staging serverless blocked: STAGING_DATABASE_POOLER_URL is required");
  }
  if (!url.includes(":6543")) {
    throw new Error("Staging serverless blocked: pooler URL must use port 6543");
  }
  const ref = extractProjectRefFromDatabaseUrl(url);
  if (ref !== STAGING_PROJECT_REF) {
    throw new Error(
      `Staging serverless blocked: pooler URL must use staging project (${STAGING_PROJECT_REF}), got ${ref}`
    );
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new Error("Staging serverless blocked: pooler URL points at production project");
  }
}

export function assertStagingDatabaseUrl(url) {
  const ref = extractProjectRefFromDatabaseUrl(url);
  if (!ref) {
    throw new Error("Staging operation blocked: could not parse database URL project reference");
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new Error(
      `Staging operation blocked: database URL points to production project (${PRODUCTION_PROJECT_REF})`
    );
  }
  if (ref !== STAGING_PROJECT_REF) {
    throw new Error(
      `Staging operation blocked: database URL must use staging project (${STAGING_PROJECT_REF}), got ${ref}`
    );
  }
}

export function assertProductionDatabaseUrl(url) {
  const ref = extractProjectRefFromDatabaseUrl(url);
  if (!ref) {
    throw new Error("Production operation blocked: could not parse database URL project reference");
  }
  if (ref === STAGING_PROJECT_REF) {
    throw new Error(
      `Production operation blocked: database URL points to staging project (${STAGING_PROJECT_REF})`
    );
  }
  if (ref !== PRODUCTION_PROJECT_REF) {
    throw new Error(
      `Production operation blocked: database URL must use production project (${PRODUCTION_PROJECT_REF}), got ${ref}`
    );
  }
}

export function assertStagingSupabaseUrl(url) {
  if (!url) return;
  if (url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("Staging operation blocked: Supabase URL points to production project");
  }
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error("Staging operation blocked: Supabase URL must point to staging project");
  }
}

export function assertProductionSupabaseUrl(url) {
  if (!url) return;
  if (url.includes(STAGING_PROJECT_REF)) {
    throw new Error("Production operation blocked: Supabase URL points to staging project");
  }
  if (!url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("Production operation blocked: Supabase URL must point to production project");
  }
}

export function assertActiveProductionSchema() {
  if (getActiveSchema() !== PRODUCTION_SCHEMA) {
    throw new Error(
      `Production operation blocked: active schema is ${getActiveSchema()}, expected ${PRODUCTION_SCHEMA}`
    );
  }
}

export function assertActiveStagingSchema() {
  if (getActiveSchema() !== STAGING_SCHEMA) {
    throw new Error(
      `Staging operation blocked: active schema is ${getActiveSchema()}, expected ${STAGING_SCHEMA}`
    );
  }
}

export function snapshotSha256(content) {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Migration source must be the fresh snapshot from the same cutover run (manifest + SHA256).
 */
export function validateCutoverSource({ snapshotPath, manifestPath, cutoverRunId }) {
  if (!existsSync(snapshotPath)) {
    throw new Error(`Cutover source missing: ${snapshotPath}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Cutover manifest missing: ${manifestPath}. Run fetch-source for this cutover run first.`);
  }

  const raw = readFileSync(snapshotPath, "utf8");
  const hash = snapshotSha256(raw);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.purpose !== "production-cutover") {
    throw new Error(
      `Invalid manifest purpose: ${manifest.purpose}. Expected production-cutover snapshot, not staging migration source.`
    );
  }

  if (manifest.sha256 !== hash) {
    throw new Error("Snapshot SHA256 does not match cutover manifest — file was modified or wrong snapshot");
  }

  const resolvedSnapshot = resolve(snapshotPath);
  if (manifest.snapshotPath && resolve(manifest.snapshotPath) !== resolvedSnapshot) {
    throw new Error("Snapshot path does not match manifest.snapshotPath");
  }

  if (cutoverRunId && manifest.cutoverRunId !== cutoverRunId) {
    throw new Error(
      `Cutover run ID mismatch: manifest=${manifest.cutoverRunId}, requested=${cutoverRunId}`
    );
  }

  if (!manifest.cutoverRunId) {
    throw new Error("Cutover manifest missing cutoverRunId");
  }

  return { manifest, hash, state: JSON.parse(raw) };
}

export function buildCutoverManifest({ snapshotPath, state, cutoverRunId, fetchedAt }) {
  const raw = readFileSync(snapshotPath, "utf8");
  return {
    purpose: "production-cutover",
    cutoverRunId,
    fetchedAt: fetchedAt || new Date().toISOString(),
    snapshotPath: resolve(snapshotPath),
    sha256: snapshotSha256(raw),
    source: "cc-data/state.json (production read-only GET)",
    cloudRevision: state.cloudRevision ?? null,
    savedAt: state.savedAt ?? null,
  };
}

export function assertDeployGatePassed(reportPath) {
  if (!existsSync(reportPath)) {
    throw new Error(`Deploy gate blocked: reconciliation report not found at ${reportPath}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (!report.passed) {
    const failed = (report.checks || []).filter((c) => !c.pass).map((c) => c.name);
    throw new Error(
      `Deploy gate blocked: reconciliation FAILED (${failed.length} checks). DB mode deploy aborted.`
    );
  }
  return report;
}
