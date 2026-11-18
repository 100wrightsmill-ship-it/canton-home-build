# Production Cutover Plan — DB Mode (Plan Only)

**Status:** Prepared for review. **Do not execute** until explicit approval.

**Staging validation:** 14/14 UI tests PASS, document storage 9/9 PASS, final reconciliation PASS, visual inspection approved.

---

## Principles

| Rule | Detail |
|------|--------|
| Fresh snapshot only | Migration source is a **brand-new read-only GET** of production `state.json` taken **immediately before** schema/migrate — not `backups/staging-migration-source/live-snapshot-20261004.json` |
| state.json untouched | Cutover prep **never** PUTs to `state.json`. It remains the live rollback source |
| 100% reconciliation gate | DB mode is enabled **only** if every reconciliation check passes against the fresh snapshot |
| Abort on any mismatch | Any count, financial, orphan, or duplicate failure → stop cutover; production app stays on `state.json` |
| Permanent backups first | Cloud + local backups of state and Storage **before** any schema or migration work |

---

## Architecture (production)

| Component | Production value | Notes |
|-----------|------------------|-------|
| Supabase project | `bdckzzweimrmvcvvahbr` | Same project as today |
| Storage bucket | `cc-data` | Unchanged paths: `state.json`, `documents/{project_id}/{doc_id}/…` |
| Postgres schema | **`cc_production`** (new) | Parallel to `public`; does **not** replace Storage |
| App (today) | Vercel → reads/writes `state.json` via `cloudSync.js` | Unchanged until approved deploy |
| App (after cutover) | Vercel → production DB API + same Storage bucket | New env flag + API (mirrors staging pattern) |

Staging used a **separate** Supabase project (`cc_staging`). Production cutover adds `cc_production` on the **production** Postgres instance so documents stay in the existing bucket.

---

## Pre-cutover code work (required before execution)

These items are **not built yet**. Complete them in a feature branch; do not run against production until approved.

1. **`cc_production` schema SQL** — copy `supabase/migrations/staging/001_cc_staging_schema.sql` → `supabase/migrations/production/001_cc_production_schema.sql`, replace all `cc_staging` → `cc_production`.
2. **Schema parameterization** — `tableOrder.js`, `pg.js`, `client.js`, reconcile/migrate scripts accept `CC_SCHEMA=cc_production` (or `PRODUCTION_DATABASE_URL` + dedicated scripts).
3. **Production npm scripts** — mirror staging:
   - `db:production:fetch-source`
   - `db:production:record-baseline`
   - `db:production:backup-storage`
   - `db:production:schema`
   - `db:production:migrate`
   - `db:production:reconcile`
   - `db:production:pipeline` (orchestrates steps 4–6 below, **stops before app deploy**)
4. **Reconciliation fix** — `reconcileSnapshot()` currently hardcodes staging baseline (3/81/19, fixed dollar amounts). Production mode must compare **only** against the fresh snapshot manifest recorded in Step 2 (no stale constants).
5. **Archive script fix** — `scripts/archive-cloud-baseline.mjs` still expects 18 contacts; remove fixed EXPECTED or read from cutover manifest.
6. **Production API + app flag** — production equivalent of `staging-api-server` / `VITE_STAGING_DB_MODE` (e.g. `VITE_PRODUCTION_DB_MODE`), wired to `cc_production` on Vercel serverless.
7. **`.env.production.local`** (gitignored) — `PRODUCTION_DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` for backup/list operations only on operator machine.

---

## Cutover procedure (execute only after approval)

Single operator, quiet window recommended. **Estimated duration:** 30–60 minutes (excluding code prep).

### Step 0 — Freeze

- [ ] Confirm no other production deploys in progress
- [ ] Confirm Vercel production is on current stable build (`state.json` mode)
- [ ] Note current `cloudRevision` from live app or cloud fetch

### Step 1 — Permanent backups (before anything else)

**1a. Fresh read-only snapshot (cutover source of truth)**

```bash
# After code prep — saves to backups/production-cutover-source/
npm run db:production:fetch-source
# Output: backups/production-cutover-source/live-snapshot-YYYYMMDD.json
#         + .manifest.json (fetchedAt, cloudRevision, savedAt)
```

- Read-only GET only. **Do not** use any file under `backups/staging-migration-source/`.
- Record the exact filename; all later steps use **this file only**.

**1b. Cloud archive of state.json**

```bash
node scripts/archive-cloud-baseline.mjs
# Writes: cc-data/backups/state-verified-baseline-{timestamp}.json
# (Update script first: archive without stale count gate, or gate against Step 2 manifest)
```

Prefer an additional explicit pre-cutover name:

```
cc-data/backups/state-pre-cutover-{ISO-timestamp}.json
```

**1c. Local permanent copy**

```bash
mkdir -p backups/production-cutover/{timestamp}
cp backups/production-cutover-source/live-snapshot-YYYYMMDD.json \
   backups/production-cutover/{timestamp}/state.json
cp backups/production-cutover-source/live-snapshot-YYYYMMDD.manifest.json \
   backups/production-cutover/{timestamp}/manifest.json
```

