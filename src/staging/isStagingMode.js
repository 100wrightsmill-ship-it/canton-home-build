export { isStagingDbMode, isAnyDbMode, assertMutuallyExclusiveDbModes } from "../db/dbModeGuard.js";

export const STAGING_API_BASE =
  import.meta.env.VITE_STAGING_API_BASE || "/staging-api";
