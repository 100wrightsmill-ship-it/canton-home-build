/**
 * Compute row-level operations from app-state before/after snapshots.
 * Returns ordered ops for staging API server (never full-state replace).
 */

import {
  mapContact,
  mapScope,
  mapScopeStage,
  mapPaymentSchedule,
  mapPay,
  mapProject,
  mapChangeOrder,
  mapDocument,
  emptyToNull,
} from "./transform.js";
import { extractRowsFromState } from "./extractRows.js";

function rowKey(table, row) {
  if (table === "contact_projects") return `${row.contact_id}:${row.project_id}`;
  return row.id;
}

function indexById(arr, table) {
  return new Map((arr || []).map((r) => [rowKey(table, r), r]));
}

function contactProjectKey(c, pid) {
  return `${c}:${pid}`;
}

export function computeDeltaOps(before, after) {
  const ops = [];
  const beforeRows = extractRowsFromState(before || { projs: [], pays: [], contacts: [] }).tables;
  const afterRows = extractRowsFromState(after).tables;

  const tableNames = [
    "projects",
    "contacts",
    "contact_projects",
    "project_change_orders",
    "phases",
    "scopes",
    "scope_stages",
    "scope_checklists",
    "scope_checklist_items",
    "payment_schedules",
    "pays",
    "documents",
    "tasks",
  ];

  for (const table of tableNames) {
    const prev = beforeRows[table] || [];
    const next = afterRows[table] || [];
    const prevMap = indexById(prev, table);
    const nextMap = indexById(next, table);

    for (const row of next) {
      const key = rowKey(table, row);
      const old = prevMap.get(key);
      if (!old) {
        ops.push({ op: "insert", table, row });
      } else if (JSON.stringify(stableRow(old)) !== JSON.stringify(stableRow(row))) {
        ops.push({
          op: "update",
          table,
          id: table === "contact_projects" ? key : row.id,
          row,
          expectedVersion: old.version ?? 1,
        });
      }
    }
    for (const row of prev) {
      const key = rowKey(table, row);
      if (!nextMap.has(key)) {
        ops.push({
          op: "soft_delete",
          table,
          id: table === "contact_projects" ? key : row.id,
          contact_id: row.contact_id,
          project_id: row.project_id,
        });
      }
    }
  }

  return ops;
}

function stableRow(row) {
  const copy = { ...row };
  delete copy.created_at;
  delete copy.updated_at;
  delete copy.version;
  delete copy.deleted_at;
  return copy;
}

/** Map UI snapshot fragments to explicit single-row ops (for tests). */
export function opInsertContact(contact, projectId) {
  const row = mapContact(contact);
  const ops = [{ op: "insert", table: "contacts", row }];
  if (projectId) {
    ops.push({
      op: "insert",
      table: "contact_projects",
      row: { contact_id: contact.id, project_id: projectId },
    });
  }
  return ops;
}

export function opInsertScope(scope, contactId) {
  return [
    {
      op: "insert",
      table: "scopes",
      row: mapScope(scope, contactId),
    },
    ...(scope.stages || []).map((sg) => ({
      op: "insert",
      table: "scope_stages",
      row: mapScopeStage(sg, scope.id),
    })),
  ];
}

export function opInsertPay(pay) {
  return [{ op: "insert", table: "pays", row: mapPay(pay) }];
}

export function opUpdatePay(pay, version) {
  return [{ op: "update", table: "pays", id: pay.id, row: mapPay(pay), expectedVersion: version }];
}

export function opSoftDeletePay(id) {
  return [{ op: "soft_delete", table: "pays", id }];
}

export function opInsertChangeOrder(co, projectId) {
  return [{ op: "insert", table: "project_change_orders", row: mapChangeOrder(co, projectId) }];
}

export function opUpdateChangeOrder(co, projectId, version) {
  return [
    {
      op: "update",
      table: "project_change_orders",
      id: co.id,
      row: mapChangeOrder(co, projectId),
      expectedVersion: version,
    },
  ];
}

export function opInsertPaymentSchedule(pmt, contactId, projectId) {
  return [
    {
      op: "insert",
      table: "payment_schedules",
      row: mapPaymentSchedule(pmt, contactId, projectId),
    },
  ];
}

export function opInsertDocument(doc, opts) {
  return [{ op: "insert", table: "documents", row: mapDocument(doc, opts) }];
}
