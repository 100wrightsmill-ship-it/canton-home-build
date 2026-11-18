/**
 * Restore cc_data_v1 to localhost:3333 from raw .bin backup.
 * READ backup only — never modifies backup files.
 *
 * Usage: node scripts/restore-localhost-from-raw.mjs <path-to.raw.bin>
 */
import { ClassicLevel } from "classic-level";
import fs from "fs";
import crypto from "crypto";

const LEVELDB =
  "/Users/danioffice/Library/Application Support/Cursor/Partitions/cursor-browser/Local Storage/leveldb";

const LOCALHOST_KEY = "_http://localhost:3333\x00\x01cc_data_v1";

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const backupPath = process.argv[2];
if (!backupPath) {
  console.error("Usage: node restore-localhost-from-raw.mjs <backup.raw.bin>");
  process.exit(1);
}

const backupShaBefore = sha256File(backupPath);
const rawBuf = fs.readFileSync(backupPath);

// Verify backup decodes as complete Jul 29 snapshot
const decoded = rawBuf.slice(1).toString("utf16le");
const parsed = JSON.parse(decoded);
console.log("Backup verified:", {
  savedAt: parsed.savedAt,
  savedAtISO: new Date(parsed.savedAt).toISOString(),
  contacts: parsed.contacts?.length,
  pays: parsed.pays?.length,
  projs: parsed.projs?.length,
});

const db = new ClassicLevel(LEVELDB, { createIfMissing: false });
await db.open();
await db.put(LOCALHOST_KEY, rawBuf);
await db.close();

const backupShaAfter = sha256File(backupPath);
if (backupShaBefore !== backupShaAfter) {
  console.error("ERROR: backup file checksum changed — abort");
  process.exit(1);
}

console.log("Restore complete:", {
  target: "http://localhost:3333 cc_data_v1",
  bytesWritten: rawBuf.length,
  backupPath,
  backupSha256Unchanged: backupShaBefore,
});
