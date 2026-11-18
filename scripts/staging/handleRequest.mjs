/**
 * Staging API handler — cc_staging DB + staging Storage only.
 */
import { createDbHandler } from "../shared/dbHandler.mjs";
import {
  uploadStagingObject,
  fetchStagingObject,
  deleteStagingObject,
  ensureStagingBucket,
} from "./supabaseStorage.mjs";

const stagingStorage = {
  uploadObject: uploadStagingObject,
  fetchObject: fetchStagingObject,
  deleteObject: deleteStagingObject,
  ensureBucket: ensureStagingBucket,
};

export function createStagingHandler(pool) {
  return createDbHandler(pool, { mode: "staging-db", storage: stagingStorage });
}
