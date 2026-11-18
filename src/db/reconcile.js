import { toMoney } from "./money.js";
import { extractRowsFromState } from "./extractRows.js";
import { tableFqn } from "./tableOrder.js";

const JORDAN_ID = "zfjnvrxmo8rj9ui";
const CANTON_ID = "p1";
const JORDAN_ELEC_ID = "m4gk3isms3o72gt";
const ELDER_ID = "w1fmbromutbxlxb";
const ELDER_SCOPE_ID = "u4pihffmutc0o1x";
const CABINETS_CO_ID = "81s9vk1ms3pqzt4";

function nestedScopeCounts(state) {
  let scopes = 0;
  let stages = 0;
  let pmts = 0;
  for (const c of state.contacts ?? []) {
    pmts += (c.pmts ?? []).length;
    for (const sc of c.scopes ?? []) {
      scopes += 1;
      stages += (sc.stages ?? []).length;
    }
  }
  return { scopes, stages, pmts };
}

function computeFinancials(state) {
  const pays = state.pays ?? [];
  const jordan = (state.projs ?? []).find((p) => p.id === JORDAN_ID);
  const jordanContract =
    Number(jordan?.originalContract ?? 0) +
    (jordan?.changeOrders ?? []).reduce((a, co) => a + Number(co.amt ?? 0), 0);
  const jordanExp = pays.filter((p) => p.pid === JORDAN_ID).reduce((a, p) => a + Number(p.amt ?? 0), 0);
  const cantonExp = pays.filter((p) => p.pid === CANTON_ID).reduce((a, p) => a + Number(p.amt ?? 0), 0);
  const cabinetsCo = (jordan?.changeOrders ?? []).find((co) => co.id === CABINETS_CO_ID);
  const elder = (state.contacts ?? []).find((c) => c.id === ELDER_ID);
  const elderScope = elder?.scopes?.find((s) => s.id === ELDER_SCOPE_ID);
  const jelec = (state.projs ?? []).find((p) => p.id === JORDAN_ELEC_ID);

  return {
    jordanContract: toMoney(jordanContract),
    jordanExpenses: toMoney(jordanExp),
    cantonExpenses: toMoney(cantonExp),
    cabinetsCo: toMoney(cabinetsCo?.amt),
    jordanElectrical: toMoney(jelec?.totalBudget),
    elderScope: toMoney(elderScope?.price),
    elderExists: Boolean(elder),
  };
}

/** Snapshot self-consistency + financial extraction — no hardcoded expected totals. */
export function reconcileSnapshot(state) {
  const { tables, warnings: sourceWarnings } = extractRowsFromState(state);
  const pays = state.pays ?? [];
  const { scopes, stages, pmts } = nestedScopeCounts(state);
  const financials = computeFinancials(state);

  const docPaths = [];
  for (const d of state.docs ?? []) {
    if (d.storagePath) docPaths.push(d.storagePath);
  }
  for (const c of state.contacts ?? []) {
    for (const d of c.docs ?? []) {
      if (d.storagePath) docPaths.push(d.storagePath);
    }
  }

  const duplicateIds = findDuplicateIds(tables);
  const orphans = findOrphanRefs(state, tables);

  const checks = [
    check("projects", tables.projects.length, (state.projs ?? []).length),
    check("pays", tables.pays.length, pays.length),
    check("contacts", tables.contacts.length, (state.contacts ?? []).length),
    check("scopes", tables.scopes.length, scopes),
    check("stages", tables.scope_stages.length, stages),
    check("payment_schedules", tables.payment_schedules.length, pmts),
    check("duplicate_ids", duplicateIds.length, 0),
    check("orphan_relationships", orphans.length, 0),
  ];

  return {
    passed: checks.every((c) => c.pass),
    sourceWarnings,
    checks,
    counts: {
      projects: tables.projects.length,
      pays: tables.pays.length,
      contacts: tables.contacts.length,
      scopes: tables.scopes.length,
      stages: tables.scope_stages.length,
      payment_schedules: tables.payment_schedules.length,
      documents: tables.documents.length,
      storage_paths: docPaths.length,
    },
    financials: {
      jordanContract: financials.jordanContract,
      jordanExpenses: financials.jordanExpenses,
      cantonExpenses: financials.cantonExpenses,
      cabinetsCo: financials.cabinetsCo,
      jordanElectrical: financials.jordanElectrical,
      elderScope: financials.elderScope,
    },
    duplicateIds,
    orphans,
    storagePaths: docPaths,
    extractedTables: Object.fromEntries(
      Object.entries(tables).map(([k, v]) => [k, v.length])
    ),
  };
}