**1d. Full Storage backup**

Backup **entire** `cc-data` bucket (or at minimum `state.json`, `backups/*`, `documents/**`):

```bash
npm run db:production:backup-storage
# Target cloud prefix: cc-data/backups/storage-pre-cutover-{timestamp}/
# Target local dir:    backups/production-cutover/{timestamp}/storage-manifest.json
```

Verify object count in manifest matches Storage list API. **If Storage backup fails → abort cutover.**

**Rollback assets after Step 1:**

| Asset | Location |
|-------|----------|
| Live state (unchanged) | `cc-data/state.json` |
| Cloud state archive | `cc-data/backups/state-pre-cutover-*` |
| Local state copy | `backups/production-cutover/{timestamp}/state.json` |
| Storage mirror | `cc-data/backups/storage-pre-cutover-*` |

---

### Step 2 — Record exact production baseline

Run baseline recorder against **the same fresh snapshot file** from Step 1:

```bash
npm run db:production:record-baseline -- \
  --source backups/production-cutover-source/live-snapshot-YYYYMMDD.json
```

Writes `backups/production-cutover/{timestamp}/production-baseline.json` containing:

- Entity counts: projects, pays, contacts, scopes, stages, payment_schedules, documents, …
- Per-table extracted row counts (all 22 tables)
- Financial totals (Jordan contract/expenses, Canton expenses, Cabinets CO, Jordan Electrical budget, Elder scope, …)
- `cloudRevision`, `savedAt`, document storage path count
- Duplicate IDs and orphan refs (must be 0 for cutover gate, except known nullified warnings logged explicitly)

**Human sign-off:** Review `production-baseline.json` and confirm numbers match live app UI before proceeding.

Reference (staging-validated Oct 4 snapshot — **re-record from fresh fetch; do not assume unchanged**):

| Metric | Staging-validated value |
|--------|-------------------------|
| Projects | 3 |
| Pays | 81 |
| Contacts | 19 |
| Scopes / stages / pmts | 24 / 60 / 29 |
| Jordan contract | $67,575.00 |
| Jordan expenses | $40,393.00 |
| Canton expenses | $134,937.00 |
| Cabinets CO | $9,450.00 |
| Jordan Electrical budget | $49,000.00 |
| Elder scope | $1,500.00 |

---

### Step 3 — Create normalized production schema

```bash
npm run db:production:schema
# Applies supabase/migrations/production/001_cc_production_schema.sql
# Creates empty cc_production (22 tables, NUMERIC(12,2), document FKs, version triggers)
```

- **Does not** touch `state.json` or Storage document files
- Schema must be **empty** before migrate
- If schema already exists from a failed attempt: `--reset` only with explicit approval (drops `cc_production` only)

---

### Step 4 — Migrate fresh production snapshot

```bash
npm run db:production:migrate -- \
  --source backups/production-cutover-source/live-snapshot-YYYYMMDD.json
```

- Strict **INSERT** only; duplicate ID with field mismatch → **STOP**
- Same transform/nullify rules as staging (2 known dangling refs nullified with warnings)
- Verify migrate script SHA/hash of source file matches Step 1 manifest

---

### Step 5 — Full reconciliation (100% gate)

```bash
npm run db:production:reconcile -- \
  --source backups/production-cutover-source/live-snapshot-YYYYMMDD.json \
  --baseline backups/production-cutover/{timestamp}/production-baseline.json
```

Report saved to: `backups/production-cutover/{timestamp}/reconciliation-report.json`

**Pass criteria (all required):**

- [ ] Every `db.{table}` count matches snapshot extracted counts
- [ ] All financial checks match snapshot financials exactly (NUMERIC string compare)
- [ ] `duplicate_ids` = 0
- [ ] `orphan_relationships` = 0 (snapshot)
- [ ] `db.orphans` = 0
- [ ] No failed checks in report (`passed: true`)

**If `passed: false` → ABORT (Step 7). Do not proceed to app switch.**

Optional post-gate checks (recommended, non-blocking for abort unless you choose):

```bash
npm run db:production:test:concurrency   # optimistic locking
npm run db:production:storage:test       # document read/write against production bucket paths
```

---

### Step 6 — Abort decision

| Condition | Action |
|-----------|--------|
| Reconciliation **PASS** | Proceed to **approval gate** for app deploy (below) |
| Reconciliation **FAIL** | **Abort.** Leave production app on `state.json`. Document failures. `cc_production` may remain dormant |
| Migrate strict-insert conflict | **Abort.** Do not re-run with upsert |
| Source file ≠ Step 1 snapshot | **Abort.** Re-fetch fresh snapshot and restart from Step 1 |
| Storage backup incomplete | **Abort.** Do not migrate |

**During abort:** No Vercel deploy. No PUT to `state.json`. User data unchanged.

---

### Step 7 — App switch (ONLY after your explicit approval + Step 5 PASS)

