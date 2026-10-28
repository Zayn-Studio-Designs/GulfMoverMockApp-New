# Phase 10 verification results (2026-10-28)

Branch: `feature/phase10-launch-hardening` @ this checkout (from `cd18033`).
Environment: Node v26.7.0 / npm 11.19.0 (project recommends 22/24 LTS —
recorded, not blocking). Production `.env.local` present and ignored.

## Commands (bare `npm test`, no overrides — hermetic since the setup fix)

- `npm run typecheck` → exit 0, no errors.
- `npm test` → **868 passed, 119 skipped, 0 failed** (34 files; exit 0).
  The 119 skips are the local-stack integration/db suites, which skip when
  `GM_IT_*` is unset — verified in `helpers.ts`/`src/tests/db/*.test.ts`.
- `npm run build` → exit 0 (pre-existing >500 kB chunk warning only).
- `git diff --check` → clean.
- `npm run check:env -- development` → pass. `staging`/`production` need
  real deployment values unavailable here — not executed (documented, the
  script never prints values).
- `test:integration`, `test:db`, `test:e2e:local` → blocked: no Docker, no
  local Supabase stack, no Mailpit. No hosted mutation substituted.

## What the new tests prove

- `securityGrants.test.ts` (2 tests): every `public._*` helper is revoked
  from public/anon/authenticated across all 28 migration sources. Failed
  before the Phase 10 migration (3 gaps), passes after.
- `paymentSafety.test.ts` (5 tests): server-priced checkout, browser sends
  identity only, provider-result RPCs are service-role-only, live
  kill-switch present, verification/refunds staff-gated.
- `corporateWorkspace.test.tsx` (4 tests): no-company → registration
  guidance; booker → own bookings, no admin report; admin → account report;
  `/corporate|/operations|/fleet` no longer `NotConnectedView`.
- `phase3Production.test.tsx` updated (30 tests): the old
  “not connected” expectation replaced with connected-screen assertions
  for the three rewired routes. This was an intended behavior change, not
  a weakened assertion — demo-mode pages are untouched.

## Browser / hosted verification in this phase

- Hosted inspection was read-only (advisor findings, migration ledger,
  parity check: 27/27 repo migrations applied + 1 hosted-only pin).
- No browser journeys were run in Phase 10 (no preview server started;
  production-mode browser pass of the three rewired routes is the
  explicitly listed remaining item). Phase 9.3 EN/AR browser checks stand.
- The new migration (`20261102000000_phase10_security_hardening.sql`) is
  source-only and unapplied anywhere; it must ride the normal release
  migration path with a hosted advisor re-check afterwards.

## Honest limitations

- DB integration, migration-apply, backup drill, and Playwright e2e suites
  did not run (no local stack). All authorization claims beyond unit/source
  level rest on Phase 6/7 local-stack evidence, not re-runs.
- No CI run, no hosted staging deploy, no device testing, no external
  provider verification. Live payments and notifications remain disabled.
