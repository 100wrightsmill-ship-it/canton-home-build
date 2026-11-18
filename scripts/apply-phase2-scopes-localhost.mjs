/**
 * Phase 2: Apply 31 verified Honorio/Agostin scope/stage text repairs.
 * Base = Jul 29 raw + prior 77 Hebrew repairs, then ID-matched text from public/state.json.
 *
 * Usage: node scripts/apply-phase2-scopes-localhost.mjs
 */
import fs from "fs";
import crypto from "crypto";

const PLAN_PATH = "backups/recovery-2026-09-30/hebrew-repair-plan.json";
const RAW_BACKUP = "backups/recovery-2026-09-30/canton-jul29-localhost-20260729.raw.bin";
const PUB_PATH = "public/state.json";
const INJECT_OUT = "public/.jul29-phase2-inject.html";

function loadJul29() {
  const raw = fs.readFileSync(RAW_BACKUP);
  return JSON.parse(raw.slice(1).toString("utf16le"));
}

function isCorrupted(s) {
  return typeof s === "string" && /뿯|ï¿½|â€|ë¿/.test(s);
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
      let inner = path.slice(i + 1, end);
      if (inner.includes("|")) inner = inner.split("|")[0];
      tokens.push({ kind: "id", value: inner.trim() });
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

function getFieldLoc(state, tokens) {
  let cur = state[tokens[0].key];
  if (cur == null) return null;
  for (let t = 1; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === "id") {
      if (!Array.isArray(cur)) return null;
      cur = cur.find((x) => x?.id === tok.value);
      if (!cur) return null;
    } else if (tok.kind === "field") {
      if (t === tokens.length - 1) return { target: cur, field: tok.key };
      cur = cur[tok.key];
      if (cur == null) return null;
    }
  }
  return null;
}

function getFieldValue(state, tokens) {
  const loc = getFieldLoc(state, tokens);
  return loc ? loc.target[loc.field] : undefined;
}

function applyTextField(state, path, replacement, source) {
  const tokens = parsePath(path);
  const loc = getFieldLoc(state, tokens);
  if (!loc) throw new Error(`Cannot resolve path: ${path}`);
  const before = loc.target[loc.field];
  if (typeof replacement !== "string" || isCorrupted(replacement)) {
    throw new Error(`Replacement not readable for ${path}`);
  }
  loc.target[loc.field] = replacement;
  return { path, before, after: replacement, source };
}

function applyPhase1Repairs(state, repairs) {
  const applied = [];
  for (const repair of repairs) {
    const tokens = parsePath(repair.path);
    const loc = getFieldLoc(state, tokens);
    if (!loc) throw new Error(`Phase1 path missing: ${repair.path}`);
    if (loc.target[loc.field] !== repair.current) {
      throw new Error(`Phase1 current mismatch at ${repair.path}`);
    }
    loc.target[loc.field] = repair.replacement;
    applied.push(repair.path);
  }
  return applied;
}

function financialFingerprint(state) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        projs: state.projs,
        pays: state.pays,
        orders: state.orders,
        materials: state.materials,
        receipts: state.receipts,
      }),
    )
    .digest("hex");
}

function structuralContactsFingerprint(state) {
  const stripText = (contacts) =>
    JSON.parse(
      JSON.stringify(contacts, (key, value) => {
        if (key === "title" || key === "desc" || key === "name" || key === "t") {
          return undefined;
        }
        return value;
      }),
    );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stripText(state.contacts)))
    .digest("hex");
}

function buildInjectHtml(jsonString) {
  const b64 = Buffer.from(jsonString, "utf8").toString("base64");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Phase 2 scope repair (localhost only)</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}.ok{color:#047857}.warn{color:#b45309}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Phase 2: 31 scope/stage repairs → localStorage</h1>
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
    status.innerHTML = '<span class="ok">Applied Jul29 + 77 Hebrew + 31 Phase2 scope repairs.</span><br>'
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
const pub = JSON.parse(fs.readFileSync(PUB_PATH, "utf8"));

const phase2Paths = plan.flagged.filter(
  (f) =>
    f.path.startsWith("contacts[") &&
    (f.path.includes("Honorio") || f.path.includes("Agostin")),
);

if (phase2Paths.length !== 31) {
  console.error(`Expected 31 Phase 2 paths, got ${phase2Paths.length}`);
  process.exit(1);
}

const state = loadJul29();
const fpBefore = financialFingerprint(state);
const structBefore = structuralContactsFingerprint(state);

applyPhase1Repairs(state, plan.repairs);

const phase2Applied = [];
for (const item of phase2Paths) {
  const replacement = getFieldValue(pub, parsePath(item.path));
  if (replacement == null || isCorrupted(replacement)) {
    console.error(`No readable public/state.json value for ${item.path}`);
    process.exit(1);
  }
  phase2Applied.push(
    applyTextField(state, item.path, replacement, "public/state.json"),
  );
}

const fpAfter = financialFingerprint(state);
const structAfter = structuralContactsFingerprint(state);

if (fpBefore !== fpAfter) {
  console.error("ERROR: financial fingerprint changed");
  process.exit(1);
}
if (structBefore !== structAfter) {
  console.error("ERROR: contact structure fingerprint changed");
  process.exit(1);
}

const backupSha = crypto
  .createHash("sha256")
  .update(fs.readFileSync(RAW_BACKUP))
  .digest("hex");

const jsonOut = JSON.stringify(state);
fs.writeFileSync(INJECT_OUT, buildInjectHtml(jsonOut));

console.log(
  JSON.stringify(
    {
      ok: true,
      phase1Repairs: plan.repairs.length,
      phase2Repairs: phase2Applied.length,
      remainingFlaggedUntouched: plan.flagged.length - phase2Applied.length,
      financialFingerprintUnchanged: true,
      contactStructureUnchanged: true,
      injectPage: INJECT_OUT,
      injectUrl: "http://127.0.0.1:3333/.jul29-phase2-inject.html",
      backupSha256Unchanged: backupSha,
      samples: phase2Applied.slice(0, 3).map((r) => ({
        path: r.path,
        after: r.after.slice(0, 60),
      })),
    },
    null,
    2,
  ),
);
