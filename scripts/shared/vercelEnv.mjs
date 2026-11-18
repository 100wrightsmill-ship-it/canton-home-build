import { spawnSync } from "child_process";

/** @returns {{ envs: Array<{ key: string, target: string[] }> }} */
export function listVercelEnv() {
  const result = spawnSync("vercel", ["env", "ls", "--format", "json"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error(
      `vercel env ls failed: ${(result.stderr || result.stdout || "").trim() || "unknown error"}`
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Could not parse vercel env ls JSON output");
  }
}

export function vercelEnvTargets(key, data = listVercelEnv()) {
  const targets = new Set();
  for (const entry of data.envs || []) {
    if (entry.key !== key) continue;
    for (const t of entry.target || []) targets.add(t);
  }
  return [...targets];
}

export function assertVercelEnvKeys(keys, targets, { setupCommand }) {
  const data = listVercelEnv();
  const missing = [];
  for (const key of keys) {
    const have = vercelEnvTargets(key, data);
    for (const t of targets) {
      if (!have.includes(t)) {
        missing.push(`${key} → ${t}`);
      }
    }
  }
  if (missing.length) {
    console.error("Vercel environment is missing required variables:");
    for (const m of missing) console.error(`  • ${m}`);
    console.error(`\nRun once: ${setupCommand}`);
    process.exit(1);
  }
}

export function upsertVercelEnv(key, value, targets) {
  for (const target of targets) {
    // Preview: empty git-branch arg = all Preview branches (Vercel CLI non-interactive workaround).
    const args = ["env", "add", key, target];
    if (target === "preview") args.push("");
    if (target === "development") {
      args.push("--value", value, "--yes", "--force", "--no-sensitive");
    } else {
      args.push("--value", value, "--yes", "--force", "--sensitive");
    }

    const add = spawnSync("vercel", args, { encoding: "utf8", cwd: process.cwd() });
    if (add.status !== 0) {
      const msg = (add.stderr || add.stdout || "").trim();
      throw new Error(`vercel env add ${key} ${target} failed: ${msg || "unknown error"}`);
    }
    console.log(`  ✓ ${key} → ${target}${target === "preview" ? " (all branches)" : ""}`);
  }
}
