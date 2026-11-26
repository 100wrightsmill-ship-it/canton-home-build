#!/usr/bin/env node
/**
 * Fail if tracked files contain hardcoded Supabase JWTs or sb_secret literals.
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

const patterns = [
  { re: /eyJhbGciOiJIUzI1NiIs[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, label: "JWT" },
  { re: /sb_secret_[A-Za-z0-9_-]+/, label: "sb_secret" },
];

const files = execSync("git ls-files", { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const failures = [];
for (const file of files) {
  if (file.includes("test-no-committed-secrets")) continue;
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { re, label } of patterns) {
    if (re.test(text)) failures.push({ file, label });
  }
}

if (failures.length) {
  console.error("Committed secrets check FAILED:");
  for (const f of failures) console.error(`  • ${f.file} (${f.label})`);
  process.exit(1);
}
console.log("Committed secrets check PASSED (no JWT / sb_secret in tracked files)");