function check(name, actual, expected) {
  const pass = actual === expected || String(actual) === String(expected);
  return { name, actual, expected, pass };
}

function findDuplicateIds(tables) {
  const dups = [];
  for (const [table, rows] of Object.entries(tables)) {
    const seen = new Set();
    for (const row of rows) {
      const id = row.id ?? `${row.contact_id}:${row.project_id}`;
      if (seen.has(id)) dups.push(`${table}:${id}`);
      seen.add(id);
    }
  }
  return dups;
}

function findOrphanRefs(state, tables) {
  const orphans = [];
  const projectIds = new Set((state.projs ?? []).map((p) => p.id));
  const contactIds = new Set((state.contacts ?? []).map((c) => c.id));
  const scopeIds = new Set(tables.scopes.map((s) => s.id));
  const phaseIds = new Set(tables.phases.map((p) => p.id));
  const stageIds = new Set(tables.scope_stages.map((s) => s.id));
  const pmtIds = new Set(tables.payment_schedules.map((p) => p.id));

  for (const py of tables.pays) {
    if (py.project_id && !projectIds.has(py.project_id)) orphans.push(`pay.${py.id}.project_id`);
    if (py.contractor_id && !contactIds.has(py.contractor_id)) orphans.push(`pay.${py.id}.contractor_id`);
    if (py.scope_id && !scopeIds.has(py.scope_id)) orphans.push(`pay.${py.id}.scope_id`);
    if (py.phase_id && !phaseIds.has(py.phase_id)) orphans.push(`pay.${py.id}.phase_id`);
    if (py.stage_id && !stageIds.has(py.stage_id)) orphans.push(`pay.${py.id}.stage_id`);
    if (py.payment_schedule_id && !pmtIds.has(py.payment_schedule_id)) orphans.push(`pay.${py.id}.payment_schedule_id`);
  }
  for (const sc of tables.scopes) {
    if (!contactIds.has(sc.contact_id)) orphans.push(`scope.${sc.id}.contact_id`);
    if (!projectIds.has(sc.project_id)) orphans.push(`scope.${sc.id}.project_id`);
    if (sc.phase_id && !phaseIds.has(sc.phase_id)) orphans.push(`scope.${sc.id}.phase_id`);
  }
  for (const pmt of tables.payment_schedules) {
    if (!contactIds.has(pmt.contact_id)) orphans.push(`pmt.${pmt.id}.contact_id`);
    if (!projectIds.has(pmt.project_id)) orphans.push(`pmt.${pmt.id}.project_id`);
    if (pmt.scope_id && !scopeIds.has(pmt.scope_id)) orphans.push(`pmt.${pmt.id}.scope_id`);
  }
  for (const d of tables.documents) {
    if (!projectIds.has(d.project_id)) orphans.push(`doc.${d.id}.project_id`);
    if (d.contact_id && !contactIds.has(d.contact_id)) orphans.push(`doc.${d.id}.contact_id`);
    if (d.scope_id && !scopeIds.has(d.scope_id)) orphans.push(`doc.${d.id}.scope_id`);
    if (d.payment_schedule_id && !pmtIds.has(d.payment_schedule_id)) orphans.push(`doc.${d.id}.payment_schedule_id`);
  }
  return orphans;
}

