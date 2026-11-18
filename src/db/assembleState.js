/** Assemble monolithic app state from normalized cc_staging rows. */

import { fromDbDate, fromDbText } from "./dates.js";

function mapProjectRow(p, changeOrders) {
  return {
    id: p.id,
    version: p.version,
    name: p.name,
    address: p.address || "",
    status: p.status || "active",
    color: p.color || "#4f46e5",
    type: p.type || "",
    projectCategory: p.project_category || "",
    totalBudget: p.total_budget != null ? Number(p.total_budget) : 0,
    sqft: p.sqft || 0,
    startDate: fromDbDate(p.start_date),
    finishedDate: fromDbDate(p.finished_date),
    closedDate: fromDbDate(p.closed_date),
    originalContract: p.original_contract != null ? Number(p.original_contract) : undefined,
    contractDate: fromDbDate(p.contract_date),
    contractScopeNotes: fromDbText(p.contract_scope_notes),
    contractDocs: [],
    changeOrders: changeOrders.map((co) => ({
      id: co.id,
      version: co.version,
      title: co.title,
      amt: co.amount != null ? Number(co.amount) : 0,
      status: co.status || "",
      date: fromDbDate(co.change_date),
      scopeNotes: co.scope_notes || "",
      notes: co.notes || "",
      attachments: [],
    })),
  };
}

function mapContactRow(c, scopes, pmts, docs, projectIds) {
  return {
    id: c.id,
    version: c.version,
    name: c.name,
    co: c.company || "",
    phone: c.phone || "",
    email: c.email || "",
    type: c.type || "contractor",
    trade: c.trade || "",
    rating: c.rating || 3,
    license: c.license || "",
    insurance: fromDbDate(c.insurance_expiry),
    pids: projectIds,
    docs: docs.map((d) => mapDocRow(d, { scopeContactId: c.id })),
    pmts: pmts.map(mapPmtRow),
    scopes,
  };
}

function mapScopeRow(sc, stages) {
  return {
    id: sc.id,
    version: sc.version,
    pid: sc.project_id,
    phId: sc.phase_id || "",
    title: sc.title,
    desc: sc.description || "",
    status: sc.status || "active",
    price: sc.price != null ? Number(sc.price) : 0,
    notes: sc.notes || "",
    paymentTerms: sc.payment_terms || "",
    stages: stages.map((sg) => ({
      id: sg.id,
      name: sg.name,
      desc: sg.description || "",
      start: fromDbDate(sg.start_date),
      end: fromDbDate(sg.end_date),
      status: sg.status || "",
    })),
    costs: [],
    checklists: [],
  };
}

function mapPmtRow(p) {
  return {
    id: p.id,
    num: p.payment_num || 0,
    amt: p.amount != null ? Number(p.amount) : 0,
    due: fromDbDate(p.due_date),
    milestone: p.milestone || "",
    linkedStage: p.linked_stage || "",
    status: p.status || "",
    paidDate: fromDbDate(p.paid_date),
    method: p.method || "",
    conf: p.confirmation || "",
    scopeId: p.scope_id || "",
    notes: p.notes || "",
    receiptDocId: p.receipt_doc_id || "",
  };
}

function mapPayRow(p) {
  return {
    id: p.id,
    version: p.version,
    pid: p.project_id,
    date: fromDbDate(p.pay_date),
    amt: p.amount != null ? Number(p.amount) : 0,
    to: p.payee || "",
    vendor: p.vendor || "",
    description: p.description || "",
    method: p.method || "",
    cat: p.category || "",
    costCat: p.cost_category || "",
    notes: p.notes || "",
    conf: p.confirmation || "",
    source: p.source || "",
    status: p.status || "",
    paidDate: fromDbDate(p.paid_date),
    contractorId: p.contractor_id || "",
    scopeId: p.scope_id || "",
    stageId: p.stage_id || "",
    phId: p.phase_id || "",
    pmtId: p.payment_schedule_id || "",
    receiptDocId: p.receipt_doc_id || "",
  };
}

function mapDocRow(d, { scopeContactId = null } = {}) {
  return {
    id: d.id,
    pid: d.project_id,
    name: d.name,
    folder: d.folder_key || "",
    type: d.mime_type || "",
    size: d.size_bytes != null ? Number(d.size_bytes) : undefined,
    notes: d.notes || "",
    expiry: fromDbDate(d.expiry_date),
    storagePath: d.storage_path || "",
    contactId: d.contact_id || scopeContactId || "",
    scopeId: d.scope_id || "",
    pmtId: d.payment_schedule_id || "",
    kind: d.kind || "general",
    data: null,
    _legacyInline: Boolean(d.inline_data_present),
    _dataStripped: Boolean(d.inline_data_present),
  };
}

function mapDocRowFromTables(d, tables) {
  let scopeContactId = null;
  if (d.scope_id) {
    scopeContactId =
      (tables.scopes || []).find((s) => s.id === d.scope_id)?.contact_id ?? null;
  }
  return mapDocRow(d, { scopeContactId });
}

