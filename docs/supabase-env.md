# Supabase environment variables

Never commit API keys. Use Supabase Dashboard → Project Settings → API.

## Production (Vercel + `.env.production.local`)

| Variable | Where | Purpose |
|----------|--------|---------|
| `PRODUCTION_SUPABASE_URL` | Server | Storage API base URL |
| `PRODUCTION_SUPABASE_SECRET_KEY` | Server only | `sb_secret_…` — Storage uploads, scripts, `/api/production` |
| `PRODUCTION_DATABASE_POOLER_URL` | Server | Postgres (transaction pooler) |

Legacy name `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` is still accepted until removed.

## Local legacy state.json sync (`npm run dev` without DB mode)

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` — browser Storage reads/writes for `state.json` mode only |
| `VITE_SUPABASE_URL` | Optional override (defaults to production project URL) |

Production DB builds (`VITE_PRODUCTION_DB_MODE=true`) do not call Supabase from the browser; documents and state use `/api/production`.

## Staging

| Variable | Purpose |
|----------|---------|
| `STAGING_SUPABASE_URL` | Server |
| `STAGING_SUPABASE_SECRET_KEY` | Server (`sb_secret_…`) |

Sync to Vercel: `npm run setup:vercel:production` or `setup:vercel:staging` after filling gitignored env files.