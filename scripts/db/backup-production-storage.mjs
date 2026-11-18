#!/usr/bin/env node
/**
 * Full read-only backup of production cc-data Storage to cloud backup prefix + local manifest.
 * Does NOT modify state.json or existing objects (copies only).
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadProductionEnv } from "./load-production-env.mjs";
import { requireProductionConfirmation } from "../../src/db/safety.js";
import {
  listProductionObjects,
  copyProductionObject,
  fetchProductionObject,
} from "../production/supabaseStorage.mjs";
import { BUCKET } from "../../src/sync/cloudSync.js";

loadProductionEnv();
requireProductionConfirmation();

/** Recursively list all file object paths under a prefix. */
async function walkStorage(prefix = "") {
  const paths = [];
  let offset = 0;
  while (true) {
    const batch = await listProductionObjects(prefix, { limit: 1000, offset });
    if (!batch.length) break;
    for (const item of batch) {
      const rel = item.name;
      if (!rel) continue;
      const fullPath = prefix ? `${prefix}${rel}` : rel;
      const isFolder = item.id == null && !item.metadata;
      if (isFolder) {
        const nested = await walkStorage(`${fullPath}/`);
        paths.push(...nested);
      } else {
        paths.push(fullPath);
      }
    }
    if (batch.length < 1000) break;
    offset += batch.length;
  }
  return paths;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPrefix = `backups/storage-pre-cutover-${stamp}/`;
  const outDir = join(process.cwd(), "backups/production-cutover", stamp);
  mkdirSync(outDir, { recursive: true });

  console.log(`Listing production Storage (${BUCKET})…`);
  const objectPaths = await walkStorage("");
  console.log(`Found ${objectPaths.length} file objects`);

  const manifest = {
    purpose: "production-storage-backup",
    createdAt: new Date().toISOString(),
    bucket: BUCKET,
    cloudBackupPrefix: backupPrefix,
    objectCount: objectPaths.length,
    objects: [],
  };

  for (const sourcePath of objectPaths) {
    const destPath = `${backupPrefix}${sourcePath}`;
    manifest.objects.push({ source: sourcePath, backup: destPath });

    if (dryRun) {
      console.log(`  [dry-run] would copy ${sourcePath}`);
      continue;
    }

    if (sourcePath.startsWith(backupPrefix)) {
      console.log(`  skip self-backup: ${sourcePath}`);
      continue;
    }

    try {
      await copyProductionObject(sourcePath, destPath);
      console.log(`  ✓ ${sourcePath}`);
    } catch (e) {
      console.error(`  ✗ ${sourcePath}: ${e.message}`);
      manifest.errors = manifest.errors || [];
      manifest.errors.push({ path: sourcePath, error: e.message });
    }
  }

  if (!dryRun && objectPaths.includes("state.json")) {
    const stateBackup = await fetchProductionObject("state.json");
    writeFileSync(join(outDir, "state.json"), stateBackup.buffer);
  }

  const manifestPath = join(outDir, "storage-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`Cloud backup prefix: ${BUCKET}/${backupPrefix}`);

  if (manifest.errors?.length) {
    console.error(`\n${manifest.errors.length} errors — review manifest before cutover`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
