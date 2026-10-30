# Phase 16 — remaining P0 authentication and booking gaps

Branch: `feature/phase16-auth-booking-remaining-gaps` (from Phase 15 tip `de51def`).
Hosted `GulfMover-Demo` untouched. No live payments, no external notifications.
Old repository preserved; work pushed to `Zayn-Studio-Designs/GulfMoverMockApp-New`.

## What actually ran (no mocks)

CI run
[41033616382](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/41033616382):
all three jobs success (the Database job needed one rerun of its failed jobs:
the backup-drill step hit a transient runner port conflict,
`127.0.0.1:54324 address already in use`, docker exit 125, twice across runs;
the rerun passed unchanged — no product code was touched for it).

- **App job** (typecheck, unit tests, build): success — 885 passed / 127 skipped
  (unchanged baseline, verified locally too).
- **Database job** (clean install, RLS, finance, concurrency, upgrade, backup
  drill): success — Phase 12 evidence intact (45 passed / 3 skipped, upgrade
  3/3, drill PASS on rerun).
- **`supabase-e2e` job** (disposable stack): success. `supabase start` boots
  real PostgreSQL + GoTrue + PostgREST (+ Mailpit) with all 28 migrations;
  the production build is served via `vite preview`; Phase 13 suites (32/32
  API, 14/14 browser), Phase 14 suites (18/18 API, 13/13 browser) and Phase 15
  suites (45/45 email/invite, 61/61 lifecycle/roles) rerun green, then the two
  new Phase 16 suites run with zero route interception, and `supabase stop`
  tears the stack down.

Genuinely running: GoTrue, PostgREST, PostgreSQL with the real migration
chain, Mailpit, the production build, real Chromium. Mocked: nothing in the
new suites; Phase 11's 60/60 stubbed journeys remain a separate fast suite.

Safety: every new script refuses non-loopback URLs (exit 2, verified locally:
missing env refused, hosted `*.supabase.co` refused, non-loopback mail URL
refused). Keys are `::add-mask::`-masked; `supabase start` output stays
JWT-redacted — the full run log contains exactly one `eyJ` occurrence, which
is the `redact()` function definition itself, not a token.

## Booking verification — PHASE16-BOOKING-VERIFY: 36 passed, 0 failed

Against real GoTrue + PostgREST + RLS:

- Server quote returns a fixture tariff (unit > 0, SAR, explicit VAT mode —
  labelled a fixture, not an ATCO price); the created booking's
  net/vat/total exactly equal the server quote; the `created` audit event
  records the same total + tariff id.
- Tamper-proofing: the booking RPCs accept no amount/total parameter, and a
  direct `UPDATE bookings SET total_halala=1` is denied (no UPDATE policy);
  the stored total is unchanged afterwards.
- Seats move exactly with bookings (+2 on create); sequential same-key replay
  returns the same booking with outcome `replayed` and no double-count;
  same key with changed payload is rejected (`payload_mismatch`).
- Unknown sailing rejected (`sailing_unavailable`), seat counts untouched,
  retry with a valid sailing succeeds (error recovery, no phantom state).
- Sailing fills exactly to capacity; overbooking rejected (`sailing_full`);
  seats never exceed capacity; a booking whose return leg is full is rejected
  (`sailing_full`).
- Fresh sailing: `ticket_manifest` is an honest empty array and the summary
  shows 0 seats/tickets with a non-open gate; anonymous manifest read denied;
  company-admin (non-staff) manifest read denied (`not authorized` — staff
  roles only, new vs Phase 15's customer denial).
- Boarding gate fails closed on a cancelled sailing (`sailing_cancelled`).
  A `suspended` gate is not exercisable: `sailings_status_check` allows only
  open/closed/cancelled, so the `sailing_suspended` branch is unreachable
  until the enum changes (documented, not faked).
- Hold lifecycle: pay_now bookings carry a ~30 min future hold (provisional
  setting, not an ATCO rule); customers cannot run `expire_stale_holds`;
  after the hold is forced past-expiry (test-only clock move via service_role
  update), operations expiry returns ≥1, the booking becomes `expired`, seats
  are released, tickets cancelled, an `expired` audit event is written, and
  amend-after-expiry is rejected (`invalid_transition`).

## Roles, redirects, lifecycle edges — PHASE16-ROLES-REDIRECTS: 43 passed, 0 failed

- Redirects: allow-listed signup redirect accepted. Unapproved redirects are
  NOT rejected by GoTrue on this stack (observed, runs 41033224525 and
  41033616382) — the suite therefore asserts the secure property: the
  emitted confirmation/recovery emails contain no `evil.example.test` host.
  Both pass via the not-honored path; honoring would fail as an open-redirect
  finding. Production Auth redirect hardening (exact allow-list, custom
  domain) remains a hosted-configuration gate (§5), not a code claim.
- Link expiry: garbage `verifyOtp` token rejected; GoThree invite link works
  once, replay rejected (single-use), invitee sets password and signs in;
  `otp_expiry` is the documented 3600 s from `supabase/config.toml`. True
  time-based expiry (waiting out 1 h) is not exercised.
- Pending/suspended: pending member registers (unapproved) but cannot amend
  company bookings; suspended users still get a GoTrue session yet cannot
  create bookings (`profile_suspended`) while keeping read access to their own
  bookings (writes blocked, reads preserved).
- Booker-vs-admin over REST: booker sees exactly their own booking (1 row);
  company admin sees both company bookings (RLS `bookings_select_relevant`).
- Role matrix (from RLS/RPC guards, not invented): finance publishes tariff
  (control); boarding/company-admin cannot; finance cannot set readiness;
  operations can (control); operations cannot approve tariffs; anonymous
  manifest read denied.
- Real Chromium (no interception): admin corporate view shows their own
  booking, hides the booker's, and shows the company account report
  (`#ca-from`); booker view shows their own booking, hides the admin's, and
  shows the admin-only notice instead of the report; customer view shows the
  no-company guidance plus the registration link. All three journeys have
  clean consoles.

## Defects found and fixed (evidence-driven)

1. The booking-row select included `bookings.currency`, which does not exist
   — PostgREST 400 nulled the row and failed the totals checks. Removed it
   (SAR is asserted on the server quote); the row now asserts VAT-mode
   agreement with the tariff instead.
2. Unapproved `redirect_to` is accepted by GoTrue instead of erroring, so the
   suite asserts non-honoring in the emitted email rather than API rejection.
3. The backup-drill step flaked twice with a runner port conflict
   (`54324 address already in use`, docker 125); rerunning the failed job
   passed unchanged. No product change; consider a retry or free-port probe
   for the drill script.

## Remaining gaps and blockers (not claimed)

- Email-link expiry beyond replay/single-use is bounded by the 1 h OTP
  window; only config value + single-use + garbage rejection are evidenced.
- Production redirect allow-list, custom domain, and SMTP belong to hosted
  configuration (§5), not this disposable stack.
- The `sailing_suspended` gate branch is unreachable under the current status
  enum; if ATCO requires a suspend state, the enum + gate need a decision.
- Refund approval still blocked on the ATCO refund policy
  (`refund_policy_not_approved`); live payments stay disabled (D13).
- The Google-Doc Full Completion Checklist was audited from its export but
  checkboxes were not ticked from here; §3 items above have their evidence in
  this report and run 41033616382.
- Standing ATCO gates unchanged: tariffs/VAT approval, live payments, port
  clearance procedure, hosting/PITR proof, physical devices, legal approval.
