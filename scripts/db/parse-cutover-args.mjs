import { resolve } from "path";

export function parseCutoverArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));

  let source = null;
  let manifest = null;
  let cutoverRunId = null;
  let baseline = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = resolve(argv[++i]);
    if (argv[i] === "--manifest" && argv[i + 1]) manifest = resolve(argv[++i]);
    if (argv[i] === "--cutover-run-id" && argv[i + 1]) cutoverRunId = argv[++i];
    if (argv[i] === "--baseline" && argv[i + 1]) baseline = resolve(argv[++i]);
  }

  if (!source && positional[0]) source = resolve(positional[0]);

  return {
    source,
    manifest,
    cutoverRunId,
    baseline,
    reset: flags.has("--reset"),
    dryRun: flags.has("--dry-run"),
  };
}

export function defaultProductionCutoverDir() {
  return resolve(process.cwd(), "backups/production-cutover-source");
}
