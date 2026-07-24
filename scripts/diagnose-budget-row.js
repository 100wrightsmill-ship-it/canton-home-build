/**
 * Explains why a budget row is or isn't removed by Ru() / If() on app load.
 * Paste in browser DevTools console (app must be open on same origin).
 *
 *   diagnoseBudgetRow({ amt: 10873979 })
 *   diagnoseBudgetRow({ id: "pay_abc123" })
 */

function diagnoseBudgetRow(opts = {}) {
  const KEY = "cc_data_v1";
  const raw = localStorage.getItem(KEY);
  if (!raw) return console.error("No cc_data_v1 in localStorage");

  const data = JSON.parse(raw);
  const pays = data.pays || [];
  const contacts = data.contacts || [];

  const nu = (contact, pay) => {
    const lc = (s) => String(s || "").trim().toLowerCase();
    const name = lc(contact.name);
    const co = lc(contact.co);
    const to = lc(pay.to || pay.vendor);
    return (
      !!to &&
      (to === name ||
        (!!co && to === co) ||
        (!!name &&
          !!co &&
          (to === lc(`${contact.name} — ${contact.co}`) ||
            to === lc(`${contact.name} - ${contact.co}`))) ||
        (!!name && !!co && to.includes(name) && to.includes(co)))
    );
  };

  const paidKeys = new Set();
  for (const c of contacts) {
    for (const p of c.pmts || []) {
      if (p.status === "paid") paidKeys.add(`${c.id}:${p.id}`);
    }
  }

  const explainRu = (pay) => {
    if (pay.source === "pmt" && !pay.pmtId) {
      const match = contacts.some((c) =>
        (c.pmts || []).some(
          (p) =>
            p.status === "paid" &&
            nu(c, pay) &&
            Number(p.amt) === Number(pay.amt),
        ),
      );
      return {
        ruWouldKeep: match,
        branch: "source=pmt, no pmtId",
        detail: match
          ? "Kept: matches another live paid contractor payment (amount + vendor)."
          : "Removed by Ru: no matching paid payment.",
      };
    }
    if (!pay.pmtId) {
      return {
        ruWouldKeep: true,
        branch: "no pmtId",
        detail: `Kept by Ru: rows without pmtId are preserved unless source is exactly "pmt". This row has source=${JSON.stringify(pay.source || "(missing)")}.`,
      };
    }
    if (pay.contractorId) {
      const key = `${pay.contractorId}:${pay.pmtId}`;
      const keep = paidKeys.has(key);
      return {
        ruWouldKeep: keep,
        branch: "has pmtId + contractorId",
        detail: keep
          ? `Kept: paid payment still exists (${key}).`
          : `Removed by Ru: no paid payment at ${key} (deleted or pending).`,
      };
    }
    const keep = contacts.some((c) =>
      (c.pmts || []).some((p) => p.id === pay.pmtId && p.status === "paid"),
    );
    return {
      ruWouldKeep: keep,
      branch: "has pmtId, no contractorId",
      detail: keep
        ? "Kept: some contractor still has this pmtId as paid."
        : "Removed by Ru: pmtId not found as paid on any contractor.",
    };
  };

  const scopeCostSources = [];
  for (const c of contacts) {
    for (const sc of c.scopes || []) {
      for (const cost of sc.costs || []) {
        scopeCostSources.push({
          contractor: c.name,
          contractorId: c.id,
          scopeId: sc.id,
          scopeTitle: sc.title || sc.desc,
          costId: cost.id,
          amt: cost.amt,
          vendor: cost.vendor,
          description: cost.description,
          pmtId: cost.pmtId || "",
        });
      }
    }
  }

  let rows = pays;
  if (opts.id) rows = pays.filter((p) => p.id === opts.id);
  else if (opts.amt != null)
    rows = pays.filter((p) => Number(p.amt) === Number(opts.amt));
  else if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = pays.filter(
      (p) =>
        (p.to || "").toLowerCase().includes(q) ||
        (p.vendor || "").toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q) ||
        (p.notes || "").toLowerCase().includes(q),
    );
  }

  if (!rows.length) {
    console.warn("No matching pays[] row. Checking scope.costs[] (If() re-import)...");
    const costMatches = scopeCostSources.filter(
      (c) =>
        (opts.amt != null && Number(c.amt) === Number(opts.amt)) ||
        (opts.q &&
          JSON.stringify(c).toLowerCase().includes(String(opts.q).toLowerCase())),
    );
    if (costMatches.length) {
      console.log(
        "Found in scope.costs — If() re-adds these to Budget on EVERY page load:",
      );
      console.table(costMatches);
      return { inPays: [], scopeCosts: costMatches };
    }
    console.error("No match in pays or scope.costs");
    return null;
  }

  const report = rows.map((pay) => {
    const ru = explainRu(pay);
    const linkedPmt = pay.pmtId
      ? contacts
          .flatMap((c) =>
            (c.pmts || []).map((p) => ({ ...p, contractorId: c.id, contractorName: c.name })),
          )
          .find((p) => p.id === pay.pmtId)
      : null;

    const scopeCost = scopeCostSources.find(
      (c) =>
        c.costId === pay.id ||
        (Number(c.amt) === Number(pay.amt) &&
          c.contractorId === pay.contractorId &&
          pay.scopeId === c.scopeId),
    );

    const ifWouldReAdd = scopeCostSources.some(
      (c) => c.costId === pay.id || (scopeCost && c.costId === scopeCost.costId),
    );

    return {
      id: pay.id,
      amt: pay.amt,
      to: pay.to,
      vendor: pay.vendor,
      description: pay.description,
      source: pay.source || "(missing)",
      pmtId: pay.pmtId || "(none)",
      contractorId: pay.contractorId || "(none)",
      pid: pay.pid,
      linkedPayment: linkedPmt
        ? `#${linkedPmt.num} ${linkedPmt.status} $${linkedPmt.amt} (${linkedPmt.contractorName})`
        : pay.pmtId
          ? "MISSING — payment deleted"
          : "none",
      ruBranch: ru.branch,
      ruWouldKeep: ru.ruWouldKeep,
      ruDetail: ru.detail,
      scopeCostStillPresent: !!scopeCost,
      ifReImportRisk: scopeCostSources.some(
        (c) =>
          !pays.some((p) => p.id === c.costId) &&
          Number(c.amt) === Number(pay.amt),
      )
        ? "scope.costs[] has entries If() may re-import after Ru()"
        : scopeCost
          ? "matching scope.costs entry exists"
          : "none",
    };
  });

  console.log("\n=== Budget row diagnosis ===\n");
  console.table(report);
  for (const r of report) {
    console.log(`\nRow ${r.id} ($${Number(r.amt).toLocaleString()}):`);
    console.log("  Fields:", {
      source: r.source,
      pmtId: r.pmtId,
      contractorId: r.contractorId,
      to: r.to,
      vendor: r.vendor,
    });
    console.log("  Ru():", r.ruDetail);
    if (r.linkedPayment === "MISSING — payment deleted" && r.ruWouldKeep) {
      console.warn(
        "  ⚠️ Unexpected: Ru says KEEP but payment is missing — report this.",
      );
    }
    if (r.ruWouldKeep && r.source !== "pmt" && !r.pmtId) {
      console.warn(
        "  ⚠️ This is why cleanup skipped it: generic budget row (no pmtId, source≠pmt).",
      );
    }
    if (scopeCostSources.length) {
      const rel = scopeCostSources.filter(
        (c) => Number(c.amt) === Number(r.amt),
      );
      if (rel.length) {
        console.warn("  ⚠️ scope.costs[] still has same-amount entries:", rel);
      }
    }
  }

  if (scopeCostSources.length) {
    console.log("\nAll scope.costs[] pending If() import:", scopeCostSources);
  } else {
    console.log("\nNo scope.costs[] entries in localStorage (If() won't re-import).");
  }

  return report;
}

window.diagnoseBudgetRow = diagnoseBudgetRow;
console.log("diagnoseBudgetRow loaded. Example:");
console.log('  diagnoseBudgetRow({ amt: 10873979 })');
