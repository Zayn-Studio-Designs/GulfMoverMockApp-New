# Phase 10.2 verification results (2026-10-28)

Branch: `feature/phase10.2-ci-security-verification` (based on Phase 10.1 tip `2e280a5` + grant-hardening `7015d8c`).
App server used for browser pass: existing dev server on `http://127.0.0.1:3000` with `.env.local` `VITE_APP_MODE=production` (untouched, uncommitted).

## 1. Security grant regression test (Task 2)

File: `src/tests/securityGrants.test.ts` (committed as `7015d8c`, unchanged in this phase).

What it guarantees:
- Single left-to-right pass over comment-stripped migrations in filename order, so `GRANT` after `REVOKE` re-exposes (no two-pass reordering bug).
- Supports `GRANT EXECUTE`, `GRANT ALL`, `GRANT ALL PRIVILEGES` (for functions ALL = EXECUTE), multi-function statements, schema-qualified names.
- Events keyed by function SIGNATURE (`name(normed-types)`), so overloads never merge by bare name; revokes with bare types (`(uuid)`) match definitions with parameter names (`(p_booking_id uuid)`).
- Dynamic `foreach … execute format('revoke|grant …')` loops resolved at their text position when the array is a literal list; unresolvable loops reported as unknown (fail loudly).
- `ALTER DEFAULT PRIVILEGES` anywhere fails the audit loudly; comment-embedded statements ignored; bare-name statements without signatures reported as unknown.
- 9 synthetic fixtures cover: created→revoked clean / revoked→granted exposed; `GRANT ALL PRIVILEGES` after revoke; dynamic-revoke→explicit-grant and reverse order; staged revokes; late helper with no revoke; comments; overloads; bare-type matching; unsupported forms.

Result: `npx vitest run src/tests/securityGrants.test.ts` → **9/9 passed**.
This is a source-level regression guard, NOT proof of the live DB ACL. Catalog verification (actual PostgreSQL privileges for `_reserve_booking_terms`, `_riyadh_date`, `_zatca_initial_pih`, plus booking/report/invoice path tests) still requires a disposable local stack or CI database job — Docker is unavailable in this environment, CI workflow not triggered from here.

## 2. Production-mode route browser pass (Task 4)

Script: `scripts/e2e/phase10-2-routes.mjs` (new in this phase, untracked → committed here).
Fixes in this phase:
- Demo-mode detection now recognises Arabic headings (`نظرة عامة على العمليات`, `الأسطول وحجوزات القوارب`), not just English.
- Signed-out production correctly lands on `/signin` (auth gate; guest pass is demo-only) — recorded as pass with `(signed-out auth gate)` note instead of false FAIL.

Scope: `/corporate`, `/operations`, `/fleet`, `/admin/operations`, `/admin/sailings` × {desktop, phone} × {en, ar} → loads, renders (h1), no raw translation keys, RTL in Arabic, console clean.

Result against `http://127.0.0.1:3000` (production mode, signed-out): **82/82 checks passed**.
Limitation: isolated-UI pass only — proves navigation wiring, alias/auth-gate behaviour, i18n/RTL, clean console. Does NOT prove database authorisation (needs signed-in staff/customer journeys against an isolated test backend; hosted `GulfMover-Demo` records untouched per phase rules).

## 3. Readiness matrix correction (Task 5)

File: `docs/launch/launch-readiness-matrix.md`.
- Weights sum to **24**, not 25. Numerator = 1795. 1795/24 ≈ **74.8% → ~75%**.
- Earlier “76% / 25” was arithmetic error (1795/25 = 71.8%, not 74%).
- No category score changed; routes row evidence updated to note the 82/82 signed-out production pass.

## 4. Final checks (this phase)

- `npm run typecheck` → exit 0.
- `npm test` → **28 files passed, 11 skipped; 885 tests passed, 121 skipped, 0 failed** (exit 0).
- `npm run build` → exit 0 (chunk-size warning only, pre-existing).
- `npm run check:env -- development` → 0 errors, 0 warnings.
- `git diff --check` → clean.
- DB suites (`test:db`, `test:db:upgrade`, backup drill) and CI workflow: **not run here** (no Docker / no CI trigger from this environment); recorded as blocked, not as passes.

## 5. Remaining work (next phase)

1. Run the CI database job (clean migration install incl. Phase 10 hardening migration, catalog privilege assertions, RLS/concurrency/upgrade suites, backup drill).
2. Signed-in browser journeys (staff + customer, company isolation, QR secrecy, consequential-action server guards) against an isolated test backend.
3. Hosted advisor re-check after the migration lands (read-only; migration NOT applied to `GulfMover-Demo` in this phase).
4. External gates unchanged: ATCO decisions D1/D3–D6/D9/D10/D12–D14/D16, live payments, official port clearance, legal, hosting, physical devices.
