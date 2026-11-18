/** Canonical Supabase project references — staging and production must never be confused. */

export const STAGING_SCHEMA = "cc_staging";
export const PRODUCTION_SCHEMA = "cc_production";

/** Canton Home Build Staging */
export const STAGING_PROJECT_REF = "zsefsuyyyjbjaxsflllq";

/** Canton Home Build (production) */
export const PRODUCTION_PROJECT_REF = "bdckzzweimrmvcvvahbr";

export const STAGING_SUPABASE_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
export const PRODUCTION_SUPABASE_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;

export function schemaSqlPath(schema) {
  if (schema === STAGING_SCHEMA) {
    return "supabase/migrations/staging/001_cc_staging_schema.sql";
  }
  if (schema === PRODUCTION_SCHEMA) {
    return "supabase/migrations/production/001_cc_production_schema.sql";
  }
  throw new Error(`Unknown schema: ${schema}`);
}
