import { spawnSync } from "child_process";
import { assertVercelEnvKeys } from "./vercelEnv.mjs";

export function runDeployPreview({
  label,
  localConfig,
  gateCommand,
  gateLabel,
  vercelEnvKeys,
  vercelEnvTargets,
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

  assertVercelEnvKeys(vercelEnvKeys, vercelEnvTargets, { setupCommand });

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
