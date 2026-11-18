/**
 * Vercel serverless staging API — cc_staging + STAGING Storage only.
 * All /api/staging/* requests are rewritten here (see vercel.staging.json).
 * Requires STAGING_DATABASE_POOLER_URL + STAGING_SUPABASE_SERVICE_ROLE_KEY on Vercel.
 */
import { createStagingPool } from "../../src/db/pg.js";
import { createStagingHandler } from "../../scripts/staging/handleRequest.mjs";
import {
  resolveVercelApiSubPath,
  toHandlerUrlPath,
  buildHandlerQueryString,
} from "../../scripts/shared/vercelApiPath.mjs";

let pool;
let handler;

function getHandler() {
  if (!handler) {
    pool = createStagingPool();
    handler = createStagingHandler(pool);
  }
  return handler;
}

export default async function stagingApi(req, res) {
  if (!process.env.STAGING_DATABASE_POOLER_URL) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ ok: false, error: "Staging DB pooler URL not configured on this deployment" })
    );
    return;
  }

  const sub = resolveVercelApiSubPath(req, "/api/staging");
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
