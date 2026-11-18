#!/usr/bin/env node
/** Verify staging assembled state has no raw ISO date leaks. */
import { loadStagingEnv } from "./load-staging-env.mjs";
import { fromDbDate, formatDisplayDate } from "../../src/db/dates.js";

loadStagingEnv();

const API = process.env.STAGING_API_URL || "http://localhost:3334";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function checkDateField(path, v) {
  if (v == null || v === "") return [];
  const s = String(v);
  if (ISO_RE.test(s)) return [`${path}: raw ISO "${s}"`];
  if (s === "null" || s === "undefined") return [`${path}: null artifact "${s}"`];
  return [];
}

async function main() {
  const res = await fetch(`${API}/api/state`);
  const { state } = await res.json();
  if (!state) throw new Error("No state from staging API");

  const issues = [];

  for (const p of state.projs || []) {
    issues.push(...checkDateField(`proj.${p.id}.startDate`, p.startDate));
    issues.push(...checkDateField(`proj.${p.id}.contractDate`, p.contractDate));
    for (const co of p.changeOrders || []) {
      issues.push(...checkDateField(`co.${co.id}.date`, co.date));
    }
  }
  for (const py of state.pays || []) {
    issues.push(...checkDateField(`pay.${py.id}.date`, py.date));
    issues.push(...checkDateField(`pay.${py.id}.paidDate`, py.paidDate));
  }
  for (const c of state.contacts || []) {
    issues.push(...checkDateField(`contact.${c.id}.insurance`, c.insurance));
    for (const sc of c.scopes || []) {
      for (const sg of sc.stages || []) {
        issues.push(...checkDateField(`stage.${sg.id}.start`, sg.start));
        issues.push(...checkDateField(`stage.${sg.id}.end`, sg.end));
        if (sg.start && formatDisplayDate(sg.start)) {
          // sample display format
        }
      }
    }
    for (const pmt of c.pmts || []) {
      issues.push(...checkDateField(`pmt.${pmt.id}.due`, pmt.due));
      issues.push(...checkDateField(`pmt.${pmt.id}.paidDate`, pmt.paidDate));
    }
  }

  if (issues.length) {
    console.error("FAIL — date format issues:");
    for (const i of issues) console.error(" ", i);
    process.exit(1);
  }

  // Sample stage display
  const jordan = (state.contacts || []).find((c) =>
    (c.scopes || []).some((s) => s.stages?.length)
  );
  const stage = jordan?.scopes?.flatMap((s) => s.stages || []).find((sg) => sg.start);
  if (stage) {
    console.log("Sample stage start:", stage.start, "→ display:", formatDisplayDate(stage.start));
  }
  console.log("PASS — no raw ISO dates in assembled staging state");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
