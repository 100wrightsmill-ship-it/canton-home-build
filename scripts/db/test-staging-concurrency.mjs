#!/usr/bin/env node
/**
 * Concurrency tests against staging cc_staging (requires STAGING_DATABASE_URL).
 * Tests optimistic version conflicts on row updates.
 *
 * Run: STAGING_DATABASE_URL=... node scripts/db/test-staging-concurrency.mjs
 */
import { loadStagingEnv } from "./load-staging-env.mjs";
import { StagingDbClient } from "../../src/db/client.js";
import { getStagingDatabaseUrl, withStagingClient } from "../../src/db/pg.js";
import { tableFqn } from "../../src/db/tableOrder.js";

loadStagingEnv();

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

async function main() {
  if (!getStagingDatabaseUrl()) {
    console.log("SKIP: STAGING_DATABASE_URL not set — concurrency tests require staging Postgres");
    process.exit(0);
  }

  const client = new StagingDbClient();
  await client.connect();

  console.log("offline write blocked");
  {
    const offline = client.createOfflineReadOnlyClient({});
    let blocked = false;
    try {
      await offline.updateRow("projects", "p1", { name: "X", version: 1 });
    } catch (e) {
      blocked = e.message.includes("Offline read-only");
    }
    assert(blocked, "offline client rejects writes");
  }

  console.log("optimistic version conflict");
  await withStagingClient(async (pg) => {
    const { rows } = await pg.query(`SELECT id, version, name FROM ${tableFqn("projects")} WHERE id = 'p1'`);
    if (!rows.length) {
      console.log("  SKIP: project p1 not in staging (run migration first)");
    } else {
      const row = rows[0];
      const c1 = new StagingDbClient({ pool: pg });
      const c2 = new StagingDbClient({ pool: pg });
      const updated = await c1.updateRow("projects", row.id, {
        name: row.name,
        version: row.version,
      });
      assert(updated.version === row.version + 1, "first update increments version");
      let conflict = false;
      try {
        await c2.updateRow("projects", row.id, { name: "Stale", version: row.version });
      } catch (e) {
        conflict = e.code === "VERSION_CONFLICT";
      }
      assert(conflict, "stale version rejected");
      await pg.query(`UPDATE ${tableFqn("projects")} SET name = $2, version = $3 WHERE id = $1`, [
        row.id,
        row.name,
        row.version,
      ]);
    }
  });

  console.log("parallel read consistency");
  await withStagingClient(async (pg) => {
    const [a, b] = await Promise.all([
      pg.query(`SELECT COUNT(*)::int AS c FROM ${tableFqn("pays")}`),
      pg.query(`SELECT COUNT(*)::int AS c FROM ${tableFqn("pays")}`),
    ]);
    assert(a.rows[0].c === b.rows[0].c, "parallel reads return same pay count");
    assert(a.rows[0].c === 81, "81 pays visible under concurrent read");
  });

  await client.disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
