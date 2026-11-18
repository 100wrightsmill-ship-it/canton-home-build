export {
  isProductionDbMode,
  isAnyDbMode,
  assertMutuallyExclusiveDbModes,
} from "../db/dbModeGuard.js";

export const PRODUCTION_API_BASE =
  import.meta.env.VITE_PRODUCTION_API_BASE || "/production-api";
