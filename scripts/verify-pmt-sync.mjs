/**
 * End-to-end sync verification for contractor paid payments.
 * Mirrors Mu / Uu / _u / RpSummary / Dashboard expense math from src/App.jsx.
 *
 * Run: node scripts/verify-pmt-sync.mjs
 */

const PROJECT_ID = "zfjnvrxmo8rj9ui";
const CONTRACTOR_ID = "co_test_sync";
const PMT_ID = "pmt_test_sync";

// --- minimal copies of App.jsx helpers ---

const wu = (e) => {
  if (e == null || e === "") return "";
  const t = String(e).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return "";
};

const _u = (contact, pmt, projectId) => {
  const scope = (contact.scopes || []).find((s) => s.id === pmt.scopeId);
  const linked = pmt.linkedStage && pmt.linkedStage !== "—" ? pmt.linkedStage : "";
  const stage =
    scope && linked ? (scope.stages || []).find((st) => st.name === linked) : null;
  return {
    pid: projectId,
    date: pmt.paidDate || wu(pmt.due) || "2026-04-01",
    amt: Number(pmt.amt) || 0,
    to: contact.name,
    vendor: contact.name,
    description: (pmt.milestone || linked || "").trim() || `Payment #${pmt.num}`,
    method: pmt.method || "",
    cat: "Labor",
    costCat: "labor",
    notes: `Payment #${pmt.num} — ${pmt.milestone || linked || ""}`,
    conf: pmt.conf || "",
    phId: scope?.phId || "",
    scopeId: pmt.scopeId || scope?.id || "",
    stageId: stage?.id || "",
    pmtId: pmt.id,
    contractorId: contact.id,
    status: "paid",
    paidDate: pmt.paidDate || "",
    source: "pmt",
  };
};

const Ou = (existing, next) => ({
  ...existing,
  pmtId: next.pmtId,
  contractorId: next.contractorId,
  scopeId: next.scopeId || existing.scopeId,
  phId: next.phId || existing.phId,
  stageId: next.stageId || existing.stageId,
  pid: next.pid || existing.pid,
  source: "pmt",
  costCat: existing.costCat || next.costCat || "labor",
  cat: existing.cat || next.cat || "Labor",
  amt: next.amt,
  date: next.date,
  to: next.to,
  vendor: next.vendor,
  description: next.description,
  method: next.method,
  notes: next.notes,
  paidDate: next.paidDate,
  status: "paid",
});

const ju = (pays, contractorId, pmtId) =>
  pays.findIndex(
    (p) => p.pmtId === pmtId && (p.contractorId === contractorId || !p.contractorId),
  );

const Nu = (contact, pay) => {
  const lc = (s) => String(s || "").trim().toLowerCase();
  const name = lc(contact.name);
  const co = lc(contact.co);
  const to = lc(pay.to);
  return (
    !!to &&
    (to === name || (!!co && to === co) || (!!name && !!co && to.includes(name) && to.includes(co)))
  );
};

const Tu = (pays, contact, pmt, projectId) => {
  const ft = _u(contact, pmt, projectId);
  return pays.findIndex(
    (p) =>
      !p.pmtId &&
      !p.contractorId &&
      p.pid === ft.pid &&
      Number(p.amt) === Number(ft.amt) &&
      p.date === ft.date &&
      Nu(contact, p),
  );
};

const zu = (pays, contact, pmt, projectId, kept) => {
  const keepId = kept.id;
  return pays.filter(
    (p) =>
      p.id === keepId ||
      !(
        (p.pmtId === pmt.id && (p.contractorId === contact.id || !p.contractorId)) ||
        (!p.pmtId &&
          !p.contractorId &&
          p.pid === kept.pid &&
          Number(p.amt) === Number(kept.amt) &&
          p.date === kept.date &&
          Nu(contact, p))
      ),
  );
};

