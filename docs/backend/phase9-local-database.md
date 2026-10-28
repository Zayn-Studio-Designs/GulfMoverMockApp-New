# Phase 9 — Local database verification (loopback Postgres, no Docker)

Date: 2026-10-28. Branch: `feature/phase9-live-database-integrations` (from `c509aab`, no code changes — verification only).

## Environment (all loopback, nothing hosted)

- No hosted Supabase project, no credentials, and no Docker on this machine — so a
  hosted connection and the `supabase` local stack were both unavailable.
- Installed PostgreSQL 17 via Homebrew and ran three disposable loopback clusters:
  `127.0.0.1:54322` (clean install), `:54323` (upgrade path), `:54324` (restore target).
- Vanilla Postgres lacks the `auth`/`extensions` schemas the `supabase/postgres` image
  ships, so the harness applied a local-only shim (roles `anon`/`authenticated`/
  `service_role`, minimal `auth.users`, `extensions.pgcrypto`, the repo's
  `supabase/tests/auth_stub.sql`, and the `supabase_migrations` ledger that
  `scripts/db/local-db.sh` normally creates). No migration file was modified.

## Results

- **Clean install:** all 28 migrations applied with zero errors; `health_ping()`
  returns `schema_version 20261101100005`.
- **DB suite** (`GM_DB_URL` → `:54322`): 37 passed, 3 skipped (upgrade test needs Docker).
- **Upgrade path (manual, `:54323`):** migrated to last Phase 7 migration, booked 2 seats
  via `create_booking` as an authenticated company admin, then applied all 7 Phase 8
  migrations — booking reference, status, passenger count and `seats_booked` all
  survived intact.
- **Backup/restore drill (manual):** `pg_dump` of `public`+`auth`+`supabase_migrations`
  from `:54322` restored onto `:54324` — every public table row count matches and
  `health_ping()` reports the same schema version.
- **Unit suite:** 850 passed, 0 failed. `typecheck` clean, `vite build` succeeds,
  `check-env.mjs development` 0 errors, `git diff --check` clean.

## What is still missing (needs human action)

1. **Hosted Supabase project + keys** — create a dev/staging project, run the 28
   migrations, and set `VITE_APP_MODE=production`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_AUTH_RESET_REDIRECT_URL`. Nothing was connected.
2. **Production Auth/GoTrue** — the Supabase Auth flow, session restore and recovery
   emails are implemented but unverified (no GoTrue locally). RLS/role isolation
   itself IS verified at SQL level (privilege-sweep + cross-user tests pass).
3. **Storage service** — `material-attachments` bucket + RLS policies migrate cleanly
   and the client uses signed URLs, but upload/download needs the Storage API.
4. **Notifications** — Resend/Unifonic/WhatsApp adapters stay inert until provider
   credentials + `platform_settings` channel flags are set (verified: outbox rows
   record `suppressed` with consent respected; nothing is sent).
5. **Permits** — no ATCO permit API or documentation exists in the repo; readiness is
   a manual-review data field (`permit_status` on the operational decision RPC).
6. **Payments** — untouched as instructed. Verified sandbox-only: DB defaults
   `payments.mode='sandbox'`, live requires both `payments.live_enabled` AND
   `GM_PAYMENTS_LIVE_ENABLED=true`; test keys (`sk_test_`) enforced; webhooks
   verify server-side and the browser redirect is never trusted.
7. **Production UI gaps** — Corporate, Operations and Fleet routes render an honest
   "Not connected in this build" notice in production mode; booking, company
   registration/review, boarding, materials/charters, finance, reports, sailings,
   system and privacy are wired to backend services.

## Reproduce

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
# fresh cluster on 127.0.0.1:54322, apply shim + auth_stub + migrations (see §Environment),
export GM_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
npx vitest run src/tests/db
```
