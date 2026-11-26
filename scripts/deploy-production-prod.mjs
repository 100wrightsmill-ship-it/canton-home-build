#!/usr/bin/env node
/**
 * Production DB-mode deploy — promotes to Production alias.
 * Runtime credentials come from Vercel project env (Production target).
 * One-time setup: npm run setup:vercel:production
 */
import { spawnSync } from "child_process";
import { assertVercelEnvKeys, listVercelEnv, vercelEnvTargets } from "./shared/vercelEnv.mjs";

const vercelEnvKeys = ["PRODUCTION_DATABASE_POOLER_URL", "PRODUCTION_SUPABASE_URL"];

console.log("Running production deploy gate…");
const gate = spawnSync("node", ["scripts/db/production-deploy-gate.mjs"], {
  stdio: "inherit",
  cwd: process.cwd(),
});
if (gate.status !== 0) process.exit(gate.status ?? 1);

assertVercelEnvKeys(vercelEnvKeys, ["production"], {
  setupCommand: "npm run setup:vercel:production",
});

const vercelEnv = listVercelEnv();
const hasProdSecret =
  vercelEnvTargets("PRODUCTION_SUPABASE_SECRET_KEY", vercelEnv).includes("production") ||
  vercelEnvTargets("PRODUCTION_SUPABASE_SERVICE_ROLE_KEY", vercelEnv).includes("production");
if (!hasProdSecret) {
  console.error(
    "Vercel production missing PRODUCTION_SUPABASE_SECRET_KEY or PRODUCTION_SUPABASE_SERVICE_ROLE_KEY"
  );
  console.error("Run: npm run setup:vercel:production");
  process.exit(1);
}

const buildEnv = [
  "VERCEL_BUILD_PROFILE=production-db",
  "VITE_PRODUCTION_DB_MODE=true",
  "VITE_PRODUCTION_API_BASE=/api/production",
];

const args = [
  "deploy",
  "--prod",
  "--local-config",
  "vercel.production.json",
  "--yes",
  ...buildEnv.flatMap((v) => ["-b", v]),
];

console.log("Deploying production DB-mode to Production alias (credentials from Vercel project env)…");
const deploy = spawnSync("vercel", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  cwd: process.cwd(),
});
process.exit(deploy.status ?? 1);
