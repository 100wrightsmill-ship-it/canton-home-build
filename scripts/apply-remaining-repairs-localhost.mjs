/**
 * Apply Phase 2 (31) + Jordan Electrical text patches to CURRENT localhost state.
 * Preserves financial fingerprint. Uses UTF-8-correct inject (TextDecoder).
 *
 * Usage: node scripts/apply-remaining-repairs-localhost.mjs [--json-file <state.json>]
 */
import crypto from "crypto";
import fs from "fs";

const PLAN_PATH = "backups/recovery-2026-09-30/hebrew-repair-plan.json";
const PUB_PATH = "public/state.json";
const DEFAULT_SOURCE =
  "backups/recovery-2026-10-03/canton-localhost-approved-20261004.json";
const INJECT_OUT = "public/.localhost-remaining-repairs-inject.html";

const BAD = /뿯|ï¿½|â€|\uFFFD|↽|ë¿/;

const JORDAN_ELECTRICAL_PATCHES = [
  { path: "phases[f4m35p0ms3oag9v].group", replacement: "Electrical" },
  { path: "phases[cad17zams3ol75i].group", replacement: "Electrical" },
  {
    path: "contacts[90p577lmof92g3e].pmts[54y8i9pmrsqh1rs].milestone",
    replacement: "Electrical — Panel Upgrade & Garage — Final Inspection",
  },
  {
    path: "pays[kxut5dhmrsqh2xg].notes",
    replacement:
      "Payment #2 — Electrical — Panel Upgrade & Garage — Final Inspection",
  },
];

function parsePath(pathStr) {
  const tokens = [];
  const root = pathStr.match(/^([a-z]+)/);
  if (!root) throw new Error(`bad path: ${pathStr}`);
  tokens.push({ kind: "root", key: root[1] });
  let i = root[1].length;
  while (i < pathStr.length) {
    if (pathStr[i] === "[") {
      const end = pathStr.indexOf("]", i);
      let inner = pathStr.slice(i + 1, end);
      if (inner.includes("|")) inner = inner.split("|")[0];
      tokens.push({ kind: "id", value: inner.trim() });
      i = end + 1;
    } else if (pathStr[i] === ".") {
      const field = pathStr.slice(i + 1).match(/^([a-zA-Z0-9_]+)/);
      if (!field) throw new Error(`bad path: ${pathStr}`);
      tokens.push({ kind: "field", key: field[1] });
      i += 1 + field[1].length;
    } else i++;
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

function getFieldValue(state, pathStr) {
  const loc = getFieldLoc(state, parsePath(pathStr));
  return loc ? loc.target[loc.field] : undefined;
}

function setFieldValue(state, pathStr, value) {
  const loc = getFieldLoc(state, parsePath(pathStr));
  if (!loc) throw new Error(`Cannot resolve: ${pathStr}`);
  loc.target[loc.field] = value;
}

function financialFingerprint(state) {
  const paysFinancial = (state.pays || []).map(({ notes, ...rest }) => rest);
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        projs: state.projs,
        pays: paysFinancial,
        orders: state.orders,
        materials: state.materials,
        receipts: state.receipts,
      }),
    )
    .digest("hex");
}

function verifyDollarMetrics(state) {
  const JORDAN_ID = "zfjnvrxmo8rj9ui";
  const jordan = (state.projs || []).find((p) => p.id === JORDAN_ID);
  const jordanPays = (state.pays || []).filter((p) => p.pid === JORDAN_ID);
  const jordanPaySum = Math.round(
    jordanPays.reduce((s, p) => s + (Number(p.amt) || 0), 0),
  );
  const cos = jordan?.changeOrders || [];
  const approvedSum = cos
    .filter((c) => c.status === "approved")
    .reduce((s, c) => s + (Number(c.amt) || 0), 0);
  const contractValue = Math.round((jordan?.originalContract || 0) + approvedSum);
  const cabCo = cos.find((c) => Number(c.amt) === 9450);
  const jordanElec = (state.projs || []).find((p) => p.id === "m4gk3isms3o72gt");
  const cantonSum = Math.round(
    (state.pays || [])
      .filter((p) => p.pid === "p1")
      .reduce((s, p) => s + (Number(p.amt) || 0), 0),
  );
  return {
    projs: (state.projs || []).length,
    pays: (state.pays || []).length,
    contacts: Array.isArray(state.contacts) ? state.contacts.length : 0,
    jordanContract: contractValue,
    jordanExpenses: jordanPaySum,
    cabinetsCO9450: !!cabCo,
    jordanElectrical49000:
      jordanElec?.originalContract === 49000 ||
      jordanElec?.totalBudget === 49000,
    cantonExpenses: cantonSum,
  };
}

function latin1ToUtf8(s) {
  if (typeof s !== "string") return s;
  try {
    return Buffer.from(s, "latin1").toString("utf8");
  } catch {
    return s;
  }
}

function isCleanString(s) {
  return typeof s === "string" && !BAD.test(s);
}

