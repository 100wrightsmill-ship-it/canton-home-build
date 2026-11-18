#!/usr/bin/env node
/**
 * Preview deploy for production DB mode — transaction pooler for serverless DB access.
 * Runtime credentials come from Vercel project env (Preview target).
 * One-time setup: npm run setup:vercel:production
 */
import { runDeployPreview } from "./shared/deployPreview.mjs";

runDeployPreview({
  label: "Deploying production DB-mode Preview (not promoting to Production)",
  localConfig: "vercel.production.json",
  gateCommand: ["scripts/db/production-deploy-gate.mjs"],
  gateLabel: "Running production deploy gate…",
  vercelEnvKeys: [
    "PRODUCTION_DATABASE_POOLER_URL",
    "PRODUCTION_SUPABASE_URL",
    "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY",
  ],
  vercelEnvTargets: ["preview"],
  setupCommand: "npm run setup:vercel:production",
  buildEnvFlags: [
    "VERCEL_BUILD_PROFILE=production-db",
    "VITE_PRODUCTION_DB_MODE=true",
    "VITE_PRODUCTION_API_BASE=/api/production",
  ],
});
