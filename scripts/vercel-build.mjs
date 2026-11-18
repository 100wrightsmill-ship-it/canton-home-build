#!/usr/bin/env node
/**
 * Vercel always invokes `npm run build`. Route to the correct DB-mode profile
 * via VERCEL_BUILD_PROFILE (set in vercel.*.json build.env or deploy -b flags).
 * vite.config.js reads the profile and injects import.meta.env defines.
 */
import { spawnSync } from "child_process";

const env = { ...process.env };

if (env.VERCEL_BUILD_PROFILE === "production-db") {
  env.VITE_PRODUCTION_DB_MODE = "true";
  env.VITE_PRODUCTION_API_BASE = "/api/production";
} else if (env.VERCEL_BUILD_PROFILE === "staging-db") {
  env.VITE_STAGING_DB_MODE = "true";
  env.VITE_STAGING_API_BASE = "/api/staging";
}

const result = spawnSync("vite", ["build"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
