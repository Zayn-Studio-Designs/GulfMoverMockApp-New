# Phase 14 — real-auth gaps, pending/second-booker browser paths, HTTP concurrency

Branch: `feature/phase14-real-auth-gaps` (from Phase 13 tip `2b9f0fe`).
Hosted `GulfMover-Demo` untouched. No live payments, no notifications sent.
Old repository preserved; work pushed to `Zayn-Studio-Designs/GulfMoverMockApp-New`.

## What actually ran (no mocks)

CI run
[40964057939](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/40964057939):
all three jobs success.

- **App job** (typecheck, unit tests, build): success — 885 passed / 127 skipped
  (unchanged baseline, verified locally too).
- **Database job** (clean install, RLS, finance, concurrency, upgrade, backup
  drill): success — same Phase 12 evidence (45 passed / 3 skipped, upgrade 3
  passed, drill PASS).
- **`supabase-e2e` job** (disposable stack): success. `supabase start` boots
  real PostgreSQL + GoTrue + PostgREST (+ Inbucket) with all 28 migrations;
  the production build is served via `vite preview`; Phase 13 suites rerun
  green (32/32 API, 14/14 browser), then the two new Phase 14 suites run with
  zero route interception, and `supabase stop` tears the stack down.

Genuinely running: GoTrue, PostgREST, PostgreSQL with the real migration
chain, the production build, real Chromium. Mocked: nothing in the new
suites; Phase 11's 60/60 stubbed journeys remain a separate fast suite.

Safety: every new script refuses non-loopback URLs (exit 2, verified locally:
missing env refused, hosted `*.supabase.co` refused, loopback accepted).
Keys are `::add-mask::`-masked; `supabase start` output is now captured and
shown only as a JWT-redacted tail — the run log contains zero `eyJ…` tokens
in the startup section (checked).

## API gaps — PHASE14-API-GAPS: 17 passed, 0 failed

Against real GoTrue + PostgREST + RLS:

- Expired/invalid sessions: tampered access token rejected; garbage token
  rejected; invalid refresh token rejected; expired access + bad refresh
  yields no usable session (setSession fails or the follow-up call is
  denied/empty). Valid-token `getUser` control passes.
- Pending guards: registration accepted and visible but NOT approved;
  booking against the unapproved org is denied over HTTP.
- HTTP concurrency: 6 simultaneous 1-seat bookings against 3 seats → exactly
  3 succeed, all 3 losers rejected with `sailing_full`; `seats_booked` = 3
  and never exceeds capacity (verified in the DB). Concurrent same-key replay
  returns the same booking id and increments seats exactly once (2).

## Browser gaps — PHASE14-BROWSER-GAPS: 13 passed, 0 failed

Real Chromium against the production build, no interception, clean console:

- Pending member signs in through the real UI → `/corporate` shows
  "Awaiting ATCO approval", exposes no booking references and no bookings
  section; `/onboarding` shows the pending status.
- Second booker (same company as the first) signs in → corporate shows only
  their own reference, hides the first booker's and the other company's;
  isolation holds after reload; sign-out returns to sign-in and corporate
  shows no booking data.

## Defects found and fixed (evidence-driven)

1. Fixture sailings reused one `(vessel, departs_at)` → `23505` on
   `sailings_vessel_departure_uniq`. Each sailing now gets a distinct
   departure (+15 min steps). Real schema behaviour, not a test artifact.
2. Bare `.data.id` chains hid the database error (`FATAL … reading 'id'`).
   Fixture inserts now throw the statement name plus the PostgREST error.
3. Control-signin failure path exited via TypeError; now aborts with a
   labelled summary line.

## Remaining gaps (not claimed)

- Full email-link/password-reset completion through captured test mail and
  invitation acceptance/revocation remain untested (request/invite accepted
  only).
- Booking amendments/cancellations/rescheduling, holds/expiry and retry/error
  states over the real stack remain open (Phase 11 stubbed-only).
- Full administrator-role matrix beyond company-admin/booker still needs
  explicit evidence where in scope.
- Standing ATCO gates unchanged: tariff/VAT approval, live payments, port
  clearance, hosting/PITR proof, physical devices, legal approval.
- The Google-Doc Full Completion Checklist (§3/§4) still needs its checkboxes
  ticked against this run — Docs write access is not available from here.
