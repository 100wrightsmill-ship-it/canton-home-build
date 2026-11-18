import {
  mapProject,
  mapChangeOrder,
  mapPhase,
  mapPhaseMaterial,
  mapChecklistItem,
  mapTask,
  mapContact,
  mapScope,
  mapScopeStage,
  mapPaymentSchedule,
  mapPay,
  mapDocumentFolder,
  mapDocument,
  mapMessage,
  mapNotification,
  mapMaterialOrder,
  mapMaterialOrderItem,
  rowVersion,
} from "./transform.js";

function pushUnique(map, table, row) {
  const id = row.id;
  if (!id) throw new Error(`${table}: row missing id`);
  if (map.has(id)) {
    throw new Error(`Duplicate ID in extraction: ${table}.${id}`);
  }
  map.set(id, row);
  return row;
}

function pushJunction(list, key, row) {
  const k = `${row.contact_id}:${row.project_id}`;
  if (!list.some((r) => `${r.contact_id}:${r.project_id}` === k)) {
    list.push(row);
  }
}

/**
 * Extract normalized rows from monolithic state.json snapshot.
 * @returns {{ tables: Record<string, object[]>, meta: object }}
 */
export function extractRowsFromState(state) {
  const tables = {
    projects: new Map(),
    project_change_orders: new Map(),
    phases: new Map(),
    phase_materials: new Map(),
    phase_checklists: new Map(),
    phase_checklist_items: new Map(),
    tasks: new Map(),
    contacts: new Map(),
    contact_projects: [],
    scopes: new Map(),
    scope_stages: new Map(),
    scope_checklists: new Map(),
    scope_checklist_items: new Map(),
    scope_payment_plans: new Map(),
    payment_schedules: new Map(),
    pays: new Map(),
    document_folders: new Map(),
    documents: new Map(),
    messages: new Map(),
    notifications: new Map(),
    material_orders: new Map(),
    material_order_items: new Map(),
  };

  const scopeProject = new Map();
  const contactProjects = new Map();
  const warnings = [];

  const projectIds = new Set((state.projs ?? []).map((p) => p.id));
  const phaseIds = new Set((state.phases ?? []).map((p) => p.id));

  for (const p of state.projs ?? []) {
    pushUnique(tables.projects, "projects", mapProject(p));
    for (const co of p.changeOrders ?? []) {
      pushUnique(tables.project_change_orders, "project_change_orders", mapChangeOrder(co, p.id));
    }
  }

  for (const ph of state.phases ?? []) {
    pushUnique(tables.phases, "phases", mapPhase(ph));
    for (const cl of ph.checklists ?? []) {
      pushUnique(tables.phase_checklists, "phase_checklists", {
        id: cl.id,
        version: rowVersion(cl.version),
        phase_id: ph.id,
        name: cl.name,
      });
      for (const ci of cl.items ?? []) {
        pushUnique(tables.phase_checklist_items, "phase_checklist_items", mapChecklistItem(ci, cl.id));
      }
    }
    for (const m of ph.materials ?? []) {
      const matId = m.id ?? `${ph.id}_mat_${tables.phase_materials.size}`;
      pushUnique(tables.phase_materials, "phase_materials", mapPhaseMaterial({ ...m, id: matId }, ph.id));
    }
  }

  for (const t of state.tasks ?? []) {
    pushUnique(tables.tasks, "tasks", mapTask(t));
  }

  for (const c of state.contacts ?? []) {
    pushUnique(tables.contacts, "contacts", mapContact(c));
    for (const pid of c.pids ?? []) {
      pushJunction(tables.contact_projects, "contact_projects", { contact_id: c.id, project_id: pid });
      if (!contactProjects.has(c.id)) contactProjects.set(c.id, new Set());
      contactProjects.get(c.id).add(pid);
    }
    for (const sc of c.scopes ?? []) {
      const scopeRow = mapScope(sc, c.id);
      if (scopeRow.phase_id && !phaseIds.has(scopeRow.phase_id)) {
        warnings.push(`scope.${sc.id}: nullified missing phase_id ${scopeRow.phase_id}`);
        scopeRow.phase_id = null;
      }
      pushUnique(tables.scopes, "scopes", scopeRow);
      scopeProject.set(sc.id, sc.pid);
      for (const sg of sc.stages ?? []) {
        pushUnique(tables.scope_stages, "scope_stages", mapScopeStage(sg, sc.id));
      }
      for (const cl of sc.checklists ?? []) {
        pushUnique(tables.scope_checklists, "scope_checklists", {
          id: cl.id,
          version: rowVersion(cl.version),
          scope_id: sc.id,
          name: cl.name,
        });
        for (const ci of cl.items ?? []) {
          pushUnique(tables.scope_checklist_items, "scope_checklist_items", mapChecklistItem(ci, cl.id));
        }
      }
      for (let i = 0; i < (sc.paymentPlan ?? sc.pmtPlan ?? []).length; i++) {
        const plan = sc.paymentPlan?.[i] ?? sc.pmtPlan?.[i];
        const planId = plan.id ?? `${sc.id}_plan_${i}`;
        pushUnique(tables.scope_payment_plans, "scope_payment_plans", {
          id: planId,
          version: rowVersion(plan.version),
          scope_id: sc.id,
          plan_index: i,
          amount: plan.amt != null ? String(Number(plan.amt).toFixed(2)) : null,
          due_date: plan.due ? String(plan.due).slice(0, 10) : null,
          milestone: plan.milestone || null,
          notes: plan.notes || null,
        });
      }
    }
    for (const pmt of c.pmts ?? []) {
      const projectId =
        scopeProject.get(pmt.scopeId) ??
        (c.pids?.length === 1 ? c.pids[0] : null);
      if (!projectId) {
        throw new Error(`Cannot resolve project_id for payment schedule ${pmt.id} (contact ${c.id})`);
      }
      pushUnique(tables.payment_schedules, "payment_schedules", mapPaymentSchedule(pmt, c.id, projectId));
    }
    for (const d of c.docs ?? []) {
      const projectId =
        d.pid ??
        scopeProject.get(d.scopeId) ??
        (c.pids?.length === 1 ? c.pids[0] : null);
      if (!projectId) {
        throw new Error(`Cannot resolve project_id for contact document ${d.id} (contact ${c.id})`);
      }
      const scopeId = d.scopeId || null;
      let pmtId = d.pmtId || null;
      pushUnique(
        tables.documents,
        "documents",
        mapDocument(d, {
          projectId,
          contactId: scopeId || pmtId ? null : c.id,
          scopeId: scopeId || null,
          paymentScheduleId: null,
        })
      );
    }
  }

  // Second pass: attach payment_schedule_id on docs once all pmts are known
  const pmtIds = new Set([...tables.payment_schedules.keys()]);
  for (const c of state.contacts ?? []) {
    for (const d of c.docs ?? []) {
      if (!d.pmtId) continue;
      const docRow = tables.documents.get(d.id);
      if (!docRow) continue;
      if (pmtIds.has(d.pmtId)) {
        // Receipt docs: single parent link — payment schedule wins over scope
        docRow.payment_schedule_id = d.pmtId;
        docRow.scope_id = null;
        docRow.contact_id = null;
      } else {
        warnings.push(`doc.${d.id}: nullified missing pmtId ${d.pmtId}`);
      }
    }
  }

  for (const py of state.pays ?? []) {
    pushUnique(tables.pays, "pays", mapPay(py));
  }

  for (const f of state.folders ?? []) {
    pushUnique(tables.document_folders, "document_folders", mapDocumentFolder(f));
  }

  for (const d of state.docs ?? []) {
    pushUnique(tables.documents, "documents", mapDocument(d, { projectId: d.pid }));
  }

  for (const m of state.msgs ?? []) {
    pushUnique(tables.messages, "messages", mapMessage(m));
  }

  for (const n of state.notifs ?? []) {
    pushUnique(tables.notifications, "notifications", mapNotification(n));
  }

  for (const o of state.orders ?? []) {
    pushUnique(tables.material_orders, "material_orders", mapMaterialOrder(o));
    (o.items ?? []).forEach((item, i) => {
      pushUnique(
        tables.material_order_items,
        "material_order_items",
        mapMaterialOrderItem(item, o.id, i)
      );
    });
  }

  const out = {};
  for (const [name, mapOrList] of Object.entries(tables)) {
    out[name] = Array.isArray(mapOrList) ? mapOrList : [...mapOrList.values()];
  }

  return {
    tables: out,
    meta: {
      activeProjectId: state.cp ?? null,
      cloudRevision: state.cloudRevision ?? null,
      savedAt: state.savedAt ?? null,
    },
    warnings,
  };
}
