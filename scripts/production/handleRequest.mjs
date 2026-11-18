/**
 * Production API handler — cc_production DB + production Storage only.
 */
import { createDbHandler } from "../shared/dbHandler.mjs";
import {
  uploadProductionObject,
  fetchProductionObject,
  deleteProductionObject,
  listProductionObjects,
} from "./supabaseStorage.mjs";

const productionStorage = {
  uploadObject: (path, body, contentType, opts) =>
    uploadProductionObject(path, body, contentType, { ...opts, viaApi: true }),
  fetchObject: fetchProductionObject,
  deleteObject: (path, opts) => deleteProductionObject(path, { ...opts, viaApi: true }),
  listObjects: listProductionObjects,
};

export function createProductionHandler(pool) {
  return createDbHandler(pool, { mode: "production-db", storage: productionStorage });
}