function mapPhaseRow(ph) {
  return {
    id: ph.id,
    pid: ph.project_id,
    name: ph.name,
    he: ph.name_he || "",
    ord: ph.sort_order || 0,
    status: ph.status || "",
    progress: ph.progress || 0,
    who: ph.who || "",
    group: ph.phase_group || "",
    checklists: [],
    materials: [],
  };
}

export function assembleStateFromTables(tables, meta = {}) {
  const cosByProject = new Map();
  for (const co of tables.project_change_orders || []) {
    if (!cosByProject.has(co.project_id)) cosByProject.set(co.project_id, []);
    cosByProject.get(co.project_id).push(co);
  }

  const stagesByScope = new Map();
  for (const sg of tables.scope_stages || []) {
    if (!stagesByScope.has(sg.scope_id)) stagesByScope.set(sg.scope_id, []);
    stagesByScope.get(sg.scope_id).push(sg);
  }

  const scopesByContact = new Map();
  for (const sc of tables.scopes || []) {
    if (!scopesByContact.has(sc.contact_id)) scopesByContact.set(sc.contact_id, []);
    scopesByContact.get(sc.contact_id).push(sc);
  }

  const pmtsByContact = new Map();
  for (const p of tables.payment_schedules || []) {
    if (!pmtsByContact.has(p.contact_id)) pmtsByContact.set(p.contact_id, []);
    pmtsByContact.get(p.contact_id).push(p);
  }

  const contactProjects = new Map();
  for (const cp of tables.contact_projects || []) {
    if (!contactProjects.has(cp.contact_id)) contactProjects.set(cp.contact_id, []);
    contactProjects.get(cp.contact_id).push(cp.project_id);
  }

  const docsByContact = new Map();
  const projectDocs = [];
  for (const d of tables.documents || []) {
    if (d.contact_id) {
      if (!docsByContact.has(d.contact_id)) docsByContact.set(d.contact_id, []);
      docsByContact.get(d.contact_id).push(d);
    } else if (!d.scope_id && !d.payment_schedule_id && !d.change_order_id) {
      projectDocs.push(d);
    } else if (d.scope_id || d.payment_schedule_id || d.change_order_id) {
      let cid = null;
      if (d.scope_id) {
        cid = (tables.scopes || []).find((s) => s.id === d.scope_id)?.contact_id ?? null;
      }
      if (!cid && d.payment_schedule_id) {
        cid =
          (tables.payment_schedules || []).find((p) => p.id === d.payment_schedule_id)?.contact_id ??
          null;
      }
      if (cid) {
        if (!docsByContact.has(cid)) docsByContact.set(cid, []);
        docsByContact.get(cid).push(d);
      } else {
        projectDocs.push(d);
      }
    }
  }

  const projs = (tables.projects || []).map((p) =>
    mapProjectRow(p, cosByProject.get(p.id) || [])
  );

  const contacts = (tables.contacts || []).map((c) => {
    const scopes = (scopesByContact.get(c.id) || []).map((sc) =>
      mapScopeRow(sc, stagesByScope.get(sc.id) || [])
    );
    return mapContactRow(
      c,
      scopes,
      pmtsByContact.get(c.id) || [],
      docsByContact.get(c.id) || [],
      contactProjects.get(c.id) || []
    );
  });

  return {
    schemaVersion: 1,
    cp: meta.activeProjectId || projs[0]?.id || "p1",
    projs,
    phases: (tables.phases || []).map(mapPhaseRow),
    tasks: (tables.tasks || []).map((t) => ({
      id: t.id,
      pid: t.project_id,
      phId: t.phase_id || "",
      title: t.title,
      who: t.assignee || "",
      pri: t.priority || "",
      status: t.status || "",
      due: fromDbDate(t.due_date),
    })),
    pays: (tables.pays || []).map(mapPayRow),
    contacts,
    msgs: (tables.messages || []).map((m) => ({
      id: m.id,
      pid: m.project_id,
      from: m.sender || "",
      text: m.body || "",
      ts: m.sent_at || "",
    })),
    notifs: (tables.notifications || []).map((n) => ({
      id: n.id,
      pid: n.project_id,
      type: n.type || "",
      msg: n.message || "",
      read: n.is_read || false,
      ts: n.notified_at || "",
    })),
    docs: projectDocs.map((d) => mapDocRowFromTables(d, tables)),
    folders: (tables.document_folders || []).map((f) => ({
      id: f.id,
      name: f.name,
      key: f.folder_key,
      parent: f.parent_id,
    })),
    orders: (tables.material_orders || []).map((o) => ({
      id: o.id,
      pid: o.project_id,
      num: o.order_num,
      date: fromDbDate(o.order_date),
      supplier: o.supplier,
      total: o.total != null ? Number(o.total) : 0,
      status: o.status || "",
      items: [],
    })),
    savedAt: Date.now(),
    stagingDb: true,
  };
}
