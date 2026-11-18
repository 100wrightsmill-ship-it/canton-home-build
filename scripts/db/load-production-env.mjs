import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Load .env.production.local into process.env (does not override existing env vars).
 */
export function loadProductionEnv() {
  const path = join(process.cwd(), ".env.production.local");
  if (!existsSync(path)) return { loaded: false, path };
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
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
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return { loaded: true, path };
}
