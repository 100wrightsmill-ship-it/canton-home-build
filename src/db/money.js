/** Exact monetary values — never use JS float for persistence. */

export function toMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

export function sumMoney(rows, field = "amount") {
  let cents = 0;
  for (const row of rows) {
    const v = row[field];
    if (v == null || v === "") continue;
    cents += Math.round(Number(v) * 100);
  }
  return (cents / 100).toFixed(2);
}

export function moneyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return toMoney(a) === toMoney(b);
}
