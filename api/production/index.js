/**
 * Vercel serverless production DB API — cc_production + production Storage.
 * All /api/production/* requests are rewritten here (see vercel.production.json).
 * Requires PRODUCTION_DATABASE_POOLER_URL on Vercel (transaction pooler).
 */
import { createProductionPool } from "../../src/db/pg.js";
import { createProductionHandler } from "../../scripts/production/handleRequest.mjs";
import { setActiveSchema } from "../../src/db/schemaContext.js";
import { PRODUCTION_SCHEMA } from "../../src/db/schemaConfig.js";
import {
  resolveVercelApiSubPath,
  toHandlerUrlPath,
  buildHandlerQueryString,
} from "../../scripts/shared/vercelApiPath.mjs";

setActiveSchema(PRODUCTION_SCHEMA);

let pool;
let handler;

function getHandler() {
  if (!handler) {
    pool = createProductionPool();
    handler = createProductionHandler(pool);
  }
  return handler;
}

export default async function productionApi(req, res) {
  if (!process.env.PRODUCTION_DATABASE_POOLER_URL) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Production DB pooler URL not configured on this deployment" }));
    return;
  }

  const sub = resolveVercelApiSubPath(req, "/api/production");
  const qs = buildHandlerQueryString(req);
  const urlPath = toHandlerUrlPath(sub, qs);

  const handle = getHandler();
  await handle(
    {
      method: req.method,
      url: urlPath,
      async *[Symbol.asyncIterator]() {
        if (req.body) {
          const chunk =
            typeof req.body === "string"
              ? Buffer.from(req.body)
              : Buffer.isBuffer(req.body)
                ? req.body
                : Buffer.from(JSON.stringify(req.body));
          yield chunk;
        }
      },
    },
    res,
    { urlPath }
  );
}

export const config = {
  api: { bodyParser: false },
};