const Mu = (pays, contact, pmt, projectId) => {
  const next = _u(contact, pmt, projectId);
  let idx = ju(pays, contact.id, pmt.id);
  if (idx >= 0) {
    const q = [...pays];
    q[idx] = Ou(q[idx], next);
    return zu(q, contact, pmt, projectId, q[idx]);
  }
  const orphanIdx = Tu(pays, contact, pmt, projectId);
  if (orphanIdx >= 0) {
    const q = [...pays];
    q[orphanIdx] = Ou(q[orphanIdx], next);
    return zu(q, contact, pmt, projectId, q[orphanIdx]);
  }
  const q = [...pays, { ...next, id: `pay_${pmt.id}` }];
  return zu(q, contact, pmt, projectId, q[q.length - 1]);
};

const Uu = (pays, contractorId, pmtId, contact, pmt) =>
  pays.filter((p) => {
    if (p.pmtId === pmtId) return false;
    if (
      pmt &&
      contact &&
      (p.source === "pmt" || p.pmtId === pmtId) &&
      (!p.pmtId || p.pmtId === pmtId) &&
      (p.contractorId === contractorId || !p.contractorId) &&
      Nu(contact, p) &&
      Number(p.amt) === Number(pmt.amt)
    )
      return false;
    return true;
  });

// Dashboard: sum of pays for project (ng + ig dashboard)
const dashboardExpenses = (pays, pid) =>
  pays.filter((p) => p.pid === pid).reduce((s, p) => s + Number(p.amt) || 0, 0);

// Reports: RpSummary expenses
const RpPayAmt = (p) => Number(p.amt) || 0;
const reportExpenses = (pays, pid) =>
  pays.filter((p) => p.pid === pid).reduce((s, p) => s + RpPayAmt(p), 0);

const findOrphans = (pays, contacts) => {
  const issues = [];
  const pmtKeys = new Set();
  for (const c of contacts) {
    for (const p of c.pmts || []) {
      pmtKeys.add(`${c.id}:${p.id}`);
    }
  }
  for (const p of pays) {
    if (p.pmtId) {
      const key = `${p.contractorId || ""}:${p.pmtId}`;
      const con = contacts.find((c) => c.id === p.contractorId);
      const pmt = con?.pmts?.find((x) => x.id === p.pmtId);
      if (!pmt) issues.push(`Budget row ${p.id} links missing payment pmtId=${p.pmtId}`);
      else if (pmt.status !== "paid")
        issues.push(`Budget row ${p.id} links non-paid payment #${pmt.num}`);
    }
  }
  const linked = pays.filter((p) => p.pmtId && p.contractorId);
  const dup = new Map();
  for (const p of linked) {
    const k = `${p.contractorId}:${p.pmtId}`;
    dup.set(k, (dup.get(k) || 0) + 1);
  }
  for (const [k, n] of dup) {
    if (n > 1) issues.push(`Duplicate budget rows for payment ${k} (${n} rows)`);
  }
  return issues;
};

// --- fixture: Jordan-style project with one paid contractor payment ---

function makeFixture() {
  const contact = {
    id: CONTRACTOR_ID,
    name: "Test Contractor LLC",
    co: "Test Contractor",
    type: "contractor",
    pids: [PROJECT_ID],
    pmts: [
      {
        id: PMT_ID,
        num: 1,
        amt: 1260,
        due: "2026-04-15",
        milestone: "Final payment",
        linkedStage: "Survey complete",
        scopeId: "scope_test",
        status: "paid",
        paidDate: "2026-04-15",
        method: "Check",
        conf: "CHK-001",
        notes: "",
      },
    ],
    scopes: [
      {
        id: "scope_test",
        pid: PROJECT_ID,
        phId: "ph_survey",
        title: "Boundary Survey",
        price: 1260,
        stages: [{ id: "st1", name: "Survey complete", status: "complete" }],
      },
    ],
    docs: [],
  };

  let pays = [
    { id: "other1", pid: PROJECT_ID, amt: 108740, to: "Other Vendor", source: "cost" },
  ];
  pays = Mu(pays, contact, contact.pmts[0], PROJECT_ID);

  return { contact, pays, baselineOther: 108740 };
}

function updateContactPmt(contact, pmtId, patch) {
  return {
    ...contact,
    pmts: (contact.pmts || []).map((p) => (p.id === pmtId ? { ...p, ...patch } : p)),
  };
}

