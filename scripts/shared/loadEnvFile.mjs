import { readFileSync, existsSync } from "fs";

/** Load KEY=VALUE pairs from a dotenv file (does not override process.env). */
export function loadEnvFile(path) {
  if (!existsSync(path)) {
    return { ok: false, path, vars: {} };
  }
  const vars = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return { ok: true, path, vars };
}
