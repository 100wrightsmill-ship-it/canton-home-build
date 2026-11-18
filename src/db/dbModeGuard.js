/**
 * Guards against cross-mode writes: DB mode must not touch state.json;
 * state.json mode must not route through normalized DB API.
 */

let forceBlockStateJson = false;

/** Test hook — simulates DB mode in Node without Vite env. */
export function setForceBlockStateJson(value) {
  forceBlockStateJson = Boolean(value);
}

export function isStagingDbMode() {
  try {
    return import.meta.env?.VITE_STAGING_DB_MODE === "true";
  } catch {
    return false;
  }
}

export function isProductionDbMode() {
  try {
    return import.meta.env?.VITE_PRODUCTION_DB_MODE === "true";
  } catch {
    return false;
  }
}

export function isAnyDbMode() {
  return isStagingDbMode() || isProductionDbMode() || forceBlockStateJson;
}

export function assertStateJsonWriteAllowed(context = "state.json") {
  if (isAnyDbMode()) {
    throw new Error(`DB mode active: ${context} writes are blocked`);
  }
}

export function assertDbModeOnly(context = "normalized DB") {
  if (!isAnyDbMode()) {
    throw new Error(`State.json mode active: ${context} writes are blocked`);
  }
}

export function assertMutuallyExclusiveDbModes() {
  if (isStagingDbMode() && isProductionDbMode()) {
    throw new Error("Invalid build: VITE_STAGING_DB_MODE and VITE_PRODUCTION_DB_MODE cannot both be true");
  }
}
