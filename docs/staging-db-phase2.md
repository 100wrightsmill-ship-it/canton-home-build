# Phase 2 — Staging Database (cc_staging schema)

**Status:** Code complete. Snapshot validation PASS. DB pipeline requires `STAGING_DATABASE_URL`.

Production is **not** touched: no production tables, no `state.json` changes, no app cutover.

## Document model — final recommendation

**Rejected:** single polymorphic `parent_type` / `parent_id` without FK enforcement.

**Adopted:** one `documents` table with **nullable, mutually exclusive FK columns**:

| Column | FK target | When set |
|--------|-----------|----------|
| `project_id` | `projects.id` | **Always required** |
| `contact_id` | `contacts.id` | Contractor-attached doc |
| `scope_id` | `scopes.id` | Scope doc / estimate |
| `payment_schedule_id` | `payment_schedules.id` | Payment receipt |
| `change_order_id` | `project_change_orders.id` | CO attachment |

Constraint: at most one of `(contact_id, scope_id, payment_schedule_id, change_order_id)` may be non-null.

Project-level docs: only `project_id` + `folder_key` set.

Storage paths unchanged: `documents/{project_id}/{doc_id}/{filename}`.

## Money

All amounts: `NUMERIC(12,2)` — never float. Transform layer uses string `"1234.56"` → Postgres NUMERIC.

## Offline (Phase 2 scope)

**Read-only offline only.** `StagingDbClient` rejects writes when offline. No pending-operation queue.

## Migration safety

- Target schema `cc_staging` must be **empty** before first import.
- `INSERT` only; on duplicate ID → field-compare existing row → **STOP** if mismatch.
- No `ON CONFLICT DO UPDATE`.
- Source: `backups/staging-migration-source/live-snapshot-*.json` (fresh live GET).
- 2 dangling refs in live snapshot are nullified with warnings (missing phase, missing pmt on receipt doc).

## Connect staging project (local tooling)

### What you need (minimum)

| Variable | Required? | Used for |
|----------|-----------|----------|
| `STAGING_DATABASE_URL` | **Yes** | Schema, migrate, reconcile, concurrency tests |
| `STAGING_SUPABASE_URL` | No | Future staging API/Storage (not used in Phase 2 pipeline) |
| `STAGING_SUPABASE_ANON_KEY` | No | Future staging API (not used in Phase 2 pipeline) |

Production credentials are **not** used for the DB pipeline. Migration reads the local snapshot file only.

### Where to get values — Supabase dashboard

1. Open [supabase.com/dashboard](https://supabase.com/dashboard) → select **Canton Home Build Staging**.
2. **Project reference ID** (for URL host):
   - **Project Settings** (gear, bottom of left sidebar) → **General** → **Reference ID**
   - Example host: `db.<reference-id>.supabase.co`
3. **Database password**:
   - **Project Settings** → **Database** → **Database password**
   - If unknown: **Reset database password** (staging only — safe).
4. **Connection string** (copy URI):
   - **Project Settings** → **Database** → **Connection string**
   - Tab: **URI**
   - Mode: **Direct connection** (port **5432**) — preferred for migrations
   - Copy the string; replace `[YOUR-PASSWORD]` with your database password.

Example (direct):

```
postgresql://postgres:YOUR_PASSWORD@db.abcdefghijklmnop.supabase.co:5432/postgres
```

Session pooler (port 6543) also works if direct is blocked on your network.

### Store locally (gitignored)

```bash
cp .env.staging.example .env.staging
# Edit .env.staging — paste STAGING_DATABASE_URL only
npm run db:staging:verify   # should print "Connected to staging Postgres"
```

`.env.staging` is matched by `.gitignore` (`.env.*`). **Never commit** `.env.staging` or service-role keys.

## npm scripts

| Script | Purpose |
|--------|---------|
| `db:staging:fetch-source` | Read-only fetch live `state.json` → backup file |
| `db:staging:schema` | Apply `cc_staging` DDL (`--reset` drops first) |
| `db:staging:migrate` | Extract + strict insert from snapshot |
| `db:staging:reconcile` | Acceptance report (snapshot ± DB) |
| `db:staging:test` | Unit tests (no DB) |
| `db:staging:test:concurrency` | Version conflict tests (needs DB) |
| `db:staging:pipeline` | Full staging run when DB available |

## Staging pipeline

```bash
npm run db:staging:test                              # always — 24 checks
npm run db:staging:schema -- --reset                 # create cc_staging
npm run db:staging:migrate -- --reset                # import snapshot
npm run db:staging:reconcile                         # acceptance report
npm run db:staging:test:concurrency                  # optimistic locking
```

## Snapshot validation (2026-10-04 live)

| Metric | Value |
|--------|-------|
| Projects | 3 |
| Pays | 81 |
| Contractors | 19 |
| Scopes / stages / pmts | 24 / 60 / 29 |
| Jordan contract | $67,575 |
| Jordan expenses | $40,393 |
| Canton expenses | $134,937 |
| Cabinets CO | $9,450 |
| Jordan Electrical | $49,000 |
| Elder scope | $1,500 |
| Documents | 16 (11 contact + 5 project) |
| Duplicate IDs | 0 |
| Orphan FKs (post-normalize) | 0 |

## Files

```
supabase/migrations/staging/001_cc_staging_schema.sql
src/db/{money,transform,extractRows,tableOrder,strictMigrate,reconcile,pg,client}.js
scripts/db/{fetch-migration-source,apply-staging-schema,run-staging-migration,reconcile-staging,test-staging-migration,test-staging-concurrency}.mjs
backups/staging-migration-source/live-snapshot-20261004.json
```

## Next step (requires your approval)

After you provide `STAGING_DATABASE_URL` and confirm staging Supabase project:

1. Run full pipeline
2. Share reconciliation JSON report
3. Stop — no production cutover until explicit approval
