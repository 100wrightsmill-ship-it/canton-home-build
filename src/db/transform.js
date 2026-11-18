import { toMoney } from "./money.js";

export function emptyToNull(v) {
  if (v === "" || v === undefined) return null;
  return v;
}

export function toDate(v) {
  const s = emptyToNull(v);
  if (!s) return null;
  return String(s).slice(0, 10);
}

export function toTimestamp(v) {
  const s = emptyToNull(v);
  if (!s) return null;
  if (typeof v === "number") return new Date(v).toISOString();
  return String(s);
}

export function boolOrFalse(v) {
  return Boolean(v);
}

/** Legacy snapshots omit version — DB requires NOT NULL; default to 1. */
export function rowVersion(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return 1;
}

export function mapProject(p) {
  return {
    id: p.id,
    version: rowVersion(p.version),
    name: p.name,
    address: emptyToNull(p.address),
    status: emptyToNull(p.status),
    color: emptyToNull(p.color),
    type: emptyToNull(p.type),
    project_category: emptyToNull(p.projectCategory),
    total_budget: toMoney(p.totalBudget),
    sqft: p.sqft != null ? Number(p.sqft) : null,
    start_date: toDate(p.startDate),
    finished_date: toDate(p.finishedDate),
    closed_date: toDate(p.closedDate),
    original_contract: toMoney(p.originalContract),
    contract_date: toDate(p.contractDate),
    contract_scope_notes: emptyToNull(p.contractScopeNotes),
  };
}

export function mapChangeOrder(co, projectId) {
  return {
    id: co.id,
    version: rowVersion(co.version),
    project_id: projectId,
    title: co.title,
    amount: toMoney(co.amt),
    status: emptyToNull(co.status),
    change_date: toDate(co.date),
    scope_notes: emptyToNull(co.scopeNotes),
    notes: emptyToNull(co.notes),
  };
}

export function mapPhase(ph) {
  return {
    id: ph.id,
    version: rowVersion(ph.version),
    project_id: ph.pid,
    name: ph.name,
    name_he: emptyToNull(ph.he),
    sort_order: ph.ord != null ? Number(ph.ord) : null,
    status: emptyToNull(ph.status),
    progress: ph.progress != null ? Number(ph.progress) : null,
    who: emptyToNull(ph.who),
    phase_group: emptyToNull(ph.group),
    labor_cost: toMoney(ph.laborCost),
  };
}

export function mapPhaseMaterial(m, phaseId) {
  return {
    id: m.id,
    version: rowVersion(m.version),
    phase_id: phaseId,
    name: emptyToNull(m.name),
    brand: emptyToNull(m.brand),
    description: emptyToNull(m.desc ?? m.description),
    color: emptyToNull(m.color),
    qty: m.qty != null ? toMoney(m.qty) : null,
    unit: emptyToNull(m.unit),
    unit_price: toMoney(m.unitPrice ?? m.price),
    model_num: emptyToNull(m.modelNum ?? m.model),
    store: emptyToNull(m.store),
    dimensions: emptyToNull(m.dimensions),
    buyer: emptyToNull(m.buyer),
    status: emptyToNull(m.status),
    image_url: emptyToNull(m.imageUrl ?? m.image),
    product_url: emptyToNull(m.productUrl ?? m.url),
  };
}

export function mapChecklist(cl, parentKind) {
  const row = {
    id: cl.id,
    version: rowVersion(cl.version),
    name: cl.name,
  };
  if (parentKind === "phase") row.phase_id = cl._phaseId;
  else row.scope_id = cl._scopeId;
  return row;
}

export function mapChecklistItem(ci, checklistId) {
  return {
    id: ci.id,
    version: rowVersion(ci.version),
    checklist_id: checklistId,
    item_text: ci.t ?? ci.text ?? ci.item_text ?? "",
    is_done: boolOrFalse(ci.d ?? ci.is_done),
    done_date: toDate(ci.doneDate),
  };
}

export function mapTask(t) {
  return {
    id: t.id,
    version: rowVersion(t.version),
    project_id: t.pid,
    phase_id: emptyToNull(t.phId),
    title: t.title,
    assignee: emptyToNull(t.who),
    priority: emptyToNull(t.pri),
    status: emptyToNull(t.status),
    due_date: toDate(t.due),
  };
}

export function mapContact(c) {
  return {
    id: c.id,
    version: rowVersion(c.version),
    name: c.name,
    company: emptyToNull(c.co),
    phone: emptyToNull(c.phone),
    email: emptyToNull(c.email),
    type: emptyToNull(c.type),
    trade: emptyToNull(c.trade),
    rating: c.rating != null ? Number(c.rating) : null,
    license: emptyToNull(c.license),
    insurance_expiry: emptyToNull(c.insurance),
  };
}

export function mapScope(sc, contactId) {
  return {
    id: sc.id,
    version: rowVersion(sc.version),
    contact_id: contactId,
    project_id: sc.pid,
    phase_id: emptyToNull(sc.phId),
    title: sc.title,
    description: emptyToNull(sc.desc),
    status: emptyToNull(sc.status),
    price: toMoney(sc.price),
    notes: emptyToNull(sc.notes),
    payment_terms: emptyToNull(sc.paymentTerms),
  };
}

