/** Insert order respects FK dependencies. */

export { STAGING_SCHEMA, PRODUCTION_SCHEMA } from "./schemaConfig.js";
export { tableFqn, getActiveSchema, setActiveSchema } from "./schemaContext.js";

export const TABLE_INSERT_ORDER = [
  "projects",
  "contacts",
  "contact_projects",
  "project_change_orders",
  "phases",
  "phase_materials",
  "phase_checklists",
  "phase_checklist_items",
  "tasks",
  "scopes",
  "scope_stages",
  "scope_checklists",
  "scope_checklist_items",
  "scope_payment_plans",
  "payment_schedules",
  "document_folders",
  "documents",
  "pays",
  "messages",
  "notifications",
  "material_orders",
  "material_order_items",
];

/** Columns compared during strict duplicate reconciliation (excludes version/timestamps). */
export const COMPARE_OMIT = new Set([
  "created_at",
  "updated_at",
  "version",
  "deleted_at",
]);

export const TABLE_PRIMARY_KEY = {
  contact_projects: ["contact_id", "project_id"],
};