function normalizePhase1Field(state, repair) {
  const current = getFieldValue(state, repair.path);
  if (current === repair.replacement && isCleanString(current)) return "already";
  const decoded = latin1ToUtf8(current);
  if (decoded === repair.replacement) {
    setFieldValue(state, repair.path, repair.replacement);
    return "normalized";
  }
  if (current === repair.current) {
    setFieldValue(state, repair.path, repair.replacement);
    return "repaired";
  }
  throw new Error(
    `Phase1 untrusted value at ${repair.path}: ${String(current).slice(0, 50)}`,
  );
}

function buildInjectHtml(b64) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Remaining repairs inject (UTF-8)</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}.ok{color:#047857}.warn{color:#b45309}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Phase 2 + Jordan Electrical → localStorage (UTF-8 TextDecoder)</h1>
<p id="status">Applying…</p>
<p class="warn"><strong>Block Supabase</strong> before opening the main app.</p>
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
    window.__injectDone = true;
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
    window.__injectDone = false;
  }
})();
</script></body></html>`;
}

const jsonFile =
  process.argv.includes("--json-file")
    ? process.argv[process.argv.indexOf("--json-file") + 1]
    : DEFAULT_SOURCE;

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
const pub = JSON.parse(fs.readFileSync(PUB_PATH, "utf8"));
const state = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

const phase2Paths = plan.flagged.filter(
  (f) =>
    f.path.startsWith("contacts[") &&
    (f.path.includes("Honorio") || f.path.includes("Agostin")),
);

if (plan.repairs.length !== 77 || phase2Paths.length !== 31) {
  throw new Error("Expected 77 phase1 + 31 phase2 repairs in plan");
}

const fpBefore = financialFingerprint(state);
const metricsBefore = verifyDollarMetrics(state);

const phase1Actions = plan.repairs.map((r) => ({
  path: r.path,
  action: normalizePhase1Field(state, r),
}));

const phase2Applied = [];
for (const item of phase2Paths) {
  const replacement = getFieldValue(pub, item.path);
  if (replacement == null || BAD.test(replacement)) {
    throw new Error(`No trusted public/state.json value for ${item.path}`);
  }
  setFieldValue(state, item.path, replacement);
  phase2Applied.push(item.path);
}

const electricalApplied = [];
for (const patch of JORDAN_ELECTRICAL_PATCHES) {
  setFieldValue(state, patch.path, patch.replacement);
  electricalApplied.push(patch.path);
}

const fpAfter = financialFingerprint(state);
const metricsAfter = verifyDollarMetrics(state);
if (fpBefore !== fpAfter) {
  throw new Error("Financial fingerprint changed after text repairs");
}
if (JSON.stringify(metricsBefore) !== JSON.stringify(metricsAfter)) {
  throw new Error(
    `Dollar metrics changed: ${JSON.stringify({ before: metricsBefore, after: metricsAfter })}`,
  );
}

const all108 = [
  ...plan.repairs.map((r) => r.path),
  ...phase2Paths.map((p) => p.path),
];

const verify108 = [];
for (const pathStr of all108) {
  const expected =
    plan.repairs.find((r) => r.path === pathStr)?.replacement ??
    getFieldValue(pub, pathStr);
  const actual = getFieldValue(state, pathStr);
  verify108.push({
    path: pathStr,
    ok: actual === expected && isCleanString(actual),
    expected: String(expected).slice(0, 60),
    actual: String(actual).slice(0, 60),
  });
}

for (const patch of JORDAN_ELECTRICAL_PATCHES) {
  const actual = getFieldValue(state, patch.path);
  verify108.push({
    path: patch.path,
    ok: actual === patch.replacement && isCleanString(actual),
    expected: patch.replacement.slice(0, 60),
    actual: String(actual).slice(0, 60),
  });
}

const failed = verify108.filter((v) => !v.ok);
if (failed.length) {
  console.error(JSON.stringify({ error: "Pre-inject verification failed", failed }, null, 2));
  process.exit(1);
}

const jsonOut = JSON.stringify(state);
const b64 = Buffer.from(jsonOut, "utf8").toString("base64");
fs.writeFileSync(INJECT_OUT, buildInjectHtml(b64));

console.log(
  JSON.stringify(
    {
      ok: true,
      source: jsonFile,
      financialFingerprintUnchanged: true,
      financialFingerprint: fpAfter,
      phase1: {
        total: 77,
        actions: phase1Actions.reduce(
          (acc, x) => {
            acc[x.action] = (acc[x.action] || 0) + 1;
            return acc;
          },
          {},
        ),
      },
      phase2Applied: phase2Applied.length,
      electricalApplied: electricalApplied.length,
      trustedRepairsVerified: all108.length,
      injectUrl: "http://127.0.0.1:3333/.localhost-remaining-repairs-inject.html",
      injectFile: INJECT_OUT,
    },
    null,
    2,
  ),
);
