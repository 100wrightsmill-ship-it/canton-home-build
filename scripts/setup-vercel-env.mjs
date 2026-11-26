#!/usr/bin/env node
/**
 * One-time sync: local gitignored env file → Vercel project environment variables.
 * After this, deploy scripts do NOT pass credentials on the command line.
 *
 * Usage:
 *   node scripts/setup-vercel-env.mjs --profile staging
 *   node scripts/setup-vercel-env.mjs --profile production
 *   node scripts/setup-vercel-env.mjs --profile all
 */
import { join } from "path";
import { loadEnvFile } from "./shared/loadEnvFile.mjs";
import { upsertVercelEnv, listVercelEnv } from "./shared/vercelEnv.mjs";
import { assertStagingPoolerUrl } from "../src/db/safety.js";
import { assertProductionPoolerUrl } from "../src/db/safety.js";

const PROFILES = {
  staging: {
    file: ".env.staging",
    setupCommand: "npm run setup:vercel:staging",
    keys: ["STAGING_DATABASE_POOLER_URL", "STAGING_SUPABASE_URL"],
    secretKeys: ["STAGING_SUPABASE_SECRET_KEY", "STAGING_SUPABASE_SERVICE_ROLE_KEY"],
    targets: ["preview"],
    validate(vars) {
      assertStagingPoolerUrl(vars.STAGING_DATABASE_POOLER_URL);
    },
  },
  production: {
    file: ".env.production.local",
    setupCommand: "npm run setup:vercel:production",
    keys: ["PRODUCTION_DATABASE_POOLER_URL", "PRODUCTION_SUPABASE_URL"],
    secretKeys: ["PRODUCTION_SUPABASE_SECRET_KEY", "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY"],
    targets: ["preview", "production"],
    validate(vars) {
      assertProductionPoolerUrl(vars.PRODUCTION_DATABASE_POOLER_URL);
    },
  },
};

function parseProfile() {
  const i = process.argv.indexOf("--profile");
  const p = i >= 0 ? process.argv[i + 1] : "all";
  if (!p || !["staging", "production", "all"].includes(p)) {
    console.error("Usage: node scripts/setup-vercel-env.mjs --profile staging|production|all");
    process.exit(1);
  }
  return p;
}

async function syncProfile(name) {
  const profile = PROFILES[name];
  const { ok, path, vars } = loadEnvFile(join(process.cwd(), profile.file));
  if (!ok) {
    console.error(`Missing ${profile.file} — copy from example and fill in values.`);
    process.exit(1);
  }

  const missing = profile.keys.filter((k) => !vars[k]);
  const secretKeys = profile.secretKeys || [];
  const hasSecret = secretKeys.some((k) => vars[k]);
  if (missing.length) {
    console.error(`Missing in ${profile.file}:`);
    for (const k of missing) {
      if (k === "STAGING_DATABASE_POOLER_URL") {
        console.error(
          `  • ${k} — Supabase Staging → Database → Connection pooling → Transaction mode → URI`
        );
      } else {
        console.error(`  • ${k}`);
      }
    }
    process.exit(1);
  }
  if (secretKeys.length && !hasSecret) {
    console.error(`Missing Supabase server secret in ${profile.file} — set one of:`);
    for (const k of secretKeys) console.error(`  • ${k}`);
    process.exit(1);
  }

  try {
    profile.validate(vars);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`\n=== Sync ${name} credentials to Vercel (${profile.targets.join(", ")}) ===`);
  const toSync = [...profile.keys, ...(profile.secretKeys || []).filter((k) => vars[k])];
  for (const key of toSync) {
    upsertVercelEnv(key, vars[key], profile.targets);
  }
  console.log(`Done — ${name} env synced.\n`);
}

const profile = parseProfile();
const names = profile === "all" ? ["staging", "production"] : [profile];

for (const name of names) {
  await syncProfile(name);
}

console.log("Vercel environment summary:");
const summary = listVercelEnv();
for (const e of summary.envs || []) {
  console.log(`  ${e.key} → ${(e.target || []).join(", ")}`);
}

console.log("\nFuture deploys use stored Vercel env — no credentials on the CLI.");
console.log("  Staging Preview:    npm run deploy:staging:preview");
console.log("  Production Preview: npm run deploy:production:preview");
