/** Validate Storage object path from JSON body (POST fetch/upload/delete). */
export function parseStorageObjectPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