export async function reconcileDatabase(client, state) {
  const snapshotReport = reconcileSnapshot(state);
  const dbCounts = {};
  for (const table of Object.keys(snapshotReport.extractedTables)) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${tableFqn(table)}`);
    dbCounts[table] = rows[0].c;
  }

  const countChecks = Object.entries(snapshotReport.extractedTables).map(([table, expected]) => {
    const actual = dbCounts[table] ?? -1;
    return check(`db.${table}`, actual, expected);
  });

  const jordanDb = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM ${tableFqn("pays")} WHERE project_id = $1`,
    [JORDAN_ID]
  );
  const cantonDb = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM ${tableFqn("pays")} WHERE project_id = $1`,
    [CANTON_ID]
  );
  const jordanCoDb = await client.query(
    `SELECT COALESCE(original_contract, 0) + COALESCE((SELECT SUM(amount) FROM ${tableFqn("project_change_orders")} WHERE project_id = $1), 0) AS total FROM ${tableFqn("projects")} WHERE id = $1`,
    [JORDAN_ID]
  );
  const cabinetsDb = await client.query(
    `SELECT amount FROM ${tableFqn("project_change_orders")} WHERE id = $1`,
    [CABINETS_CO_ID]
  );
  const elderDb = await client.query(
    `SELECT COUNT(*)::int AS c FROM ${tableFqn("contacts")} WHERE id = $1`,
    [ELDER_ID]
  );
  const elderScopeDb = await client.query(
    `SELECT price FROM ${tableFqn("scopes")} WHERE id = $1`,
    [ELDER_SCOPE_ID]
  );

  const dbFinancialChecks = [
    check("db.jordan_expenses", toMoney(jordanDb.rows[0]?.total), snapshotReport.financials.jordanExpenses),
    check("db.canton_expenses", toMoney(cantonDb.rows[0]?.total), snapshotReport.financials.cantonExpenses),
    check("db.jordan_contract", toMoney(jordanCoDb.rows[0]?.total), snapshotReport.financials.jordanContract),
    check("db.cabinets_co", toMoney(cabinetsDb.rows[0]?.amount), snapshotReport.financials.cabinetsCo),
    check("db.elder_exists", elderDb.rows[0]?.c === 1, true),
    check("db.elder_scope", toMoney(elderScopeDb.rows[0]?.price), snapshotReport.financials.elderScope),
  ];

  const orphanDb = await findDbOrphans(client);
  const allChecks = [
    ...snapshotReport.checks,
    ...countChecks,
    ...dbFinancialChecks,
    check("db.orphans", orphanDb.length, 0),
  ];

  return {
    ...snapshotReport,
    dbCounts,
    dbOrphans: orphanDb,
    checks: allChecks,
    passed: allChecks.every((c) => c.pass),
  };
}

async function findDbOrphans(client) {
  const orphans = [];
  const q = async (label, sql) => {
    const { rows } = await client.query(sql);
    for (const r of rows) orphans.push(`${label}:${r.id ?? r.ref}`);
  };
  await q("pay.project", `SELECT id FROM ${tableFqn("pays")} p WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("projects")} x WHERE x.id = p.project_id)`);
  await q("pay.contractor", `SELECT id FROM ${tableFqn("pays")} p WHERE contractor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tableFqn("contacts")} x WHERE x.id = p.contractor_id)`);
  await q("scope.contact", `SELECT id FROM ${tableFqn("scopes")} s WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("contacts")} x WHERE x.id = s.contact_id)`);
  await q("scope.project", `SELECT id FROM ${tableFqn("scopes")} s WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("projects")} x WHERE x.id = s.project_id)`);
  await q("doc.project", `SELECT id FROM ${tableFqn("documents")} d WHERE NOT EXISTS (SELECT 1 FROM ${tableFqn("projects")} x WHERE x.id = d.project_id)`);
  return orphans;
}

export function formatReconcileReport(report, { title = "RECONCILIATION REPORT" } = {}) {
  const lines = [];
  lines.push(`=== ${title} ===`);
  lines.push(`Status: ${report.passed ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("Counts:");
  for (const [k, v] of Object.entries(report.counts ?? {})) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push("");
  lines.push("Financials:");
  for (const [k, v] of Object.entries(report.financials ?? {})) {
    lines.push(`  ${k}: $${v}`);
  }
  lines.push("");
  lines.push("Checks:");
  for (const c of report.checks ?? []) {
    lines.push(`  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.actual} (expected ${c.expected})`);
  }
  if (report.duplicateIds?.length) {
    lines.push("");
    lines.push("Duplicate IDs:");
    report.duplicateIds.forEach((d) => lines.push(`  - ${d}`));
  }
  if (report.orphans?.length) {
    lines.push("");
    lines.push("Orphan refs (snapshot):");
    report.orphans.forEach((o) => lines.push(`  - ${o}`));
  }
  if (report.dbOrphans?.length) {
    lines.push("");
    lines.push("Orphan refs (database):");
    report.dbOrphans.forEach((o) => lines.push(`  - ${o}`));
  }
  if (report.storagePaths?.length) {
    lines.push("");
    lines.push(`Storage paths preserved: ${report.storagePaths.length}`);
  }
  if (report.sourceWarnings?.length) {
    lines.push("");
    lines.push("Source data warnings (normalized during extract):");
    report.sourceWarnings.forEach((w) => lines.push(`  - ${w}`));
  }
  return lines.join("\n");
}
