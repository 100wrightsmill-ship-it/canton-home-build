/** Normalize Postgres / ISO date values to YYYY-MM-DD for app state (read path). */

export function fromDbDate(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const y = v.getFullYear();
    const m = v.getMonth() + 1;
    const d = v.getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const t = String(v).trim();
  if (!t || t === "null" || t === "undefined") return "";
  const iso = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return t;
}

/** MM/DD/YYYY for staging UI display. */
export function formatDisplayDate(v) {
  const d = fromDbDate(v);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

/** Safe display for timestamps (messages, notifications). */
export function formatDisplayDateTime(v) {
  if (v == null || v === "") return "";
  const t = String(v).trim();
  if (!t) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return fromDbDate(t) ? formatDisplayDate(t) : t;
  return d.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Strip DB null-ish artifacts from text fields for UI. */
export function fromDbText(v) {
  if (v == null) return "";
  const t = String(v).trim();
  if (t === "null" || t === "undefined") return "";
  return t;
}
