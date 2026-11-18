/**
 * Export current approved localhost cc_data_v1 to a permanent recovery backup.
 * Source: CDP base64 dump, raw JSON file, or Cursor browser leveldb (127.0.0.1:3333).
 *
 * Usage:
 *   node scripts/export-approved-localhost-backup.mjs --cdp-file <cdp-response.json>
 *   node scripts/export-approved-localhost-backup.mjs --json-file <state.json>
 *   node scripts/export-approved-localhost-backup.mjs --leveldb
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ClassicLevel } from "classic-level";

const BAD_ENCODING = /뿯|×|â€|ï¿½|\uFFFD|↽|ë¿/;
const JORDAN_ID = "zfjnvrxmo8rj9ui";
const JORDAN_ELEC_ID = "m4gk3isms3o72gt";
const CANTON_ID = "p1";
const LEVELDB =
  "/Users/danioffice/Library/Application Support/Cursor/Partitions/cursor-browser/Local Storage/leveldb";
const REPAIR_PLAN = "backups/recovery-2026-09-30/hebrew-repair-plan.json";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cdp-file") out.cdpFile = args[++i];
    else if (args[i] === "--json-file") out.jsonFile = args[++i];
    else if (args[i] === "--leveldb") out.leveldb = true;
    else if (args[i] === "--out-dir") out.outDir = args[++i];
  }
  return out;
}

function loadFromCdp(cdpFile) {
  const raw = fs.readFileSync(cdpFile, "utf8");
  const parsed = JSON.parse(raw);
  const b64 = parsed?.result?.value ?? parsed?.result?.result?.value;
  if (!b64 || typeof b64 !== "string") {
    throw new Error(`No base64 value in CDP file: ${cdpFile}`);
  }
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

async function loadFromLeveldb() {
  const db = new ClassicLevel(LEVELDB, { createIfMissing: false });
  await db.open();
  let found = null;
  for await (const [k, v] of db.iterator()) {
    const ks = String(k);
    if (ks.includes("cc_data_v1") && (ks.includes("127.0.0.1:3333") || ks.includes("localhost:3333"))) {
      const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
      found = JSON.parse(buf.slice(1).toString("utf16le"));
      break;
    }
  }
  await db.close();
  if (!found) throw new Error("cc_data_v1 not found for 127.0.0.1:3333 or localhost:3333");
  return found;
}

function parsePath(pathStr) {
  const tokens = [];
  const root = pathStr.match(/^([a-z]+)/);
  if (!root) throw new Error(`bad path: ${pathStr}`);
  tokens.push({ kind: "root", key: root[1] });
  let i = root[1].length;
  while (i < pathStr.length) {
    if (pathStr[i] === "[") {
      const end = pathStr.indexOf("]", i);
      const inner = pathStr.slice(i + 1, end);
      const id = inner.split("|")[0];
      tokens.push({ kind: "id", value: id });
      i = end + 1;
    } else if (pathStr[i] === ".") {
      const field = pathStr.slice(i + 1).match(/^([a-zA-Z0-9_]+)/);
      if (!field) throw new Error(`bad path: ${pathStr}`);
      tokens.push({ kind: "field", key: field[1] });
      i += 1 + field[1].length;
    } else i += 1;
  }
  return tokens;
}

function getFieldValue(state, pathStr) {
  const tokens = parsePath(pathStr);
  let cur = state[tokens[0].key];
  for (let t = 1; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === "id") {
      if (!Array.isArray(cur)) return null;
      cur = cur.find((x) => x?.id === tok.value);
      if (!cur) return null;
    } else {
      cur = cur?.[tok.key];
    }
  }
  return cur ?? null;
}

function verifyMetrics(state) {
  const jordan = (state.projs || []).find((p) => p.id === JORDAN_ID);
  const jordanElec = (state.projs || []).find((p) => p.id === JORDAN_ELEC_ID);
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
  const cantonSum = Math.round(
    (state.pays || [])
      .filter((p) => p.pid === CANTON_ID)
      .reduce((s, p) => s + (Number(p.amt) || 0), 0),
  );

  const elecPhases = (state.phases || []).filter((p) => p.pid === JORDAN_ELEC_ID);
  const elecGroups = [...new Set(elecPhases.map((p) => p.group).filter(Boolean))];

  return {
    savedAt: state.savedAt ?? null,
    savedAtISO: state.savedAt ? new Date(state.savedAt).toISOString() : null,
    counts: {
      projs: (state.projs || []).length,
      pays: (state.pays || []).length,
      contacts: Array.isArray(state.contacts) ? state.contacts.length : 0,
      phases: (state.phases || []).length,
      docs: (state.docs || []).length,
    },
    jordan: {
      paysCount: jordanPays.length,
      paysSum: jordanPaySum,
      contractValue,
      originalContract: jordan?.originalContract ?? null,
      totalBudget: jordan?.totalBudget ?? null,
      cabinetsCO9450: cabCo
        ? { id: cabCo.id, title: cabCo.title, amt: cabCo.amt, status: cabCo.status }
        : null,
      changeOrders: cos.map((c) => ({
        title: c.title,
        amt: c.amt,
        status: c.status,
      })),
    },
    jordanElectricalProject: jordanElec
      ? {
          id: jordanElec.id,
          name: jordanElec.name,
          originalContract: jordanElec.originalContract,
          totalBudget: jordanElec.totalBudget,
        }
      : null,
    jordanElectricalPhaseGroups: elecGroups,
    cantonPaysSum: cantonSum,
  };
}

function verifyHebrew(state) {
  const plan = JSON.parse(fs.readFileSync(REPAIR_PLAN, "utf8"));
  const checks = [];
  let pass = 0;
  let fail = 0;

  for (const repair of plan.repairs) {
    const actual = getFieldValue(state, repair.path);
    const ok =
      typeof actual === "string" &&
      actual === repair.replacement &&
      !BAD_ENCODING.test(actual);
    checks.push({
      path: repair.path,
      ok,
      expected: repair.replacement,
      actual: typeof actual === "string" ? actual.slice(0, 80) : actual,
    });
    if (ok) pass++;
    else fail++;
  }

  const spotChecks = [
    {
      path: "phases[ph1].he",
      expected: "רכישת קרקע",
      actual: getFieldValue(state, "phases[ph1].he"),
    },
    {
      path: "contacts[co7hrvhmofe6gzx].scopes[sc_demo_1777185275].title",
      expected: "פירוק גאראז׳ — הפיכה למשרד",
      actual: getFieldValue(
        state,
        "contacts[co7hrvhmofe6gzx].scopes[sc_demo_1777185275].title",
      ),
    },
    {
      path: "phases[f4m35p0ms3oag9v].group",
      expected: "Electrical",
      actual: getFieldValue(state, "phases[f4m35p0ms3oag9v].group"),
    },
    {
      path: "phases[cad17zams3ol75i].group",
      expected: "Electrical",
      actual: getFieldValue(state, "phases[cad17zams3ol75i].group"),
    },
  ];

  const spotResults = spotChecks.map((s) => ({
    ...s,
    ok: s.actual === s.expected && !BAD_ENCODING.test(String(s.actual || "")),
  }));

  const failedRepairs = checks.filter((c) => !c.ok).slice(0, 15);
  const badEncodingSamples = [];
  function walk(o, p) {
    if (typeof o === "string" && BAD_ENCODING.test(o)) {
      badEncodingSamples.push({ path: p, sample: o.slice(0, 60) });
    } else if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${p}[${i}]`));
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
    }
  }
  walk(
    {
      phases: (state.phases || []).slice(0, 5),
      contacts: (state.contacts || []).filter((c) =>
        ["co7hrvhmofe6gzx", "90p577lmof92g3e"].includes(c.id),
      ),
    },
    "sample",
  );

  return {
    repairPlanChecks: { pass, fail, total: checks.length },
    spotChecks: spotResults,
    failedRepairs,
    badEncodingSampleCount: badEncodingSamples.length,
    badEncodingSamples: badEncodingSamples.slice(0, 10),
    hebrewOk: fail === 0 && spotResults.every((s) => s.ok),
  };
}

function expectedChecks(metrics, hebrew) {
  return {
    projs3: metrics.counts.projs === 3,
    pays81: metrics.counts.pays === 81,
    contacts18: metrics.counts.contacts === 18,
    jordanContract67575: metrics.jordan.contractValue === 67575,
    jordanExpenses40393: metrics.jordan.paysSum === 40393,
    cabinetsCO9450: !!metrics.jordan.cabinetsCO9450,
    jordanElectrical49000:
      metrics.jordanElectricalProject?.originalContract === 49000 ||
      metrics.jordanElectricalProject?.totalBudget === 49000,
    cantonExpenses134937: metrics.cantonPaysSum === 134937,
    hebrewRepaired: hebrew.hebrewOk,
  };
}

const args = parseArgs();
let state;
if (args.cdpFile) state = loadFromCdp(args.cdpFile);
else if (args.jsonFile) state = JSON.parse(fs.readFileSync(args.jsonFile, "utf8"));
else if (args.leveldb) state = await loadFromLeveldb();
else {
  console.error("Provide --cdp-file, --json-file, or --leveldb");
  process.exit(1);
}

const metrics = verifyMetrics(state);
const hebrew = verifyHebrew(state);
const checks = expectedChecks(metrics, hebrew);
const allChecksPass = Object.values(checks).every(Boolean);

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outDir =
  args.outDir ||
  path.join("backups", `recovery-2026-10-03`);
const baseName = `canton-localhost-approved-${stamp}`;
const outFile = path.join(outDir, `${baseName}.json`);
const manifestFile = path.join(outDir, `${baseName}.manifest.json`);

fs.mkdirSync(outDir, { recursive: true });
const jsonOut = JSON.stringify(state, null, 2);
fs.writeFileSync(outFile, jsonOut, "utf8");

const sha256 = crypto.createHash("sha256").update(jsonOut).digest("hex");
const reparsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
const parseVerified = !!reparsed.projs && Array.isArray(reparsed.pays);

const manifest = {
  exportedAt: new Date().toISOString(),
  source: "http://127.0.0.1:3333 localStorage cc_data_v1 (user-approved localhost state)",
  outputFile: outFile,
  filename: path.basename(outFile),
  bytes: fs.statSync(outFile).size,
  sha256,
  parseVerified,
  savedAt: metrics.savedAt,
  savedAtISO: metrics.savedAtISO,
  metrics,
  hebrewVerification: hebrew,
  expectedChecks: checks,
  allChecksPass,
};

fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify(manifest, null, 2));
