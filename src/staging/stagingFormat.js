import { isAnyDbMode } from "./isStagingMode.js";
import { formatDisplayDate, formatDisplayDateTime, fromDbDate } from "../db/dates.js";

/** DB mode: format a date field for read-only UI (MM/DD/YYYY). */
export function uiDate(v) {
  if (!isAnyDbMode()) return v == null || v === "" ? "" : String(v);
  const formatted = formatDisplayDate(v);
  if (formatted) return formatted;
  const normalized = fromDbDate(v);
  return normalized || (v == null || v === "" ? "" : String(v));
}

/** Staging-only: format timestamp for read-only UI. */
export function uiDateTime(v) {
  if (!isAnyDbMode()) return v == null || v === "" ? "" : String(v);
  return formatDisplayDateTime(v) || (v == null || v === "" ? "" : String(v));
}

/** Staging-only: YYYY-MM-DD for date inputs. */
export function uiInputDate(v) {
  if (!isAnyDbMode()) return v == null || v === "" ? "" : String(v);
  return fromDbDate(v) || "";
}