function deleteContactPmt(contact, pmtId) {
  return {
    ...contact,
    pmts: (contact.pmts || []).filter((p) => p.id !== pmtId),
  };
}

// --- test runner ---

let passed = 0;
let failed = 0;

function assert(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== Contractor payment sync verification ===\n");

let { contact, pays, baselineOther } = makeFixture();
const contacts = [contact];

const budgetRow = () =>
  pays.find((p) => p.pmtId === PMT_ID && p.contractorId === CONTRACTOR_ID);

// Initial state
console.log("0. Initial state (after Mark Paid → Mu)");
assert("Budget has linked row for payment", !!budgetRow());
assert("Budget row amount is $1,260", budgetRow()?.amt === 1260);
assert(
  "Dashboard expenses include payment",
  dashboardExpenses(pays, PROJECT_ID) === baselineOther + 1260,
);
assert(
  "Reports expenses match dashboard",
  reportExpenses(pays, PROJECT_ID) === dashboardExpenses(pays, PROJECT_ID),
);
assert("No orphans initially", findOrphans(pays, contacts).length === 0);

// Step 1–4: Edit paid payment amount 1260 → 1500
console.log("\n1–4. Edit paid payment: $1,260 → $1,500");
contact = updateContactPmt(contact, PMT_ID, { amt: 1500 });
const editedPmt = contact.pmts.find((p) => p.id === PMT_ID);
pays = Mu(pays, contact, editedPmt, PROJECT_ID);
contacts[0] = contact;

assert("Budget row still exists", !!budgetRow());
assert("Budget row updated to $1,500", budgetRow()?.amt === 1500);
assert(
  "Dashboard expenses increased by $240",
  dashboardExpenses(pays, PROJECT_ID) === baselineOther + 1500,
);
assert(
  "Reports expenses match dashboard after edit",
  reportExpenses(pays, PROJECT_ID) === dashboardExpenses(pays, PROJECT_ID),
);
assert("Still exactly one budget row for this payment", 
  pays.filter((p) => p.pmtId === PMT_ID && p.contractorId === CONTRACTOR_ID).length === 1);
assert("No orphans after edit", findOrphans(pays, contacts).length === 0);

// Step 5–8: Delete payment
console.log("\n5–8. Delete payment");
contact = deleteContactPmt(contact, PMT_ID);
pays = Uu(pays, CONTRACTOR_ID, PMT_ID, contact, editedPmt);
contacts[0] = contact;

assert("Contractor has no payments left", (contact.pmts || []).length === 0);
assert("Budget row removed", !budgetRow());
assert(
  "Dashboard expenses back to baseline only",
  dashboardExpenses(pays, PROJECT_ID) === baselineOther,
);
assert(
  "Reports expenses match dashboard after delete",
  reportExpenses(pays, PROJECT_ID) === dashboardExpenses(pays, PROJECT_ID),
);
assert(
  "No budget rows reference deleted pmtId",
  pays.every((p) => p.pmtId !== PMT_ID),
);
const orphanIssues = findOrphans(pays, contacts);
assert("No orphaned records", orphanIssues.length === 0, orphanIssues.join("; "));

// Orphan budget row (no pmtId) — reproduces real-world delete bug
console.log("\n9. Delete removes orphan budget row (no pmtId, source: pmt)");
{
  let { contact: c2, pays: p2 } = makeFixture();
  const pmt = c2.pmts[0];
  p2.push({
    id: "orphan_budget",
    pid: PROJECT_ID,
    amt: pmt.amt,
    to: c2.name,
    vendor: c2.name,
    source: "pmt",
    contractorId: CONTRACTOR_ID,
    // deliberately missing pmtId — old sync bug left these behind
  });
  assert("Orphan row present before delete", p2.some((p) => p.id === "orphan_budget"));
  c2 = deleteContactPmt(c2, PMT_ID);
  p2 = Uu(p2, CONTRACTOR_ID, PMT_ID, c2, pmt);
  assert("Orphan budget row removed on delete", !p2.some((p) => p.id === "orphan_budget"));
  assert(
    "Linked budget row also removed",
    !p2.some((p) => p.pmtId === PMT_ID),
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
