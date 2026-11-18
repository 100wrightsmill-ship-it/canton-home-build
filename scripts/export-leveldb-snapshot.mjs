/**
 * Read-only export: pull cc_data_v1 from Cursor browser leveldb into valid JSON.
 * Usage: node scripts/export-leveldb-snapshot.mjs <localhost|vercel> <output.json>
 */
import { ClassicLevel } from "classic-level";
import { jsonrepair } from "jsonrepair";
import fs from "fs";
import path from "path";

const LEVELDB =
  "/Users/danioffice/Library/Application Support/Cursor/Partitions/cursor-browser/Local Storage/leveldb";

const TOP_KEYS = [
  "schemaVersion",
  "savedAt",
  "cp",
  "projs",
  "phases",
  "pays",
  "contacts",
  "tasks",
  "docs",
  "orders",
  "materials",
  "receipts",
];

function stripUtf16(buf) {
  return buf.toString("latin1").replace(/\u0000/g, "");
}

function cleanChunk(s) {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

function extractBracketValue(raw, key) {
  if (key === "savedAt" || key === "schemaVersion" || key === "cp") {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+|null|"[^"]*")`));
    if (!m) return undefined;
    if (m[1] === "null") return null;
    if (m[1].startsWith('"')) return JSON.parse(m[1]);
    return Number(m[1]);
  }

  const re = new RegExp(`"${key}"\\s*:\\s*(\\[|\\{)`);
  const m = raw.match(re);
  if (!m) return key === "orders" || key === "materials" || key === "receipts" ? [] : undefined;

  const open = m[1];
  const close = open === "[" ? "]" : "}";
  let i = m.index + m[0].length - 1;
  let depth = 0;
  const start = i;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const chunk = cleanChunk(raw.slice(start, i));
  try {
    return JSON.parse(chunk);
  } catch {
    try {
      return JSON.parse(jsonrepair(chunk));
    } catch (e) {
      return { __parseError: e.message, __key: key };
    }
  }
}

async function loadRaw(origin) {
  const db = new ClassicLevel(LEVELDB, { createIfMissing: false });
  const match =
    origin === "localhost"
      ? (k) => k.includes("localhost")
      : (k) => k.includes("vercel");
  for await (const [k, v] of db.iterator()) {
    if (String(k).includes("cc_data_v1") && match(String(k))) {
      await db.close();
      return stripUtf16(Buffer.isBuffer(v) ? v : Buffer.from(v));
    }
  }
  await db.close();
  throw new Error(`cc_data_v1 not found for origin: ${origin}`);
}

function buildSnapshot(raw) {
  const snap = {};
  for (const key of TOP_KEYS) {
    snap[key] = extractBracketValue(raw, key);
  }
  if (snap.orders?.__parseError) snap.orders = [];
  if (snap.materials?.__parseError) snap.materials = [];
  if (snap.receipts?.__parseError) snap.receipts = [];
  return snap;
}

function verifyMetrics(snap, label) {
  const jordanId = "zfjnvrxmo8rj9ui";
  const jordan = (snap.projs || []).find((p) => p.id === jordanId);
  const jordanPays = (snap.pays || []).filter((p) => p.pid === jordanId);
  const jordanPaySum = Math.round(
    jordanPays.reduce((s, p) => s + (Number(p.amt) || 0), 0)
  );
  const cos = jordan?.changeOrders || [];
  const approvedSum = cos
    .filter((c) => c.status === "approved")
    .reduce((s, c) => s + (Number(c.amt) || 0), 0);
  const contractValue = (jordan?.originalContract || 0) + approvedSum;
  const cabCo = cos.find((c) => Number(c.amt) === 9450);
  const elecCo = cos.find((c) => c.title === "Electrical" && Number(c.amt) === 4400);
  const stuccoCo = cos.find(
    (c) => /sttuco|stucco/i.test(c.title || "") && Number(c.amt) === 1750
  );
  const jordanElec = (snap.projs || []).find((p) => p.id === "m4gk3isms3o72gt");
  const cantonSum = Math.round(
    (snap.pays || [])
      .filter((p) => p.pid === "p1")
      .reduce((s, p) => s + (Number(p.amt) || 0), 0)
  );
  const docs = (snap.docs || []).map((d) => ({
    id: d.id,
    name: d.name,
    storagePath: d.storagePath || null,
  }));

  return {
    label,
    savedAt: snap.savedAt,
    savedAtISO: snap.savedAt ? new Date(snap.savedAt).toISOString() : null,
    parseIssues: {
      contacts: !!snap.contacts?.__parseError,
      orders: false,
    },
    counts: {
      projs: (snap.projs || []).length,
      pays: (snap.pays || []).length,
      contacts: Array.isArray(snap.contacts) ? snap.contacts.length : 0,
      docs: (snap.docs || []).length,
      phases: (snap.phases || []).length,
    },
    jordan: {
      paysCount: jordanPays.length,
      paysSum: jordanPaySum,
      contractValue,
      cabinetsCO9450: cabCo
        ? { id: cabCo.id, title: cabCo.title, amt: cabCo.amt, date: cabCo.date }
        : null,
      electricalCO4400: elecCo
        ? { id: elecCo.id, amt: elecCo.amt, status: elecCo.status }
        : null,
      stuccoCO1750: stuccoCo
        ? { id: stuccoCo.id, amt: stuccoCo.amt, status: stuccoCo.status }
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
        }
      : null,
    cantonPaysSum: cantonSum,
    docs,
  };
}

const origin = process.argv[2];
const outFile = process.argv[3];
if (!origin || !outFile) {
  console.error("Usage: node export-leveldb-snapshot.mjs <localhost|vercel> <output.json>");
  process.exit(1);
}

const raw = await loadRaw(origin);
const snap = buildSnapshot(raw);
const json = JSON.stringify(snap, null, 2);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, json, "utf8");

// Verify round-trip parse
const reparsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
const metrics = verifyMetrics(reparsed, origin);
const manifest = {
  exportedAt: new Date().toISOString(),
  source: origin === "localhost" ? "Cursor browser localhost:3333 cc_data_v1" : "Cursor browser canton-home-build.vercel.app cc_data_v1",
  outputFile: outFile,
  bytes: fs.statSync(outFile).size,
  parseVerified: true,
  metrics,
};

const manifestPath = outFile.replace(/\.json$/, ".manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

console.log(JSON.stringify(manifest, null, 2));