export function mapScopeStage(sg, scopeId) {
  return {
    id: sg.id,
    version: rowVersion(sg.version),
    scope_id: scopeId,
    name: sg.name,
    description: emptyToNull(sg.desc),
    start_date: toDate(sg.start),
    end_date: toDate(sg.end),
    status: emptyToNull(sg.status),
  };
}

export function mapPaymentSchedule(pmt, contactId, projectId) {
  return {
    id: pmt.id,
    version: rowVersion(pmt.version),
    contact_id: contactId,
    project_id: projectId,
    scope_id: emptyToNull(pmt.scopeId),
    payment_num: pmt.num != null ? Number(pmt.num) : null,
    amount: toMoney(pmt.amt),
    due_date: toDate(pmt.due),
    milestone: emptyToNull(pmt.milestone),
    linked_stage: emptyToNull(pmt.linkedStage),
    status: emptyToNull(pmt.status),
    paid_date: toDate(pmt.paidDate),
    method: emptyToNull(pmt.method),
    confirmation: emptyToNull(pmt.conf),
    notes: emptyToNull(pmt.notes),
    receipt_doc_id: emptyToNull(pmt.receiptDocId),
  };
}

export function mapPay(py) {
  return {
    id: py.id,
    version: rowVersion(py.version),
    project_id: py.pid,
    pay_date: toDate(py.date),
    amount: toMoney(py.amt),
    payee: emptyToNull(py.to),
    vendor: emptyToNull(py.vendor),
    description: emptyToNull(py.desc ?? py.description),
    method: emptyToNull(py.method),
    category: emptyToNull(py.cat),
    cost_category: emptyToNull(py.costCat),
    notes: emptyToNull(py.notes),
    confirmation: emptyToNull(py.conf),
    source: emptyToNull(py.source),
    status: emptyToNull(py.status),
    paid_date: toDate(py.paidDate),
    contractor_id: emptyToNull(py.contractorId),
    scope_id: emptyToNull(py.scopeId),
    stage_id: emptyToNull(py.stageId),
    phase_id: emptyToNull(py.phId),
    payment_schedule_id: emptyToNull(py.pmtId),
    receipt_doc_id: emptyToNull(py.receiptDocId),
  };
}

export function mapDocumentFolder(f) {
  return {
    id: f.id,
    version: rowVersion(f.version),
    name: f.name,
    folder_key: f.key,
    parent_id: emptyToNull(f.parent),
  };
}

export function mapDocument(d, opts = {}) {
  const {
    projectId,
    contactId = null,
    scopeId = null,
    paymentScheduleId = null,
    changeOrderId = null,
  } = opts;
  const hasInline = Boolean(d.data && typeof d.data === "string" && d.data.length > 0);
  return {
    id: d.id,
    version: rowVersion(d.version),
    project_id: projectId,
    folder_key: emptyToNull(d.folder),
    name: d.name,
    mime_type: emptyToNull(d.type),
    size_bytes: d.size != null ? Number(d.size) : null,
    notes: emptyToNull(d.notes),
    expiry_date: toDate(d.expiry),
    storage_path: emptyToNull(d.storagePath),
    inline_data_present: hasInline || Boolean(d._dataStripped),
    kind: emptyToNull(d.kind),
    contact_id: contactId,
    scope_id: scopeId,
    payment_schedule_id: paymentScheduleId,
    change_order_id: changeOrderId,
  };
}

export function mapMessage(m) {
  return {
    id: m.id,
    version: rowVersion(m.version),
    project_id: m.pid,
    sender: emptyToNull(m.from),
    body: emptyToNull(m.text),
    sent_at: toTimestamp(m.ts),
  };
}

export function mapNotification(n) {
  return {
    id: n.id,
    version: rowVersion(n.version),
    project_id: n.pid,
    type: emptyToNull(n.type),
    message: emptyToNull(n.msg),
    is_read: boolOrFalse(n.read),
    notified_at: toTimestamp(n.ts),
  };
}

export function mapMaterialOrder(o) {
  return {
    id: o.id,
    version: rowVersion(o.version),
    project_id: o.pid,
    order_num: emptyToNull(o.num ?? o.orderNum),
    order_date: toDate(o.date ?? o.orderDate),
    supplier: emptyToNull(o.supplier),
    supplier_email: emptyToNull(o.supplierEmail),
    supplier_id: emptyToNull(o.supplierId),
    total: toMoney(o.total),
    notes: emptyToNull(o.notes),
    delivery_date: toDate(o.deliveryDate),
    actual_delivery: toDate(o.actualDelivery),
    status: emptyToNull(o.status),
  };
}

export function mapMaterialOrderItem(item, orderId, index) {
  return {
    id: item.id ?? `${orderId}_item_${index}`,
    version: rowVersion(item.version),
    order_id: orderId,
    item_index: index,
    name: emptyToNull(item.name),
    qty: item.qty != null ? toMoney(item.qty) : null,
    unit_price: toMoney(item.unitPrice ?? item.price),
  };
}
