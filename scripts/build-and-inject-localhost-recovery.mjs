/**
 * Build Jul29 + 77 Hebrew + 31 Phase2 recovery payload and UTF-8-correct inject page.
 * Usage: node scripts/build-and-inject-localhost-recovery.mjs
 */
import fs from "fs";
import crypto from "crypto";

const PLAN_PATH = "backups/recovery-2026-09-30/hebrew-repair-plan.json";
const RAW_BACKUP = "backups/recovery-2026-09-30/canton-jul29-localhost-20260729.raw.bin";
const PUB_PATH = "public/state.json";
const INJECT_OUT = "public/.jul29-recovery-inject.html";

function loadJul29() {
  const raw = fs.readFileSync(RAW_BACKUP);
  return JSON.parse(raw.slice(1).toString("utf16le"));
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

function getFieldValue(state, path) {
  const loc = getFieldLoc(state, parsePath(path));
  return loc ? loc.target[loc.field] : undefined;
}

function setFieldValue(state, path, value) {
  const loc = getFieldLoc(state, parsePath(path));
  if (!loc) throw new Error(`Cannot resolve path: ${path}`);
  loc.target[loc.field] = value;
}

const BAD_ENCODING = /뿯|ï¿½|â€|×¤|×™|\uFFFD|×[\u0080-\u00FF]/;

function assertCleanString(path, value, expected) {
  if (typeof value !== "string") {
    throw new Error(`${path}: expected string, got ${typeof value}`);
  }
  if (BAD_ENCODING.test(value)) {
    throw new Error(`${path}: bad encoding in "${value.slice(0, 40)}"`);
  }
  if (expected !== undefined && value !== expected) {
    throw new Error(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
}

function hasHebrew(s) {
  return /[\u0590-\u05FF]/.test(s);
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

function buildInjectHtml(b64) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Jul29 recovery inject (UTF-8)</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}.ok{color:#047857}.warn{color:#b45309}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Jul29 + 108 repairs → localStorage (UTF-8)</h1>
<p id="status">Applying…</p>
<p class="warn"><strong>Block Supabase before opening the app</strong> (DevTools → block <code>supabase.co</code> or go offline briefly).</p>
<p><a id="appLink" href="/" style="display:none">Open app →</a></p>
<script>
(async () => {
  const status = document.getElementById('status');
  try {
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    const json = new TextDecoder('utf-8').decode(bytes);
    const parsed = JSON.parse(json);
    localStorage.setItem('cc_data_v1', json);
    status.innerHTML = '<span class="ok">Injected with UTF-8 TextDecoder.</span><br>'
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

if (plan.repairs.length !== 77 || phase2Paths.length !== 31) {
  throw new Error(`Expected 77+31 repairs, got ${plan.repairs.length}+${phase2Paths.length}`);
}

const state = loadJul29();
const fpBefore = financialFingerprint(state);

for (const repair of plan.repairs) {
  const current = getFieldValue(state, repair.path);
  if (current !== repair.current) {
    throw new Error(`Phase1 current mismatch at ${repair.path}`);
  }
  setFieldValue(state, repair.path, repair.replacement);
}

for (const item of phase2Paths) {
  const replacement = getFieldValue(pub, item.path);
  if (replacement == null || BAD_ENCODING.test(replacement)) {
    throw new Error(`No clean public/state.json value for ${item.path}`);
  }
  setFieldValue(state, item.path, replacement);
}

const fpAfter = financialFingerprint(state);
if (fpBefore !== fpAfter) {
  throw new Error("Financial fingerprint changed");
}

const all108 = [...plan.repairs.map((r) => r.path), ...phase2Paths.map((p) => p.path)];
for (const path of all108) {
  assertCleanString(path, getFieldValue(state, path));
}

assertCleanString("phases[ph1].he", getFieldValue(state, "phases[ph1].he"), "רכישת קרקע");

const demoTitle = getFieldValue(
  state,
  "contacts[co7hrvhmofe6gzx].scopes[sc_demo_1777185275].title",
);
assertCleanString(
  "sc_demo.title",
  demoTitle,
  "פירוק גאראז׳ — הפיכה למשרד",
);

const expectedStages = [
  "פירוק פלייווד (קירות ותקרה)",
  "פירוק ארונות ומדפים",
  "פירוק מתקנים נוספים",
  "ניקוי ופינוי פסולת",
];
const demo = state.contacts
  .find((c) => c.id === "co7hrvhmofe6gzx")
  .scopes.find((s) => s.id === "sc_demo_1777185275");
for (let i = 0; i < 4; i++) {
  assertCleanString(`sc_demo stage ${i + 1}`, demo.stages[i].name, expectedStages[i]);
  if (!hasHebrew(demo.stages[i].name)) {
    throw new Error(`Stage ${i + 1} name lacks Hebrew Unicode`);
  }
}

const jsonOut = JSON.stringify(state);
const b64 = Buffer.from(jsonOut, "utf8").toString("base64");
fs.writeFileSync(INJECT_OUT, buildInjectHtml(b64));

const backupSha = crypto.createHash("sha256").update(fs.readFileSync(RAW_BACKUP)).digest("hex");

console.log(
  JSON.stringify(
    {
      ok: true,
      preInjectVerification: "passed",
      repairs: { phase1: 77, phase2: 31, total: 108 },
      financialFingerprintUnchanged: true,
      injectUrl: "http://127.0.0.1:3333/.jul29-recovery-inject.html",
      backupSha256Unchanged: backupSha,
      savedAt: new Date(state.savedAt).toISOString(),
      ph1he: getFieldValue(state, "phases[ph1].he"),
      demoTitle,
      demoStages: demo.stages.map((s) => s.name),
    },
    null,
    2,
  ),
);
