/**
 * Supabase URL + API keys — never hardcode secrets in source.
 * Client (Vite): VITE_SUPABASE_PUBLISHABLE_KEY only.
 * Server/scripts: PRODUCTION_SUPABASE_SECRET_KEY / STAGING_SUPABASE_SECRET_KEY (or legacy JWT names).
 */
import { PRODUCTION_SUPABASE_URL, STAGING_SUPABASE_URL } from "./schemaConfig.js";

function viteEnv() {
  try {
    return import.meta.env;
  } catch {
    return undefined;
  }
}

export function resolveProductionSupabaseSecret() {
  if (typeof process === "undefined" || !process.env) return "";
  return (
    process.env.PRODUCTION_SUPABASE_SECRET_KEY ||
    process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SB_SECRET ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  );
}

export function resolveStagingSupabaseSecret() {
  if (typeof process === "undefined" || !process.env) return "";
  return (
    process.env.STAGING_SUPABASE_SECRET_KEY ||
    process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.STAGING_SUPABASE_SERVICE_KEY ||
    ""
  );
}

/** URL for browser Storage API (state.json legacy sync). */
export function getClientSupabaseUrl() {
  const env = viteEnv();
  if (env?.VITE_SUPABASE_URL) return String(env.VITE_SUPABASE_URL).replace(/\/$/, "");
  if (env?.VITE_STAGING_DB_MODE === "true") return STAGING_SUPABASE_URL;
  return PRODUCTION_SUPABASE_URL;
}

/** Publishable key — safe for Vite client bundle (legacy state.json mode only). */
export function getClientSupabasePublishableKey() {
  const env = viteEnv();
  const key = env?.VITE_SUPABASE_PUBLISHABLE_KEY || env?.VITE_SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error(
      "Set VITE_SUPABASE_PUBLISHABLE_KEY (Supabase publishable / sb_publishable key) for state.json cloud sync"
    );
  }
  return key;
}

/** Node verify scripts + legacy local tools — service secret, never bundled to client. */
export function resolveScriptStorageApiKey() {
  const secret = resolveProductionSupabaseSecret();
  if (secret) return secret;
  throw new Error(
    "Set PRODUCTION_SUPABASE_SECRET_KEY (sb_secret) or PRODUCTION_SUPABASE_SERVICE_ROLE_KEY in environment"
  );
}