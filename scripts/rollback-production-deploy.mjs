#!/usr/bin/env node
/**
 * One-command rollback to previous Vercel production deployment (state.json mode).
 * Does NOT modify state.json or Storage.
 *
 * Usage: node scripts/rollback-production-deploy.mjs [--yes]
 */
import { spawnSync } from "child_process";

const autoYes = process.argv.includes("--yes");
const args = ["rollback", ...(autoYes ? ["--yes"] : [])];

console.log("Rolling back Vercel production to previous deployment…");
console.log("(Restores last known-good deployment — typically state.json mode)");
console.log("");

const result = spawnSync("vercel", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error("Failed to run vercel CLI:", result.error.message);
  console.error("Install: npm i -g vercel   or run from a machine with Vercel CLI linked.");
  process.exit(1);
}

process.exit(result.status ?? 1);
