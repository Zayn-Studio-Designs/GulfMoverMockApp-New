# Phase 10.1 verification closure (2026-10-28)

Branch: `feature/phase10.1-verification-closure` (from Phase 10 `ea2ff5b`).
Runtime: Node v26.7.0 / npm 11.19.0. No Docker → no local Supabase stack;
all database-backed checks below are source-level or explicitly skipped.

## Task 1 — grant regression test hardened (done)

`src/tests/securityGrants.test.ts` was rewritten around the exact weakness
named in the task: the old parser accumulated REVOKEs but could never see
GRANTs (its statement regex required `FROM`; GRANT uses `TO` — demonstrated
with a failing-vs-passing regex probe). The new test:

- processes migrations in chronological filename order, strips line/block
  comments first (grants inside comments are ignored — tested);
- replays GRANT/REVOKE events per function (grants add, revokes remove),
  seeded with every defined `_*` helper at the PostgreSQL default
  (executable-by-PUBLIC), so a helper with no statements at all is exposed;
- resolves static `foreach … array[…] … execute format('grant|revoke …')`
  loops when the array is literal and skips them only when provably free of
  `_*` names; anything unresolvable is reported, not assumed safe;
- fails loudly on `ALTER DEFAULT PRIVILEGES` (unused today; unmodelled);
- documents its limits: not a proof of the live ACL — the catalog check on
  a live stack (`phase10.helper-grants.db.test.ts`) is the authority.

Proven by synthetic fixtures: a later GRANT after an earlier REVOKE is now
detected (fails before the TO/FROM fix, passes after); staged multi-role
revokes, late-introduced helpers, and comment-embedded grants are covered.
4/4 pass; the real 28-migration audit is clean.

## Task 2 — migration audit (source done; catalog run blocked)

`20261102000000_phase10_security_hardening.sql` re-verified:

- `_reserve_booking_terms(boolean, text)`: revoked from `authenticated`.
  Stronger than previously stated — it is currently **dead code**: no other
  migration calls it (booking engines inline the terms check). No legitimate
  caller can break.
- `_riyadh_date(timestamptz)`: called only inside SECURITY DEFINER report
  functions (owner context); the revoke does not change their behaviour.
- `_zatca_initial_pih()`: called only by `_last_document_hash`, itself fully
  revoked from all client roles; owner-context chain intact.
- All three signatures match their definitions exactly.

New `src/tests/db/phase10.helper-grants.db.test.ts` asserts via
`has_function_privilege('anon'/'authenticated', …)` that none of the three
is executable, that `asAnon` calls fail, and that the server-side paths
still work (staff report → invoices issued → `_last_document_hash`
returns). It **skips without a local stack** (2 skipped here) — the catalog
proof, the migration-apply run, the upgrade/backup drills, and the full
DB suite re-run remain explicitly blocked on Docker/a stack. The migration
is source-only and unapplied anywhere, including hosted.

Hosted advisor re-read (read-only, 18:28 UTC): unchanged posture — 2 INFO
(RLS-no-policy tables, intentional), 1 anon WARN (`health_ping`, intentional),
~110 authenticated WARNs including the still-present `_reserve_booking_terms`
finding, **expected** since the migration has not been applied to hosted
(no hosted changes permitted in this task).

## Task 3 — corporate workspace states (done, tested)

`CorporateWorkspaceView` was rewritten to branch on the full
`deriveOnboardingState` union instead of inferring from membership counts:
loading / signed-out / error (with retry) / account-suspended / no-company
(only state linking to register) / pending / rejected / suspended /
restricted / invited / platform-staff / approved (admin vs booker, plus a
multi-company list; bookings stay caller-own). Reuses existing onboarding
copy keys; one new key (`p8CorpMultiOrg`, EN+AR). 9 tests incl. Arabic RTL
and raw-key scan; no registration-rule changes.

## Task 4 — routes (done, tested)

- `/corporate` → `CorporateWorkspaceView` (in production customer nav).
- `/operations` → `Navigate` to canonical `/admin/operations`;
  `/fleet` → `Navigate` to canonical `/admin/sailings`. Both canonical pages
  are in the production staff nav; the short paths were undiscoverable
  duplicates, so they are now documented aliases, not second screens.
- New `rewiredRoutes.test.tsx` (4 tests): customers refused on both aliases
  (ProductionUi guard on operations; StaffKit guard on fleet — different
  refusal text, both asserted), staff served, no control actions leak.
  Noted: SailingControlView's loaders fire before its guard; RLS (not the
  UI) protects those rows — same posture as the rest of the app.
- No live browser run (no preview server started); isolated MemoryRouter
  journeys are the evidence. Deep-link/refresh semantics follow
  react-router `replace` navigation; device/AR-camera checks outstanding.

## Task 5 — release re-check (done)

- `securityGrants` + `paymentSafety` + workspace + route tests green; no
  test weakened (one stale expectation updated to the new intended
  redirect behaviour, documented in the test).
- Secret scan: only safeguard *references* (`sb_secret_`/`sk_test_`
  patterns in validators and docs), zero values in source, scripts, env
  example, or staged files. Live payments/notifications still disabled;
  no demo-fallback change in production paths.

## Task 6 — verification (this checkout)

- `npm run typecheck` → exit 0.
- `npm test` → **880 passed, 121 skipped, 0 failed** (exit 0). Skips: 119
  pre-existing environment-gated integration/db suites + 2 new catalog
  tests (no stack).
- `npm run build` → exit 0. `git diff --check` → clean.
- `check:env -- development` → pass (unchanged; staging/production need
  real deployment values).
- Blocked: `test:integration`, `test:db`, `test:e2e:local` (no Docker);
  hosted catalog run of the new migration; physical devices.

## Remaining for the next phase

1. A stack (Docker or authorized staging): apply migrations 1→28+Phase-10,
   run the catalog test for real, re-run the full DB/e2e suites.
2. Production-mode browser pass of `/corporate` + the two aliases.
3. Hosted: apply the Phase 10 migration through the release path, re-read
   the advisor, confirm the `_reserve_booking_terms` WARN clears.
4. ATCO decisions D1–D17 and device testing (unchanged).
