/**
 * Build localhost-only production restore page (UTF-8 TextDecoder inject pattern).
 * Usage: node scripts/build-production-restore-page.mjs
 */
import crypto from "crypto";
import fs from "fs";
import {
  BUCKET,
  STATE_BACKUP_PREFIX,
  STATE_PATH,
  SUPABASE_KEY,
  SUPABASE_URL,
} from "../src/sync/cloudSync.js";

const SOURCE =
  "backups/recovery-2026-10-03/canton-localhost-repaired-20261004.json";
const OUT = "public/.production-recovery-restore.html";
const BACKUP_PREFIX = STATE_BACKUP_PREFIX;

const raw = fs.readFileSync(SOURCE, "utf8");
const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
const b64 = Buffer.from(raw, "utf8").toString("base64");

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Production recovery restore</title>
<style>body{font-family:system-ui;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.5}
.ok{color:#047857}.err{color:#b91c1c}pre{background:#f3f4f6;padding:1rem;border-radius:8px;overflow:auto;font-size:12px}</style>
</head><body>
<h1>Production recovery restore → Supabase</h1>
<p>Source: ${SOURCE}<br>SHA256: <code>${sha256}</code></p>
<p id="status">Running…</p>
<pre id="log"></pre>
<script>
const SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
const SUPABASE_KEY = ${JSON.stringify(SUPABASE_KEY)};
const BUCKET = ${JSON.stringify(BUCKET)};
const STATE_PATH = ${JSON.stringify(STATE_PATH)};
const BACKUP_PREFIX = ${JSON.stringify(BACKUP_PREFIX)};
const RECOVERY_SHA = ${JSON.stringify(sha256)};

function log(...a){ document.getElementById('log').textContent += a.join(' ') + '\\n'; }
const auth = () => ({ Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY });
const storageUrl = (p) => SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + p;

function getRev(s){ const r = s?.cloudRevision; return (typeof r==='number'&&r>=0)?Math.floor(r):0; }
function nextRev(r){ return getRev({cloudRevision:r})+1; }

function prepareCloudSnapshot(state){
  const strip = d => d?.storagePath ? { ...d, data: null } : d;
  const next = { ...state };
  if (Array.isArray(next.docs)) next.docs = next.docs.map(strip);
  if (Array.isArray(next.contacts)) next.contacts = next.contacts.map(c => {
    if (!c?.docs) return c;
    return { ...c, docs: c.docs.map(strip) };
  });
  return next;
}

function metrics(state){
  const J='zfjnvrxmo8rj9ui';
  const j=(state.projs||[]).find(p=>p.id===J);
  const jp=(state.pays||[]).filter(p=>p.pid===J);
  const js=Math.round(jp.reduce((s,p)=>s+(Number(p.amt)||0),0));
  const cos=j?.changeOrders||[];
  const ap=cos.filter(c=>c.status==='approved').reduce((s,c)=>s+(Number(c.amt)||0),0);
  const cv=Math.round((j?.originalContract||0)+ap);
  const cab=cos.some(c=>Number(c.amt)===9450);
  const elec=(state.projs||[]).find(p=>p.id==='m4gk3isms3o72gt');
  const cs=Math.round((state.pays||[]).filter(p=>p.pid==='p1').reduce((s,p)=>s+(Number(p.amt)||0),0));
  return {
    projs:(state.projs||[]).length,pays:(state.pays||[]).length,contacts:(state.contacts||[]).length,
    jordanContract:cv,jordanExpenses:js,cabinetsCO9450:cab,
    jordanElectrical49000:(elec?.originalContract===49000||elec?.totalBudget===49000),
    cantonExpenses:cs, cloudRevision:getRev(state)
  };
}

(async () => {
  const status = document.getElementById('status');
  try {
    const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
    const json = new TextDecoder('utf-8').decode(bytes);
    const recovered = JSON.parse(json);
    log('Loaded recovery payload, pays:', recovered.pays.length);

    const curRes = await fetch(storageUrl(STATE_PATH), { headers: auth() });
    if (!curRes.ok) throw new Error('Fetch current cloud failed: ' + curRes.status);
    const current = await curRes.json();
    const revBefore = getRev(current);
    log('Current cloud revision:', revBefore);
    log('Before metrics:', JSON.stringify(metrics(current)));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = BACKUP_PREFIX + stamp + '.json';
    const archRes = await fetch(storageUrl(archivePath), {
      method: 'PUT', headers: { ...auth(), 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify(current),
    });
    if (!archRes.ok) throw new Error('Archive failed: ' + archRes.status + ' ' + await archRes.text());
    log('Archived previous production to:', archivePath);

    const snap = prepareCloudSnapshot(recovered);
    const { cloudRevision: _d, ...rest } = snap;
    const payload = {
      schemaVersion: 1,
      ...rest,
      savedAt: Date.now(),
      cloudRevision: nextRev(revBefore),
      _restoredFrom: ${JSON.stringify(SOURCE)},
      _restoredAt: Date.now(),
      _recoverySha256: RECOVERY_SHA,
    };

    const putRes = await fetch(storageUrl(STATE_PATH), {
      method: 'PUT', headers: { ...auth(), 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify(payload),
    });
    if (!putRes.ok) throw new Error('Restore PUT failed: ' + putRes.status + ' ' + await putRes.text());
    log('Restore PUT ok, new revision:', payload.cloudRevision);

    const verifyRes = await fetch(storageUrl(STATE_PATH), { headers: auth() });
    const after = await verifyRes.json();
    const m = metrics(after);
    const revAfter = getRev(after);

    const listRes = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: BACKUP_PREFIX, limit: 10, sortBy: { column: 'created_at', order: 'desc' } }),
    });
    const backups = listRes.ok ? await listRes.json() : [];
    const archiveListed = Array.isArray(backups) && backups.some(b => b.name === archivePath.split('/').pop());

    const checks = {
      projs3: m.projs===3, pays81: m.pays===81, contacts18: m.contacts===18,
      jordanContract67575: m.jordanContract===67575, jordanExpenses40393: m.jordanExpenses===40393,
      cabinetsCO9450: m.cabinetsCO9450, jordanElectrical49000: m.jordanElectrical49000,
      cantonExpenses134937: m.cantonExpenses===134937,
      cloudRevisionAdvanced: revAfter === revBefore + 1,
      archiveListed,
    };
    const allPass = Object.values(checks).every(Boolean);
    log('\\nAfter metrics:', JSON.stringify(m));
    log('Checks:', JSON.stringify(checks, null, 2));
    log('Recent backups:', JSON.stringify((backups||[]).slice(0,5).map(b=>b.name)));

    status.innerHTML = allPass
      ? '<span class="ok">Production restore complete — all checks passed.</span>'
      : '<span class="err">Restore finished but some checks failed — see log.</span>';
  } catch (e) {
    status.innerHTML = '<span class="err">Failed: ' + e.message + '</span>';
    log('ERROR:', e.message);
  }
})();
</script></body></html>`;

fs.writeFileSync(OUT, html, "utf8");
console.log(JSON.stringify({ ok: true, out: OUT, url: "http://127.0.0.1:3333/.production-recovery-restore.html", sha256 }, null, 2));
