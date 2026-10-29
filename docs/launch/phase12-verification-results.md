# Phase 12 — real-backend integration verification

Branch: `feature/phase12-real-backend-verification` (from Phase 11 tip `b0a844b`).
Hosted `GulfMover-Demo` untouched. No live payments, no notifications sent.
Old repository preserved; work pushed to `Zayn-Studio-Designs/GulfMoverMockApp-New`.

## What was already proven (verified, not assumed)

Phase 11 CI run
[40880629820](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/40880629820)
(both jobs success, verified via `gh`):
- App job: 28 files passed, 11 skipped — **885 passed / 121 skipped / 0 failed**.
- Database job (clean install of all 28 migrations on a disposable database):
  `test:db` **39 passed / 3 skipped**, upgrade suite **3 passed**,
  backup/restore drill **PASS**.
- The database job genuinely executes SQL-level tests (commerce tariffs/pricing,
  booking engine, idempotency, concurrency, checkout, refunds, minimum-sailing,
  boarding gates; operations credit/settlements/materials/charters/comms/MFA/
  privacy/reports; helper-grant catalog checks) — confirmed from job logs,
  not from the green badge alone.

## New in Phase 12: local disposable PostgreSQL + 6 isolation tests

Docker is unavailable on this machine, so `scripts/db/local-db.sh` cannot run
here. Instead a loopback-only PostgreSQL 17 cluster was created with Homebrew
(`/tmp/gm-pg12`, port 54333) and provisioned to match the CI database:
roles `anon`/`authenticated`/`service_role`, minimal `auth.users`,
`supabase/tests/auth_stub.sql`, `extensions` schema (`pgcrypto`, `uuid-ossp`),
a `supabase_migrations.schema_migrations` ledger, then **all 28 migrations in
order** (smoke: 2 seeded routes, `health_ping` ok). The cluster is discarded
with the temp dir; nothing reaches any hosted project.

New file `src/tests/db/phase12.isolation.db.test.ts` (6 tests, all passing
against this real database):

1. Company-A vs Company-B cannot read each other's bookings in either
   direction, and neither admin can create a booking billed to the other
   company (`not_a_member`); a booker of A sees none of B's records.
2. Bookers see only bookings they created; a `company_admin` of an active org
   sees all of that company's bookings (matches the corporate workspace's
   "own bookings" + admin report split).
3. Anonymous callers are denied protected writes (`42501`): individual
   booking creation, checkout begin, ticket manifest.
4. Ordinary customers are denied staff-only writes (`42501`): sailing
   readiness, charter allocation, tariff publishing — with a positive control
   proving operations staff CAN set readiness on the same sailing.
5. A fresh sailing reports an honest empty manifest (0 rows, no error),
   boarding gate `not_ready`, commercial state `awaiting_minimum`.
6. Pricing pin: SAR 500/passenger/leg, VAT not configured
   (`50000|6|300000|0|300000|not_configured`).

Two wrong expectations were fixed during development (both test bugs, not app
bugs): `set_sailing_readiness` returns `recorded` (row becomes `ready`), and
`sailing_commercial_status` returns a composite — the assertion now selects
`commercial_state`.

## Results on the local disposable database

- `npm run test:db`: **45 passed / 3 skipped / 0 failed**
  (4 files passed, 1 skipped — the skip is the Docker-dependent upgrade
  container test, same as CI's skipped file).
- `npm run test:db:upgrade` locally: fails only because it shells out to
  `local-db.sh up-to`, which needs Docker (`docker: command not found`).
  The same suite **passes in CI** (3 passed). Not a code failure.
- `npm run typecheck`: clean. `npm test`: **885 passed / 127 skipped**
  (the +6 skips vs CI are the new DB tests skipping without `GM_DB_URL`).
- `npm run build`: succeeds. `check:env -- development`: 0 errors.
  `git diff --check`: clean.

## What this proves vs what remains stub-only

Proven against real PostgreSQL (RLS + grants + SECURITY DEFINER paths):
auth-role JWT enforcement, Company-A/B booking isolation both directions,
admin/booker visibility split, anon denial, customer-vs-staff write
boundaries, charter conflict handling (existing suite), pricing/minimum rules,
manifest/boarding honest-empty behavior.

Still NOT proven against a real backend:
- Supabase Auth session persistence (signup/signin/refresh). The harness fakes
  JWT claims; GoTrue never runs here or in CI.
- Authenticated **browser** journeys against a real backend. Phase 11's 60/60
  stubbed journeys remain the UI evidence; the per-persona stubs simulate RLS
  by construction and cannot prove it.
- Upgrade path locally (needs Docker); covered by CI instead.
- Hosted staging, live payments, port clearance, devices, production approval
  — unchanged ATCO/launch gates.

## Remaining blockers (no guessing)

1. Docker (or an isolated Supabase test project) is needed for local upgrade
   + backup-drill runs; CI currently covers both.
2. Authenticated browser tests against a real isolated backend need a test
   project or a runnable local stack with GoTrue + PostgREST; until then the
   stubbed suite + SQL-level isolation tests are the evidence stack.
3. The standing ATCO gates (tariff/VAT, live payments, port clearance,
   hosting/PITR, devices, legal) are out of scope for code phases.
