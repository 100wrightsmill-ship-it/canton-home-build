#!/usr/bin/env node
/**
 * Preview deploy for staging DB mode — cc_staging + staging Storage only.
 * Runtime credentials come from Vercel project env (Preview target).
 * One-time setup: npm run setup:vercel:staging
 */
import { runDeployPreview } from "./shared/deployPreview.mjs";

runDeployPreview({
  label: "Deploying staging DB-mode Preview (cc_staging only — not Production)",
  localConfig: "vercel.staging.json",
  gateCommand: ["scripts/db/reconcile-staging.mjs"],
  gateLabel: "Running staging reconciliation gate (cc_staging)…",
  vercelEnvKeys: [
    "STAGING_DATABASE_POOLER_URL",
    "STAGING_SUPABASE_URL",
    "STAGING_SUPABASE_SERVICE_ROLE_KEY",
  ],
  vercelEnvTargets: ["preview"],
  setupCommand: "npm run setup:vercel:staging",
  buildEnvFlags: [
    "VERCEL_BUILD_PROFILE=staging-db",
    "VITE_STAGING_DB_MODE=true",
    "VITE_STAGING_API_BASE=/api/staging",
  ],
});
