/**
 * Patch remaining Jordan Electrical text corruption on localhost only.
 * Text fields only — no financial/structure changes.
 *
 * Usage: node scripts/patch-jordan-electrical-text-localhost.mjs
 * Then open http://127.0.0.1:3333/.jul29-jordan-electrical-text-patch.html
 */
import fs from "fs";
import crypto from "crypto";

const INJECT_OUT = "public/.jul29-jordan-electrical-text-patch.html";

const BAD = /뿯|×|â€|ï¿½|\uFFFD|↽/;

/** Group label: English matches this project's stage naming; original Hebrew was lost in Jul29 backup. */
const ELECTRICAL_GROUP = "Electrical";

const TEXT_PATCHES = [
  {
    path: "phases[f4m35p0ms3oag9v].group",
    replacement: ELECTRICAL_GROUP,
  },
  {
    path: "phases[cad17zams3ol75i].group",
    replacement: ELECTRICAL_GROUP,
  },
  {
    path: "contacts[90p577lmof92g3e].pmts[54y8i9pmrsqh1rs].milestone",
    replacement: "Electrical — Panel Upgrade & Garage — Final Inspection",
  },
  {
    path: "pays[kxut5dhmrsqh2xg].notes",
    replacement: "Payment #2 — Electrical — Panel Upgrade & Garage — Final Inspection",
  },
];

function parsePath(path) {
  const tokens = [];
  const root = path.match(/^([a-z]+)/);
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
      tokens.push({ kind: "field", key: field[1] });
      i += 1 + field[1].length;
    } else i++;
  }
  return tokens;
}

function getFieldLoc(state, tokens) {
  let cur = state[tokens[0].key];
  for (let t = 1; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === "id") {
      cur = cur.find((x) => x?.id === tok.value);
      if (!cur) return null;
    } else if (tok.kind === "field") {
      if (t === tokens.length - 1) return { target: cur, field: tok.key };
      cur = cur[tok.key];
    }
  }
  return null;
}

function setFieldValue(state, path, value) {
  const loc = getFieldLoc(state, parsePath(path));
  if (!loc) throw new Error(`Cannot resolve: ${path}`);
  loc.target[loc.field] = value;
}

function getFieldValue(state, path) {
  const loc = getFieldLoc(state, parsePath(path));
  return loc ? loc.target[loc.field] : undefined;
}

function buildInjectHtml(patches) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Jordan Electrical text patch</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}.ok{color:#047857}.warn{color:#b45309}</style>
</head><body>
<h1>Jordan Electrical text patch → localStorage</h1>
<p id="status">Applying…</p>
<p class="warn"><strong>Block Supabase</strong> before opening the main app.</p>
<p><a id="appLink" href="/" style="display:none">Open app →</a></p>
<script>
const PATCHES = ${JSON.stringify(patches)};
function parsePath(path){const tokens=[];const root=path.match(/^([a-z]+)/);tokens.push({kind:'root',key:root[1]});let i=root[1].length;while(i<path.length){if(path[i]==='['){const end=path.indexOf(']',i);let inner=path.slice(i+1,end);if(inner.includes('|'))inner=inner.split('|')[0];tokens.push({kind:'id',value:inner.trim()});i=end+1;}else if(path[i]==='.'){const field=path.slice(i+1).match(/^([a-z]+)/);tokens.push({kind:'field',key:field[1]});i+=1+field[1].length;}else i++;}return tokens;}
function setField(state,tokens,value){let cur=state[tokens[0].key];for(let t=1;t<tokens.length;t++){const tok=tokens[t];if(tok.kind==='id'){cur=cur.find(x=>x?.id===tok.value);if(!cur)throw new Error('missing id '+tok.value);}else if(tok.kind==='field'){if(t===tokens.length-1){cur[tok.key]=value;return;}cur=cur[tok.key];}}}
(async () => {
  const status = document.getElementById('status');
  try {
    const existing = localStorage.getItem('cc_data_v1');
    if (!existing) throw new Error('No cc_data_v1 — run recovery inject first');
    const state = JSON.parse(existing);
    for (const p of PATCHES) setField(state, parsePath(p.path), p.replacement);
    localStorage.setItem('cc_data_v1', JSON.stringify(state));
    const ph = state.phases.filter(p=>p.pid==='m4gk3isms3o72gt');
    const robert = state.contacts.find(c=>c.id==='90p577lmof92g3e');
    status.innerHTML = '<span class="ok">Patched.</span><br>groups: ' + ph.map(p=>p.group).join(' | ')
      + '<br>Robert milestone: ' + robert.pmts.find(p=>p.id==='54y8i9pmrsqh1rs').milestone;
    document.getElementById('appLink').style.display = 'inline';
  } catch (e) { status.textContent = 'Failed: ' + e.message; }
})();
</script></body></html>`;
}

fs.writeFileSync(INJECT_OUT, buildInjectHtml(TEXT_PATCHES));

console.log(
  JSON.stringify(
    {
      ok: true,
      injectUrl: "http://127.0.0.1:3333/.jul29-jordan-electrical-text-patch.html",
      groupHeaderField: "phases[].group → blue h3 in construction stages (pt.map v.name)",
      phaseIds: ["f4m35p0ms3oag9v", "cad17zams3ol75i"],
      patches: TEXT_PATCHES,
      note: "Group replacement is English 'Electrical' — no ID-matched Hebrew source exists in any backup",
    },
    null,
    2,
  ),
);
