/**
 * Apply approved Hebrew repairs to localhost cc_data_v1 only.
 * Reads Jul 29 snapshot, applies exact replacements from hebrew-repair-plan.json,
 * verifies financial/project data unchanged, emits localhost inject page.
 *
 * Usage: node scripts/apply-hebrew-repairs-localhost.mjs
 */
import fs from "fs";
import crypto from "crypto";
import { ClassicLevel } from "classic-level";

const PLAN_PATH = "backups/recovery-2026-09-30/hebrew-repair-plan.json";
const RAW_BACKUP = "backups/recovery-2026-09-30/canton-jul29-localhost-20260729.raw.bin";
const INJECT_OUT = "public/.jul29-hebrew-repair-inject.html";
const LEVELDB =
  "/Users/danioffice/Library/Application Support/Cursor/Partitions/cursor-browser/Local Storage/leveldb";
const LOCALHOST_KEY = "_http://localhost:3333\x00\x01cc_data_v1";

function loadJul29FromRaw() {
  const raw = fs.readFileSync(RAW_BACKUP);
  return JSON.parse(raw.slice(1).toString("utf16le"));
}

async function tryLoadLocalhostLeveldb() {
  try {
    const db = new ClassicLevel(LEVELDB, { createIfMissing: false });
    await db.open();
    const buf = await db.get(LOCALHOST_KEY);
    await db.close();
    return JSON.parse(buf.slice(1).toString("utf16le"));
  } catch {
    return null;
  }
}

function parsePath(path) {
  const tokens = [];
  const root = path.match(/^([a-z]+)/);
  if (!root) throw new Error(`bad path: ${path}`);
  tokens.push({ kind: "root", key: root[1] });
  let i = root[1].length;
  while (i < path.length) {
    if (path[i] === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) throw new Error(`bad path: ${path}`);
      tokens.push({ kind: "id", value: path.slice(i + 1, end) });
      i = end + 1;
    } else if (path[i] === ".") {
      const field = path.slice(i + 1).match(/^([a-z]+)/);
      if (!field) throw new Error(`bad path: ${path}`);
      tokens.push({ kind: "field", key: field[1] });
      i += 1 + field[1].length;
    } else {
      i += 1;
    }
  }
  return tokens;
}

function getAt(state, tokens) {
  let cur = state[tokens[0].key];
  if (cur == null) return null;
  for (let t = 1; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === "id") {
      if (!Array.isArray(cur)) return null;
      const item = cur.find((x) => x?.id === tok.value);
      if (!item) return null;
      cur = item;
    } else if (tok.kind === "field") {
      if (t === tokens.length - 1) {
        return { target: cur, field: tok.key };
      }
      cur = cur[tok.key];
      if (cur == null) return null;
    }
  }
  return null;
}

function applyRepair(state, { path, current, replacement }) {
  const tokens = parsePath(path);
  const loc = getAt(state, tokens);
  if (!loc || loc.field == null) {
    throw new Error(`Cannot resolve path: ${path}`);
  }
  const before = loc.target[loc.field];
  if (before !== current) {
    throw new Error(
      `Current value mismatch at ${path} — abort (expected corrupted snapshot, got different value)`,
    );
  }
  loc.target[loc.field] = replacement;
  return { path, before, after: replacement };
}

function stripHebrewRepairFields(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function financialFingerprint(state) {
  const pick = {
    savedAt: state.savedAt,
    projs: state.projs,
    pays: state.pays,
    contacts: state.contacts,
    docs: state.docs,
    orders: state.orders,
    materials: state.materials,
    receipts: state.receipts,
  };
  return crypto.createHash("sha256").update(JSON.stringify(pick)).digest("hex");
}

function buildInjectHtml(jsonString) {
  const b64 = Buffer.from(jsonString, "utf8").toString("base64");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Hebrew repair inject (localhost only)</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}.ok{color:#047857}.warn{color:#b45309}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>77 Hebrew repairs → localStorage</h1>
<p id="status">Applying…</p>
<p class="warn"><strong>Block Supabase before opening the app</strong> (DevTools → block <code>supabase.co</code> or go offline briefly).</p>
<p><a id="appLink" href="/" style="display:none">Open app →</a></p>
<script>
(async () => {
  const status = document.getElementById('status');
  try {
    const json = atob('${b64}');
    const parsed = JSON.parse(json);
    localStorage.setItem('cc_data_v1', json);
    status.innerHTML = '<span class="ok">Applied 77 Hebrew repairs to localStorage.</span><br>'
      + 'savedAt: ' + new Date(parsed.savedAt).toISOString() + '<br>'
      + 'projects: ' + parsed.projs.length + ', pays: ' + parsed.pays.length + ', contacts: ' + parsed.contacts.length;
    document.getElementById('appLink').style.display = 'inline';
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
  }
})();
</script></body></html>`;
}

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
if (plan.repairs.length !== 77) {
  console.error(`Expected 77 repairs, got ${plan.repairs.length}`);
  process.exit(1);
}

// Always base on Jul 29 raw backup — same snapshot the repair plan was built from.
// (Live leveldb may differ if cloud boot overwrote local; repairs must not guess.)
const state = loadJul29FromRaw();
const source = "jul29 raw backup (approved snapshot)";

const fpBefore = financialFingerprint(state);
const applied = [];
for (const repair of plan.repairs) {
  applied.push(applyRepair(state, repair));
}

const fpAfter = financialFingerprint(state);
if (fpBefore !== fpAfter) {
  console.error("ERROR: financial/project fingerprint changed after repairs — abort");
  process.exit(1);
}

const jsonOut = JSON.stringify(state);
fs.writeFileSync(INJECT_OUT, buildInjectHtml(jsonOut));

const backupSha = crypto
  .createHash("sha256")
  .update(fs.readFileSync(RAW_BACKUP))
  .digest("hex");

console.log(
  JSON.stringify(
    {
      ok: true,
      source,
      repairsApplied: applied.length,
      flaggedUntouched: plan.flagged.length,
      financialFingerprintUnchanged: true,
      injectPage: INJECT_OUT,
      injectUrl: "http://127.0.0.1:3333/.jul29-hebrew-repair-inject.html",
      backupSha256Unchanged: backupSha,
      sampleRepairs: applied.slice(0, 3).map((r) => ({ path: r.path, after: r.after })),
    },
    null,
    2,
  ),
);
