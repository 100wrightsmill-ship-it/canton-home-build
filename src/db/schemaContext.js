import { STAGING_SCHEMA } from "./schemaConfig.js";

/** Active Postgres schema for tableFqn() — set per script/server at startup. */
let activeSchema = STAGING_SCHEMA;

export function setActiveSchema(schema) {
  activeSchema = schema;
}

export function getActiveSchema() {
  return activeSchema;
}

export function tableFqn(table) {
  return `${activeSchema}.${table}`;
}
