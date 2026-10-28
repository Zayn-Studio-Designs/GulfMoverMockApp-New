# Phase 10 baseline (verified 2026-10-28)

Branch: `feature/phase10-launch-hardening` (new, from `cd18033` =
`origin/feature/phase9.3-ui-sandbox-clarity`; `git fetch` shows no newer
remote work). Working tree was clean at branch creation.
Repo: `TOPZEDE/GulfMoverMockApp`. Hosted project `GulfMover-Demo`
(`kidcqtcggzfvkhskqyqf`, ap-southeast-1) inspected read-only only.

Toolchain in this environment: Node v26.7.0, npm 11.19.0 (project docs
recommend Node 22/24 LTS; v26 is newer than recommended — tests/build pass,
but release CI should pin the LTS). No Docker daemon, so no local Supabase
stack (`supabase start` unavailable); `psql` exists but there is no
PostgREST/Auth/Mailpit, so DB-backed suites cannot run here.

## Command results (this checkout, unmodified code)

- `npm run typecheck` → PASS (exit 0).
- `npm test` (bare, with ignored production `.env.local` present) →
  10 files / 79 tests FAIL, 773 pass, 119 skipped. Root cause: the
  unit/component suite assumes demo mode, but vitest picks up
  `VITE_APP_MODE=production` from the developer's ignored `.env.local`.
  This is a real hermeticity defect (Phase 10 fix: pin demo mode in
  `src/tests/setup.ts`; production paths are covered by tests that inject
  `EnvSource` explicitly or `vi.stubEnv` per test).
- `VITE_APP_MODE=demo VITE_AUTH_RESET_REDIRECT_URL= npm test` →
  **852 passed, 119 skipped, 0 failed** (matches the Phase 9.3 report).
  The 119 skips are the local-stack integration/db suites, which skip when
  `GM_IT_*` is unset — verified in `helpers.ts` (`localStackConfigured`)
  and `src/tests/db/*.test.ts` (`describe.skip` when unconfigured).
- `npm run build` → PASS (pre-existing >500 kB chunk-size warning only).
- `git diff --check` → clean.
- `npm run check:env -- development` → pass. `staging`/`production`
  require real deployment values (Supabase URL/anon key/reset URL, plus
  edge-function secrets with `--functions`); not available in this
  environment, so release-env validation is documented, not executed.
  Note: `check-env.mjs` exits 1 on errors — callers must not pipe it
  through `tail` without `PIPESTATUS` (earlier misleading `EXIT:0`
  readings came from the pipe).
- `npm run test:integration`, `test:db`, `test:e2e:local` → blocked here:
  all require `supabase start` + Mailpit + `GM_IT_*` loopback wiring.
  No hosted mutation is an acceptable substitute (explicitly forbidden).

## Production route inventory (source: `src/App.tsx` + page inspection)

| Route / workflow | Implementation | Real backend? | Status |
|---|---|---|---|
| `/signin`, `/signup`, `/auth/reset-callback` | AuthView/PasswordRecoveryView | Yes (Supabase Auth) | Implemented and verified |
| `/onboarding` (+ `/` in production) | OnboardingView (`register_company` RPC) | Yes | Implemented and verified |
| `/book` | ProductionBookingView | Yes (tariff/sailing/booking RPCs) | Implemented and verified |
| `/bookings`, `/bookings/:ref` | ProductionBookingsView + BookingCommerce | Yes | Implemented and verified |
| `/boarding`, `/admin/boarding` | ProductionBoardingView | Yes (`board_ticket`, readiness gates) | Implemented and verified |
| `/materials`, `/charters`, `/admin/materials`, `/admin/charters` | TransferRequestsView | Yes | Implemented and verified |
| `/company/members` | CompanyMembersView | Yes (invitation lifecycle RPCs) | Implemented and verified |
| `/admin/companies` | AdminCompaniesView | Yes (review RPCs, super_admin only) | Implemented and verified |
| `/admin/operations` | AdminOperationsView | Yes (vessels/routes/sailings, ops roles) | Implemented and verified |
| `/admin/sailings` | SailingControlView | Yes (checkpoints via phase8Service) | Implemented and verified |
| `/admin/finance` | FinanceView | Yes (phase8Service) | Implemented, incompletely verified |
| `/admin/reports` | ReportsView | Yes (`runReport`) | Implemented, incompletely verified |
| `/admin/system` | SystemView | Yes (diagnostics, privacy, settings) | Implemented, incompletely verified |
| `/account` | AccountPrivacyView | Yes (export/retention/consent) | Implemented, incompletely verified |
| `/company/account` | CompanyReportsView | Yes (org-scoped reports/invoices) | Implemented, incompletely verified |
| `/invoices/:id` | InvoiceView | Yes | Implemented and verified |
| `/notifications` | NotificationsView (in-app only) | Partial (outbox; external delivery needs provider + edge deploy) | Partially connected |
| `/corporate` (production) | `NotConnectedView` | No | **Not connected — Phase 10 fix** |
| `/operations` (production) | `NotConnectedView` | No | **Not connected — Phase 10 fix** |
| `/fleet` (production) | `NotConnectedView` | No | **Not connected — Phase 10 fix** |

Production nav (`PRODUCTION_CUSTOMER_NAV` / `PRODUCTION_STAFF_NAV`) never
links to `/corporate`, `/operations`, `/fleet`, so these are deep-link-only
dead ends today. Demo mode is unaffected (demo pages intact).

## Database / security posture (read-only hosted inspection)

- Hosted migration ledger: 28 rows = all 27 repo migrations
  (`20261026144000`…`20261101100005`) plus hosted-only
  `20261028161448_pin_trigger_search_paths` (equivalent state reproducible
  from repo sources; no source migration needed).
- Advisor: 2 INFO (`document_counters`, `notification_outbox` RLS with no
  policy — intentional deny-by-default, server-only tables), 1 anon WARN
  (`health_ping()` — intentional public liveness probe, asserted by
  `src/tests/db/phase8.operations.db.test.ts:258,268` as the *only*
  anon-callable function), ~110 authenticated WARNs. The WARNs are generic
  linter noise: the codebase pattern is `revoke … from public, anon,
  service_role` + narrow `grant … to authenticated`, and every sensitive
  mutating RPC re-checks `auth.uid()` / platform roles / ownership inside
  the function body (evidence in `security-rpc-matrix.md`).
- One genuine anomaly: `public._reserve_booking_terms(boolean, text)` is
  revoked from `public, anon, service_role` but **not** from
  `authenticated`, while every other `_*` internal helper revokes all four.
  It is read-only and the frontend never calls it directly, so severity is
  low — but it violates least privilege and the `_`-internal convention.
  Phase 10 fix: forward-only migration revoking `authenticated`, plus a
  source-level regression test covering all `_*` functions.

## Blockers that engineering alone cannot clear

- No local Supabase stack (no Docker) → DB integration, migration-apply,
  backup-restore drill, and Playwright e2e suites cannot run here.
- Hosted staging actions (edge-function deploy, Auth redirect allowlist,
  leaked-password protection toggle, payment/notification provider keys)
  require authorised dashboard access — read-only inspection only.
- ATCO commercial/legal decisions (tariff, VAT, refund policy, permits,
  commissions, credit terms) remain provisional — see
  `docs/launch/atco-decisions-required.md`.
