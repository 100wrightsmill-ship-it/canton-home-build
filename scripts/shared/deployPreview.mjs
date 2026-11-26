import { spawnSync } from "child_process";
import { assertVercelEnvKeys, listVercelEnv, vercelEnvTargets as envTargetsForKey } from "./vercelEnv.mjs";

export function runDeployPreview({
  label,
  localConfig,
  gateCommand,
  gateLabel,
  vercelEnvKeys,
  vercelEnvTargets: deployTargets,
  vercelSecretEnvKeys,
  setupCommand,
  buildEnvFlags = [],
}) {
  if (gateCommand) {
    console.log(gateLabel || "Running deploy gate…");
    const gate = spawnSync("node", gateCommand, { stdio: "inherit", cwd: process.cwd() });
    if (gate.status !== 0) {
      console.error("Deploy gate blocked.");
      process.exit(gate.status ?? 1);
    }
  }

  assertVercelEnvKeys(vercelEnvKeys, deployTargets, { setupCommand });

  if (vercelSecretEnvKeys?.length) {
    const data = listVercelEnv();
    const hasSecret = vercelSecretEnvKeys.some((key) =>
      envTargetsForKey(key, data).some((t) => deployTargets.includes(t))
    );
    if (!hasSecret) {
      console.error("Vercel env missing Supabase secret — set one of:");
      for (const k of vercelSecretEnvKeys) console.error(`  • ${k}`);
      console.error(`Run: ${setupCommand}`);
      process.exit(1);
    }
  }

  const args = [
    "deploy",
    "--local-config",
    localConfig,
    "--yes",
    ...buildEnvFlags.flatMap((v) => ["-b", v]),
  ];

  console.log(`${label} (credentials from Vercel project env)…`);
  const deploy = spawnSync("vercel", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: process.cwd(),
  });
  process.exit(deploy.status ?? 1);
}