**Not part of this plan execution.** Requires separate approval message.

1. Deploy production build with DB mode enabled (`VITE_PRODUCTION_DB_MODE=true` or equivalent)
2. Deploy production API (Vercel serverless → `cc_production` + existing Storage)
3. Env vars on Vercel: `PRODUCTION_DATABASE_URL`, Supabase URL/keys (server-side only)
4. Smoke test: counts and Jordan/Canton totals in UI match `production-baseline.json`
5. Monitor first 24h: delta writes to DB only; **do not delete** `state.json` yet

**Recommended soft launch:** Read from DB, keep periodic read-only state.json export for parity checks for one week before retiring full-state cloud writes.

---

## Rollback procedure (exact)

Use if cutover fails at any step **or** if DB mode deploy causes production issues.

### Scenario A — Failed before app deploy (Steps 1–5)

No user-facing change required.

1. Stop pipeline
2. Leave `cc-data/state.json` as-is (never modified)
3. Optionally drop `cc_production` schema: `npm run db:production:schema -- --reset` (optional cleanup)
4. Retain all backups under `backups/production-cutover/` and `cc-data/backups/state-pre-cutover-*`

### Scenario B — DB mode deployed; revert to state.json app

1. **Immediate:** Redeploy previous Vercel production deployment (last known-good `state.json` build)
   ```bash
   vercel rollback   # or promote prior deployment in Vercel dashboard
   ```
2. Confirm app loads from `state.json` via `cloudSync.js` (cloud sync banner, correct totals)
3. **Do not** delete `cc_production` data until root cause is understood (aids forensics)
4. Compare live UI to `backups/production-cutover/{timestamp}/production-baseline.json`

### Scenario C — state.json was accidentally modified during cutover attempt

Only if a PUT occurred (should **not** happen in this plan):

1. List cloud backups:
   ```bash
   node -e "
   import { listCloudStateBackups } from './src/sync/cloudSync.js';
   const r = await listCloudStateBackups(20);
   console.log(r.items?.map(i => i.name));
   "
   ```
2. Restore pre-cutover archive (archives current cloud first):
   ```bash
   node scripts/restore-production-from-recovery.mjs \
     --json-file backups/production-cutover/{timestamp}/state.json
   ```
3. Verify metrics against `production-baseline.json`
4. Roll back Vercel to `state.json` build (Scenario B)

### Scenario D — Storage document corruption

1. Identify affected paths from `storage-manifest.json`
2. Copy objects back from `cc-data/backups/storage-pre-cutover-{timestamp}/` prefix
3. Verify document opens in app

### Rollback verification checklist

- [ ] `cc-data/state.json` cloudRevision ≥ pre-cutover value (or restored from archive)
- [ ] Projects / pays / contacts counts match baseline manifest
- [ ] Jordan contract $67,575 / expenses $40,393 (or whatever baseline recorded)
- [ ] Canton expenses match baseline
- [ ] Documents open from Storage
- [ ] Production URL serves pre-cutover deployment

---

## What this plan explicitly does NOT do

- Does not run production migration
- Does not deploy DB mode to Vercel
- Does not PUT or DELETE `state.json`
- Does not modify existing backups under `cc-data/backups/` or local `backups/recovery-*`
- Does not use the Oct 4 staging snapshot as migration source

---

## Approval checklist (for you)

Before authorizing execution, confirm:

- [ ] Pre-cutover code work (schema, scripts, reconcile fix, production API) is merged/reviewed
- [ ] `.env.production.local` credentials tested with read-only queries
- [ ] Staging service role key rotated if it was exposed in chat
- [ ] Quiet window scheduled
- [ ] You will review `production-baseline.json` and `reconciliation-report.json` before authorizing Step 7

**To authorize:** Reply with explicit approval to execute Steps 1–5 (pipeline only) and/or Step 7 (app deploy) separately.

---

## Command summary (after code prep)

```bash
# Full pre-deploy pipeline (NO app switch)
npm run db:production:fetch-source
node scripts/archive-cloud-baseline.mjs          # + storage backup script
npm run db:production:record-baseline -- --source backups/production-cutover-source/live-snapshot-YYYYMMDD.json
npm run db:production:schema
npm run db:production:migrate -- --source backups/production-cutover-source/live-snapshot-YYYYMMDD.json
npm run db:production:reconcile -- --source ... --baseline backups/production-cutover/{ts}/production-baseline.json

# Only after explicit approval:
# vercel deploy --prod  (with PRODUCTION_DB_MODE build)
```

---

## Related files

| File | Role |
|------|------|
| `scripts/db/fetch-migration-source.mjs` | Template for read-only production GET |
| `scripts/archive-cloud-baseline.mjs` | Cloud state archive |
| `scripts/restore-production-from-recovery.mjs` | state.json restore pattern |
| `src/db/reconcile.js` | Reconciliation engine (needs production mode) |
| `src/sync/cloudSync.js` | Production Storage sync (unchanged until Step 7) |
| `docs/staging-db-phase2.md` | Staging pipeline reference |
