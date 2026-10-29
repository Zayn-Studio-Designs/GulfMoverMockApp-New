# Phase 15 — email/invitation lifecycle, booking lifecycle, role matrix

Branch: `feature/phase15-auth-booking-lifecycle` (from Phase 14 tip `8021e0d`).
Hosted `GulfMover-Demo` untouched. No live payments, no external notifications.
Old repository preserved; work pushed to `Zayn-Studio-Designs/GulfMoverMockApp-New`.

## What actually ran (no mocks)

CI run
[40970874562](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/40970874562):
all three jobs success.

- **App job** (typecheck, unit tests, build): success — 885 passed / 127 skipped
  (unchanged baseline, verified locally too).
- **Database job** (clean install, RLS, finance, concurrency, upgrade, backup
  drill): success — Phase 12 evidence intact.
- **`supabase-e2e` job** (disposable stack): success. Real PostgreSQL + GoTrue
  + PostgREST + Mailpit with all 28 migrations; production build via
  `vite preview`; Phase 13 suites (32/32 API, 14/14 browser) and Phase 14
  suites (18/18 API, 13/13 browser) rerun green, then the two new Phase 15
  suites run with zero route interception; `supabase stop` tears down.

Genuinely running: GoTrue, PostgREST, PostgreSQL, Mailpit (the stack's mail
catcher — the script auto-detects Inbucket or Mailpit), production build,
real Chromium for the Phase 11/13/14 browser suites. Mocked: nothing in the
new suites. Safety: every new script refuses non-loopback URLs (exit 2);
loopback acceptance and hosted refusal verified locally.

## Email + invitation — PHASE15-EMAIL-INVITE: 45 passed, 0 failed

Against real GoTrue + captured Mailpit mail + RLS:

- Signup creates an unconfirmed user with no session; the captured
  confirmation email yields a signup link; verification activates the
  session; the user signs in; replay and garbage tokens rejected.
- Recovery email yields a recovery link; verification yields a session;
  password change works; old password rejected; new password signs in.
- Honest session finding (evidence, run 40969134223): GoTrue on this stack
  does NOT revoke pre-change refresh tokens on password update alone. The
  suite asserts the supported secure pattern instead: explicit global
  sign-out revokes every refresh token (pre-change and current), verified via
  refresh attempts. If ATCO requires automatic revocation on password change,
  that is a product decision, not current behavior.
- GoTrue invite email yields an invite link; invitee sets a password, signs
  in, and holds zero company memberships until granted.
- In-app invitations: idempotent invite (same id, case-insensitive),
  invitee-only RLS visibility, unrelated-user invisibility, non-admin and
  self-invite denial, accept → active company_booker, double-accept
  unchanged, cancel → recorded, double-cancel unchanged, accept-after-cancel
  and expired-invite rejected, unknown-id and cross-user accept fail, admin
  revokes to suspended, self-revoke blocked, and membership_events records
  invited/accepted/invitation_revoked/membership_revoked.

## Booking lifecycle + roles — PHASE15-LIFECYCLE-ROLES: 61 passed, 0 failed

- Amend: owner amend persists + audit event; invalid email rejected;
  cross-company denied; admin amends booker booking; paid booking locked.
- Cancel: owner cancel releases seats, voids tickets, writes the event;
  double-cancel unchanged; amend-after-cancel rejected; cross-company denied;
  customer cancel inside the 24h window rejected, operations override works.
- Reschedule: seat migration + ticket rotation + audit event verified in the
  DB; same-sailing unchanged; wrong-route and full-sailing rejected; customer
  24h window enforced; concurrent race onto a 1-seat sailing yields exactly
  one winner (`sailing_full` for the loser, seats == 1).
- Payments/refunds (sandbox only): payer initiates (mada) + simulates paid;
  finance opens a review; duplicate blocked; customer denied; decision
  asserted BLOCKED with `refund_policy_not_approved` — the ATCO refund-policy
  gate (D2/P30) is enforced by the database, not bypassed.
- Boarding (fail-closed, per checkpoint): unknown code → not_found; customer
  denied; gate refuses before master-go; refuses before port clearance;
  boards once open; repeat scan → already_boarded; owner-only QR
  (`GMT1:…`, cross-company denied); boarded booking cannot cancel.
- Role matrix: finance publishes tariff, operations cannot; publisher cannot
  self-approve (four-eyes), second finance approves; boarding staff cannot set
  readiness but reads the manifest (customer cannot); operations cancels an
  empty sailing (customer cannot) and it persists as cancelled.

## Defects found and fixed (evidence-driven)

1. Mail catcher parsing read `supabase status` pretty output, which has no
   `INBUCKET_URL` line — the URL lives in `status --env` (which also revealed
   the stack runs **Mailpit**). CI now exports the catcher URL from `--env`;
   the script auto-detects Inbucket or Mailpit APIs.
2. A helper rewrite dropped `extractVerifyToken` (FATAL); restored.
3. Recovery test grabbed the older signup email; the catcher now returns the
   newest email carrying the wanted link type.
4. Phase 14's tamper test flipped a base64 padding bit (decodes identically);
   it now flips a claim byte.
5. Sandbox payment used a phase-7-only method; the phase-8 API accepts card
   methods with sandbox simulation — suite uses `mada` + simulate.
6. Boarding tests assumed readiness alone opens the gate; the suite now pays
   the booking and opens master-go + port clearance step by step, proving the
   gate fails closed at each checkpoint.

## Remaining gaps and blockers (not claimed)

- Refund approval/decide is blocked on ATCO approving a refund policy
  (`refund_policy_not_approved`); live payments stay disabled (D13).
- Email-link expiry beyond replay (OTP `otq_expiry` 3600s) is not exercised;
  invitation expiry is covered at the in-app level only.
- The Google-Doc Full Completion Checklist could not be ticked from here
  (Drive export is read-only in this environment); §3/§4 items above have
  evidence in this report and run 40970874562.
- Standing ATCO gates unchanged: tariffs/VAT, live payments, port clearance
  procedure, hosting/PITR proof, physical devices, legal approval.
