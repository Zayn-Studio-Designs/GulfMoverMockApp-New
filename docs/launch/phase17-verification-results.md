# Phase 17 — remaining Section 3 expiry and edge-case gaps

Branch: `feature/phase17-real-expiry-edge-cases` (from Phase 16 tip `3a1df1f`).
Hosted `GulfMover-Demo` untouched. No live payments, no external notifications.
Old repository preserved; work pushed to `Zayn-Studio-Designs/GulfMoverMockApp-New`.

## What actually ran (no mocks)

CI run
[41094530454](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/41094530454):
all three jobs success on the first try of commit `1971d2c`
(App: typecheck/unit/build; Database: clean install, RLS, finance,
concurrency, upgrade, backup drill; `supabase-e2e`: disposable stack with all
28 migrations, production build via `vite preview`, real Chromium, zero route
interception). Phase 13 (32/32 API, 14/14 browser), Phase 14 (18/18 API,
13/13 browser), Phase 15 (45/45 email/invite, 61/61 lifecycle/roles) and
Phase 16 (36/36 booking, 43/43 roles) suites reran green, then the two new
Phase 17 suites ran and `supabase stop` tore the stack down.

Genuinely running: GoTrue, PostgREST, PostgreSQL with the real migration
chain, Mailpit, the production build, real Chromium. Mocked: nothing in the
new suites.

Safety: both new scripts refuse non-loopback URLs (exit 2, verified locally:
missing env refused, hosted `*.supabase.co` refused, and the expiry script
additionally refuses to run its wait against the default 3600s config rather
than false-pass). Keys are `::add-mask::`-masked; both `supabase start`
outputs stay JWT-redacted — the full run log contains exactly two `eyJ`
occurrences, both the `redact()` function definitions, not tokens. The local
working-tree `supabase/config.toml` still pins `otp_expiry = 3600`; the
accelerated value existed only inside the ephemeral CI runner and was
restored before teardown.

## Real email-link expiry — PHASE17B-EXPIRY: 16 passed, 0 failed

The default stack configures `otp_expiry = 3600` (1h); waiting out a full hour
in CI is impractical, so CI restarted the disposable stack with an
accelerated `otp_expiry = 60` and the suite proved REAL GoTrue time-based
enforcement:

- Fresh signup link verified immediately: accepted (control).
- Aged signup link verified after a 150s wait: rejected by GoTrue with
  `Email link is invalid or has expired` / code `otp_expired` — the genuine
  time-based error, not a generic invalid-token message.
- Aged recovery link verified after the same wait: rejected with the same
  genuine `otp_expired` error.
- Fresh signup performed AFTER the wait and verified immediately: accepted.
  Aged-rejected + fresh-accepted under the SAME running GoTrue is the
  differential proof that the rejection is time-based, not systemic.
- Single-use and garbage-token rejections hold under the short config.

Honesty note: a full 3,600-second delay was NOT exercised. The evidence is an
accelerated-configuration proof of the real enforcement path, with the
default 3600s value evidenced from the committed `supabase/config.toml`.
The suite reads that file and aborts (exit 1) instead of running if the
configured window ever exceeds the wait, so it cannot silently false-pass.

## Suspended gate + retry/error edges — PHASE17A-SUSPENDED-RETRY: 27 passed, 0 failed

- CORRECTION to the Phase 16 report: `sailing_suspended` is REACHABLE.
  Migration `20261101100001` added `'suspended'` to `sailings_status_check`,
  `suspend_sailing()` sets it, `sailing_boarding_gate()` returns
  `'sailing_suspended'`, and `board_ticket()` fails closed on it. All proven
  over real RPCs: suspend returns `suspended`, status persists, a suspension
  checkpoint event is written, the gate returns `sailing_suspended`, boarding
  a valid paid ticket returns `sailing_suspended` with the ticket left
  `valid` and zero boarding events, customers cannot suspend, repeat suspend
  is idempotent (`unchanged`), resume returns `resumed` and the gate leaves
  the suspended state.
- Retry/error edges: sign-in before confirmation is rejected with no session,
  then the emailed link confirms and sign-in works (interrupted-flow
  recovery); truncated confirmation tokens are rejected and create no usable
  identity; a signup token presented as `recovery` is rejected (type
  confusion); garbage recovery tokens are rejected; resume on an open sailing
  fails loudly with `invalid_transition` (no fake `resumed`).

## Defects found and fixed (evidence-driven)

Run `41093719935` failed the new 17a suite; the logs showed precise causes,
fixed in commit `1971d2c`, green on rerun `41094530454`:

1. `p_request_key` must be a UUID (`sus-…` rejected with 22P02) — now
   `randomUUID()`; the downstream payment/booking failures were cascading
   from this single fixture bug.
2. Audit tables (`sailing_checkpoint_events`, `boarding_events`) revoke
   `service_role` and grant staff-only select to `authenticated` — the suite
   now reads them as the operations user instead of the admin client.
3. The config-restore CI step now tolerates a never-restarted stack instead
   of failing when no backup exists.

## Remaining gaps and blockers (not claimed)

- A full 3,600-second expiry delay was not exercised; the time-based proof is
  accelerated (60s window, 150s wait, genuine `otp_expired`). If a reviewer
  requires the literal one-hour observation, that remains open.
- Password-change still does not revoke pre-change refresh tokens in GoTrue;
  explicit global sign-out remains the tested revocation path (Phase 15).
- Production redirect allow-list, custom domain, and SMTP belong to hosted
  configuration (§5), not this disposable stack.
- Refund approval still blocked on the ATCO refund policy; live payments stay
  disabled. Tariff/VAT approval, port clearance, hosting/PITR proof, physical
  devices, and legal approval remain standing ATCO gates.
- The Google-Doc Full Completion Checklist was audited from its export but no
  boxes were ticked from here.

## Section 3 status (evidence, not a checkbox edit)

- *"Verify real booking creation … and the fail-closed boarding gate on the
  real stack"* — fully evidenced across Phases 13–16 plus the Phase 17 proof
  that the suspended gate is reachable and fails closed. Open only where an
  ATCO business rule is the blocker (tariff/VAT values, refund policy).
- *"Expand the real-auth/browser suite … holds/expiry and retry/error
  states"* — covered: signup/recovery completion through captured mail,
  pending/suspended guards, invitation lifecycle, amendments/cancellations/
  rescheduling, hold expiry, and now real `otp_expired` time-based expiry
  (accelerated), type-confusion/truncation/interrupted-flow edges, and the
  suspend/resume lifecycle. The literal one-hour wait is the only
  still-unexercised technical sliver.

Test counts: Phase 17a 27/27, Phase 17b 16/16. Preserved: P13 (32+14),
P14 (18+13), P15 (45+61), P16 (36+43); app/typecheck/build and database
(45 passed / 3 skipped, upgrade 3/3) green in the same run.
Final state: branch `feature/phase17-real-expiry-edge-cases`, CI run
`41094530454` all-green. No merges, no force-push, demo and old repo
untouched.
