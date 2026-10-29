# Phase 13 — real Supabase Auth and end-to-end verification

Branch: `feature/phase13-real-auth-e2e` (from Phase 12 tip `011179c`).
Hosted `GulfMover-Demo` untouched. No live payments, no notifications sent.
Old repository preserved; work pushed to `Zayn-Studio-Designs/GulfMoverMockApp-New`.

## What actually ran (no mocks)

CI run
[40957879377](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/40957879377):
all three jobs success.

- **App job** (typecheck, unit tests, build): success — 885 passed / 127 skipped
  (unchanged baseline; the new `.mjs` suites run only in the e2e job).
- **Database job** (clean install, RLS, finance, concurrency, upgrade, backup
  drill): success — same Phase 12 evidence (45 passed / 3 skipped, upgrade 3
  passed, drill PASS).
- **New `supabase-e2e` job** (disposable stack): success.
  `supabase start` boots real PostgreSQL + GoTrue + PostgREST (+ Inbucket mail
  catcher) on the runner with all 28 project migrations applied by the CLI
  itself; the app is built in production mode against the stack URL/anon key,
  served via `vite preview`, then both suites run with zero route
  interception, and `supabase stop` tears the stack down.

Genuinely running: GoTrue, PostgREST, PostgreSQL with the real migration
chain, the production build, real Chromium. Remaining mocked: nothing in this
phase's new suites; Phase 11's 60/60 stubbed journeys are kept as a separate
fast regression suite (`npm run test:e2e:signed-in`, unchanged).

Safety: every script refuses non-loopback URLs (exit 2), so the hosted demo
project can never be used as a test target. Keys are masked in CI logs and
never committed.

## API results — PHASE13-API: 32 passed, 0 failed

Against real GoTrue + PostgREST + RLS:

- Signup creates a user; duplicate signup issues no new session.
- Wrong password rejected (`invalid login credentials`); admin confirmation
  path works; signin returns a session; `getUser` matches; token refresh works.
- Password-recovery request and staff invitation accepted (mail catcher).
- Real company registration accepted; snapshot shows the membership as
  NOT approved (pending review, never implied approved).
- Company-A/B isolation over HTTP both directions (own booking visible,
  other's count 0, cross-company booking `not_a_member`); `seats_booked`
  verified in the database (2 bookings).
- Anonymous booking denied; signed-out caller gets no membership data.
- Customer denied sailing-readiness/tariff writes; ops write succeeds.
- Server pricing SAR 500/leg, VAT not configured; fresh manifest honestly
  empty; suspended account blocked (`profile_suspended`).
- Charter submitted, approved by ops, conflicting allocation rejected
  (`vessel_conflict`).

## Browser results — PHASE13-BROWSER: 14 passed, 0 failed

Real Chromium against the production build, no interception, clean console on
every journey:

- Booker-A signs in through the real UI; corporate shows own reference, hides
  the other company's; session persists across reload; Arabic toggles RTL;
  sign-out returns to sign-in and corporate shows no booking data.
- Customer refused at `/operations` (`#no-access`, no vessel form).
- Ops opens `/admin/operations`, creates a vessel through the real UI + API.

## Defects found and fixed (evidence-driven)

1. Both scripts shadowed the global `URL` constructor (`const URL = ...`
   then `new URL(URL)`), so the loopback guard always refused. Renamed to
   `SUPABASE_URL` + `new globalThis.URL(...)`. Guard verified locally:
   accepts `http://127.0.0.1:31740`, refuses the hosted project URL.
2. Fixtures fetched terms via service_role, which is revoked on
   `service_policies` — the terms query returned nothing and PostgREST
   reported PGRST202. Now fetched as the signed-in user, mirroring
   `phase8Service.ts` (also fixed the same way in the browser fixtures).
3. Ops journey asserted the vessel form on the default `sailings` tab; now
   selects the vessels tab first. Earlier CI-only workflow issues (status key
   names, `--env` flag form, quote stripping, env passing via inherited shell
   environment) were fixed from runner-log evidence.

## Remaining gaps (not claimed)

- Expired-session handling is covered only by sign-out revocation, not by a
  forcibly expired token.
- Browser personas cover booker/admin/customer/ops; pending-member and
  second-booker browser paths remain stubbed-only (covered at API level for
  registration/isolation).
- No concurrent-overbooking run over HTTP (covered at SQL level in Phase 8).
- Standing ATCO gates unchanged: tariff/VAT approval, live payments, port
  clearance, hosting/PITR proof, physical devices, legal approval.
