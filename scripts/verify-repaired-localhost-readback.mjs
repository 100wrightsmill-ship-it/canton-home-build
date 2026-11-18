/**
 * Verify localhost localStorage readback after repairs.
 * Usage: node scripts/verify-repaired-localhost-readback.mjs --cdp-file <file>
 *        node scripts/verify-repaired-localhost-readback.mjs --json-file <file>
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

const PLAN_PATH = "backups/recovery-2026-09-30/hebrew-repair-plan.json";
const PUB_PATH = "public/state.json";
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
      tokens.push({ kind: "field", key: field[1] });
      i += 1 + field[1].length;
    } else i++;
  }
  return tokens;
}

function getFieldValue(state, pathStr) {
  let cur = state[parsePath(pathStr)[0].key];
  for (const tok of parsePath(pathStr).slice(1)) {
    if (tok.kind === "id") cur = cur?.find?.((x) => x?.id === tok.value);
    else cur = cur?.[tok.key];
  }
  return cur ?? null;
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

function scanMojibake(state) {
  const hits = [];
  function walk(o, p) {
    if (typeof o === "string" && BAD.test(o)) {
      hits.push({ path: p, sample: o.slice(0, 100) });
    } else if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${p}[${i}]`));
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        walk(v, p ? `${p}.${k}` : k);
      }
    }
  }
  walk(state, "");
  return hits;
}

function loadState(args) {
  if (args.cdpFile) {
    const raw = fs.readFileSync(args.cdpFile, "utf8");
    const parsed = JSON.parse(raw);
    const b64 = parsed?.result?.value ?? parsed?.result?.result?.value;
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  }
  if (args.jsonFile) {
    return JSON.parse(fs.readFileSync(args.jsonFile, "utf8"));
  }
  throw new Error("Provide --cdp-file or --json-file");
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--cdp-file") args.cdpFile = process.argv[++i];
  if (process.argv[i] === "--json-file") args.jsonFile = process.argv[++i];
  if (process.argv[i] === "--out-dir") args.outDir = process.argv[++i];
}

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
const pub = JSON.parse(fs.readFileSync(PUB_PATH, "utf8"));
const state = loadState(args);

const phase2Paths = plan.flagged.filter(
  (f) =>
    f.path.startsWith("contacts[") &&
    (f.path.includes("Honorio") || f.path.includes("Agostin")),
);

const all108 = [
  ...plan.repairs.map((r) => r.path),
  ...phase2Paths.map((p) => p.path),
];

const repairChecks = [];
for (const pathStr of all108) {
  const expected =
    plan.repairs.find((r) => r.path === pathStr)?.replacement ??
    getFieldValue(pub, pathStr);
  const actual = getFieldValue(state, pathStr);
  repairChecks.push({
    path: pathStr,
    ok: actual === expected && !BAD.test(String(actual)),
    expected: String(expected).slice(0, 80),
    actual: String(actual).slice(0, 80),
  });
}

const electricalChecks = JORDAN_ELECTRICAL_PATCHES.map((patch) => {
  const actual = getFieldValue(state, patch.path);
  return {
    path: patch.path,
    ok: actual === patch.replacement && !BAD.test(String(actual)),
    expected: patch.replacement,
    actual,
  };
});

const mojibakeHits = scanMojibake(state);
const metrics = verifyDollarMetrics(state);
const expectedMetrics = {
  projs: 3,
  pays: 81,
  contacts: 18,
  jordanContract: 67575,
  jordanExpenses: 40393,
  cabinetsCO9450: true,
  jordanElectrical49000: true,
  cantonExpenses: 134937,
};

const metricsOk = Object.entries(expectedMetrics).every(
  ([k, v]) => metrics[k] === v,
);

const report = {
  savedAt: state.savedAt,
  savedAtISO: state.savedAt ? new Date(state.savedAt).toISOString() : null,
  trustedRepairs108: {
    pass: repairChecks.filter((c) => c.ok).length,
    fail: repairChecks.filter((c) => !c.ok).length,
    failed: repairChecks.filter((c) => !c.ok),
  },
  jordanElectricalPatches: {
    pass: electricalChecks.filter((c) => c.ok).length,
    fail: electricalChecks.filter((c) => !c.ok).length,
    checks: electricalChecks,
  },
  mojibakeScan: {
    count: mojibakeHits.length,
    occurrences: mojibakeHits,
  },
  metrics,
  expectedMetrics,
  metricsOk,
  spotChecks: {
    ph1he: getFieldValue(state, "phases[ph1].he"),
    demoTitle: getFieldValue(
      state,
      "contacts[co7hrvhmofe6gzx].scopes[sc_demo_1777185275].title",
    ),
    elecGroups: ["f4m35p0ms3oag9v", "cad17zams3ol75i"].map((id) =>
      getFieldValue(state, `phases[${id}].group`),
    ),
  },
  allChecksPass:
    repairChecks.every((c) => c.ok) &&
    electricalChecks.every((c) => c.ok) &&
    mojibakeHits.length === 0 &&
    metricsOk,
};

if (args.outDir) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const baseName = `canton-localhost-repaired-${stamp}`;
  const outFile = path.join(args.outDir, `${baseName}.json`);
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonOut = JSON.stringify(state, null, 2);
  fs.writeFileSync(outFile, jsonOut, "utf8");
  const sha256 = crypto.createHash("sha256").update(jsonOut).digest("hex");
  JSON.parse(fs.readFileSync(outFile, "utf8"));
  const manifest = {
    exportedAt: new Date().toISOString(),
    source: "http://127.0.0.1:3333 localStorage cc_data_v1 (readback after repairs)",
    filename: path.basename(outFile),
    outputFile: outFile,
    bytes: fs.statSync(outFile).size,
    sha256,
    parseVerified: true,
    ...report,
  };
  const manifestFile = outFile.replace(/\.json$/, ".manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  report.backup = { filename: path.basename(outFile), sha256, manifestFile };
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.allChecksPass ? 0 : 1);
