/**
 * Run in browser DevTools console while the app is open (same origin).
 * Tests edit + delete sync against YOUR real localStorage data.
 *
 * Usage:
 *   1. npm run dev → open project in browser
 *   2. DevTools → Console → paste this entire file
 *   3. await verifyPaymentSync({ contractorName: "United Land", paymentNum: 2 })
 *
 * Optional: pass paymentId if you know it.
 */

async function verifyPaymentSync(opts = {}) {
  const KEY = "cc_data_v1";
  const raw = localStorage.getItem(KEY);
  if (!raw) {
    console.error("No cc_data_v1 in localStorage");
    return;
  }
  const data = JSON.parse(raw);
  let pays = [...(data.pays || [])];
  let contacts = JSON.parse(JSON.stringify(data.contacts || []));

  const findContractor = () => {
    if (opts.contractorId)
      return contacts.find((c) => c.id === opts.contractorId);
    const q = (opts.contractorName || "").toLowerCase();
    return contacts.find(
      (c) =>
        c.type === "contractor" &&
        (c.name || "").toLowerCase().includes(q) ||
        (c.co || "").toLowerCase().includes(q),
    );
  };

  const con = findContractor();
  if (!con) {
    console.error("Contractor not found. Pass contractorName or contractorId.");
    return;
  }

  let pmt = opts.paymentId
    ? (con.pmts || []).find((p) => p.id === opts.paymentId)
    : (con.pmts || []).find((p) => p.num === opts.paymentNum);
  if (!pmt) pmt = (con.pmts || []).find((p) => p.status === "paid");
  if (!pmt) {
    console.error("No matching paid payment on contractor", con.name);
    return;
  }
  if (pmt.status !== "paid") {
    console.warn("Payment is not paid — budget sync only applies to paid payments.");
  }

  const projectId =
    opts.projectId ||
    (con.scopes || []).find((s) => s.id === pmt.scopeId)?.pid ||
    (con.pids || [])[0];

  const sumProject = (list) =>
    list.filter((p) => p.pid === projectId).reduce((s, p) => s + (Number(p.amt) || 0), 0);

  const budgetRows = () =>
    pays.filter(
      (p) => p.pmtId === pmt.id && (p.contractorId === con.id || !p.contractorId),
    );

  const orphans = () => {
    const issues = [];
    for (const p of pays) {
      if (!p.pmtId) continue;
      const c = contacts.find((x) => x.id === p.contractorId);
      const pm = c?.pmts?.find((x) => x.id === p.pmtId);
      if (!pm) issues.push(`orphan budget id=${p.id} pmtId=${p.pmtId}`);
      else if (pm.status !== "paid") issues.push(`budget links pending pmt #${pm.num}`);
    }
    const seen = {};
    for (const p of pays.filter((x) => x.pmtId && x.contractorId)) {
      const k = `${p.contractorId}:${p.pmtId}`;
      seen[k] = (seen[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(seen)) {
      if (n > 1) issues.push(`duplicate budget rows ${k} (${n})`);
    }
    return issues;
  };

  // Inline Mu / Uu (same logic as App.jsx)
  const _u = (contact, pm, pid) => {
    const scope = (contact.scopes || []).find((s) => s.id === pm.scopeId);
    const linked = pm.linkedStage && pm.linkedStage !== "—" ? pm.linkedStage : "";
    const stage =
      scope && linked
        ? (scope.stages || []).find((st) => st.name === linked)
        : null;
    return {
      pid,
      date: pm.paidDate || pm.due || new Date().toISOString().slice(0, 10),
      amt: Number(pm.amt) || 0,
      to: contact.name,
      vendor: contact.name,
      description: (pm.milestone || linked || "").trim() || `Payment #${pm.num}`,
      pmtId: pm.id,
      contractorId: contact.id,
      scopeId: pm.scopeId || scope?.id || "",
      phId: scope?.phId || "",
      stageId: stage?.id || "",
      source: "pmt",
      status: "paid",
      paidDate: pm.paidDate || "",
    };
  };

  const ju = (list, cid, pid) =>
    list.findIndex(
      (p) => p.pmtId === pid && (p.contractorId === cid || !p.contractorId),
    );

  const Mu = (list, contact, pm, pid) => {
    const next = _u(contact, pm, pid);
    const idx = ju(list, contact.id, pm.id);
    if (idx >= 0) {
      const q = [...list];
      q[idx] = { ...q[idx], ...next, amt: next.amt, date: next.date };
      return q;
    }
    return [...list, { ...next, id: "verify_" + pm.id }];
  };

  const Uu = (list, cid, pid) =>
    list.filter(
      (p) => !(p.pmtId === pid && (p.contractorId === cid || !p.contractorId)),
    );

  const log = (step, extra = {}) => {
    console.log(`\n--- ${step} ---`);
    console.log({
      payment: `#${pmt.num} $${pmt.amt} (${pmt.status})`,
      budgetRows: budgetRows().map((r) => ({ id: r.id, amt: r.amt })),
      projectExpenses: sumProject(pays),
      orphans: orphans(),
      ...extra,
    });
  };

  console.log("Testing contractor:", con.name, "| payment #", pmt.num, "| project", projectId);
  log("BEFORE");

  const originalAmt = pmt.amt;
  const newAmt = opts.newAmt ?? originalAmt + 100;

  // 1–4 Edit (simulate paid edit → Mu)
  pmt = { ...pmt, amt: newAmt };
  con.pmts = (con.pmts || []).map((p) => (p.id === pmt.id ? pmt : p));
  if (pmt.status === "paid") pays = Mu(pays, con, pmt, projectId);
  log("AFTER EDIT (+$100 or newAmt)", { expectedDelta: newAmt - originalAmt });

  const editOk =
    pmt.status !== "paid" ||
    (budgetRows().length === 1 && budgetRows()[0].amt === newAmt);
  console.log(editOk ? "✓ Edit sync OK" : "✗ Edit sync FAILED");

  // 5–7 Delete (simulate mr → Uu)
  const expensesBeforeDelete = sumProject(pays);
  con.pmts = (con.pmts || []).filter((p) => p.id !== pmt.id);
  pays = Uu(pays, con.id, pmt.id);
  log("AFTER DELETE");

  const deleteOk =
    budgetRows().length === 0 &&
    orphans().length === 0 &&
    sumProject(pays) === expensesBeforeDelete - (pmt.status === "paid" ? newAmt : 0);
  console.log(deleteOk ? "✓ Delete sync OK" : "✗ Delete sync FAILED");

  console.log(
    "\n⚠️  This script does NOT write localStorage — it only simulates in memory.",
  );
  console.log(
    "To test the live app: edit/delete in UI, then re-run with pays from localStorage before/after.",
  );

  return { editOk, deleteOk, con, pmt, pays, orphans: orphans() };
}

window.verifyPaymentSync = verifyPaymentSync;

/** Read-only: inspect live localStorage sync state (safe — no writes). */
function inspectPaymentSync(opts = {}) {
  const KEY = "cc_data_v1";
  const raw = localStorage.getItem(KEY);
  if (!raw) return console.error("No cc_data_v1 in localStorage");

  const data = JSON.parse(raw);
  const pays = data.pays || [];
  const contacts = data.contacts || [];
  const projs = data.projs || [];

  const q = (opts.contractorName || "").toLowerCase();
  const con = opts.contractorId
    ? contacts.find((c) => c.id === opts.contractorId)
    : contacts.find(
        (c) =>
          c.type === "contractor" &&
          ((c.name || "").toLowerCase().includes(q) ||
            (c.co || "").toLowerCase().includes(q)),
      );

  if (!con) return console.error("Contractor not found");

  const pmts = con.pmts || [];
  const paid = pmts.filter((p) => p.status === "paid");

  const budgetFor = (pmt) =>
    pays.filter(
      (p) => p.pmtId === pmt.id && (p.contractorId === con.id || !p.contractorId),
    );

  const orphans = [];
  for (const p of pays) {
    if (!p.pmtId) continue;
    const c = contacts.find((x) => x.id === p.contractorId);
    const pm = c?.pmts?.find((x) => x.id === p.pmtId);
    if (!pm) orphans.push({ type: "missing_pmt", budgetId: p.id, pmtId: p.pmtId });
    else if (pm.status !== "paid")
      orphans.push({ type: "pending_pmt", budgetId: p.id, pmtNum: pm.num });
  }

  const pid =
    opts.projectId ||
    projs.find((p) => (con.pids || []).includes(p.id))?.id ||
    (con.pids || [])[0];

  const projectExpenses = pays
    .filter((p) => p.pid === pid)
    .reduce((s, p) => s + (Number(p.amt) || 0), 0);

  const report = {
    contractor: con.name,
    projectId: pid,
    projectExpenses,
    paidPayments: paid.map((p) => ({
      num: p.num,
      id: p.id,
      amt: p.amt,
      budgetRows: budgetFor(p).map((b) => ({ id: b.id, amt: b.amt, source: b.source })),
      inSync: budgetFor(p).length === 1 && budgetFor(p)[0]?.amt === p.amt,
    })),
    orphanBudgetRows: orphans,
    duplicatePmtLinks: (() => {
      const d = {};
      for (const p of pays.filter((x) => x.pmtId && x.contractorId)) {
        const k = `${p.contractorId}:${p.pmtId}`;
        d[k] = (d[k] || 0) + 1;
      }
      return Object.entries(d).filter(([, n]) => n > 1);
    })(),
  };

  console.table(report.paidPayments);
  if (orphans.length) console.warn("Orphans:", orphans);
  else console.log("No orphaned budget rows ✓");
  console.log("Project expenses (Dashboard + Reports):", projectExpenses);
  return report;
}

window.inspectPaymentSync = inspectPaymentSync;
console.log("Loaded.");
console.log("  inspectPaymentSync({ contractorName: 'United' })  — read-only live check");
console.log("  verifyPaymentSync({ contractorName: 'United' })   — in-memory simulation");
