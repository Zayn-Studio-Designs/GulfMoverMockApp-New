# Phase 18 — Section 4: registration RPC, migrations and release readiness

Branch: `feature/phase18-register-company-release-reconciliation` (from Phase 17 tip `884bd09`).
Hosted `GulfMover-Demo` untouched. Old repository untouched. No merge to `main`, no production
deployment, no live payments, no external notifications. Local `config.toml` still pins
`otp_expiry = 3600`.

## What actually ran (no mocks for the new coverage)

CI run
[41121866683](https://github.com/Zayn-Studio-Designs/GulfMoverMockApp-New/actions/runs/41121866683):
all three jobs success on commit `25c5c05`
(App: typecheck/unit/build; Database: clean install, RLS, finance,
concurrency, upgrade, backup drill; `supabase-e2e`: disposable stack with all
28 migrations, production build via `vite preview`, real Chromium, zero route
interception). Phases 13–17 suites reran green, then the new Phase 18 suite ran
and `supabase stop` tore the stack down.

| Suite | Result in run 41121866683 |
|---|---|
| App (typecheck, unit, build) | 28 files passed / 12 skipped; **885 passed / 127 skipped**; build ok |
| Database `test:db` (clean install of all 28 migrations) | 4 files passed / 1 skipped; **45 passed / 3 skipped** |
| Database upgrade (Phase 7 → 8) | **3/3** |
| Backup/restore drill | **PASS** (688K app dump + 96 auth-user lines, 1s) |
| Phase 13 API / browser | 32/32, 14/14 |
| Phase 14 API gaps / browser gaps | 18/18, 13/13 |
| Phase 15 email/invite / lifecycle-roles | 45/45, 61/61 |
| Phase 16 booking-verify / roles-redirects | 36/36, 43/43 |
| Phase 17a suspended-retry / 17b expiry | 27/27, 16/16 |
| **Phase 18 register_company** | **29 passed, 0 failed** |

Log hygiene: the only `eyJ` occurrences in the e2e job log are the two `redact()`
function definitions (startup + restart steps); no credential material in output.
`::add-mask::` is applied to both keys before use.

## 1. `register_company` behaviour (Section 4, second checkbox) — now verified

Script: `scripts/e2e/phase18-register-company.mjs` (also `npm run test:e2e:register-company`),
wired into CI after the Phase 17 config-restore step so it runs on the default
configuration. Loopback-only guard; aborts (exit 2) on any non-loopback URL.
Count reads use `service_role`; audit reads use the operations-staff identity
(preserves the Phase 17 fix); visibility assertions use the signed-in callers.

1. **Valid creation pending by default** — accepted with `outcome created`,
   `status pending`; founder sees it via `my_company_memberships`; exactly one
   `company_admin` membership and one `submitted` audit event.
2. **Same-key replay idempotent** — returns the same id with `outcome replayed`;
   company/membership/audit counts unchanged at 1/1/1.
3. **Changed payload, same key rejected** — `payload_mismatch`; counts unchanged.
4. **Concurrent requests** — 6-way same-key race yields exactly 1 `created` +
   5 `replayed`, one company/membership/event; 4-way distinct-key control all
   succeed (no false conflicts).
5. **Suspended users denied** — `profile_suspended` on first registration AND on
   replay of another user's key (guard precedes the replay branch); zero companies
   for the suspended user; re-activation restores normal registration.
6. **Identity always `auth.uid()`** — `created_by` equals the caller; a forged
   extra `p_user_id` parameter is rejected by PostgREST and creates nothing;
   cross-user replay of the same key fails with `belongs to another user` and
   grants no membership.
7. **Rollback on failure** — empty legal name rejected with zero companies, zero
   audit rows for the key; a valid retry afterwards succeeds (clean recovery).

`p_registration_key` UUID requirement (Phase 17 finding) is preserved in all fixtures.

## 2. Migration and requirements reconciliation

- **28 migration files on disk; Phase 12 verified 28 applied** — consistent, no drift.
  Ordered chain `20261026144000` → `20261102000000` installs clean in CI on every run.
- **`register_company` RPC present** in migration `20261026180000`, consistent with the
  checklist's struck-through stale-note item. Behaviour coverage above closes the
  remaining explicit-verification half of that row.
- **P1–P10 remain provisional** in both `docs/atco-pending-business-rules.md`
  (14 provisional markers intact) and the migration header comments. No code or doc
  change treats them as ATCO-approved. P1 (multi-company per attempt-key),
  suspended-profile denial, paired-nullability, and provisional length caps were
  exercised as documented policy boundaries, not approvals.
- **Known doc staleness (not a gate):** `docs/requirements-traceability.md` is a
  Phase-8 snapshot (names the phase-8 branch, "40 tests"). It is a historical record;
  current evidence lives in the `docs/launch/phase*.md` series. Left untouched.
- **ATCO business rules vs tests:** the suite proves server-side enforcement of the
  provisional rules; it does not approve tariffs, VAT, refunds, or registration policy.

## 3. Release source (`origin/main` vs feature branch)

- `origin/main` contains exactly **2 commits** (`Initial commit`, `.gitignore`) — an
  empty baseline with no migrations, no app, no CI evidence. It is **not** a release
  candidate and must not be deployed.
- HEAD (`25c5c05` at evidence time) is 83 commits ahead and contains all of Phases 1–18.
- **Recommended release candidate, subject to approval:** the Phase 18 feature-branch
  tip after a green CI run. No merge performed; no default branch changed.

## 4. Clean-install and upgrade evidence (this run)

- Disposable PostgreSQL clean-installs all 28 migrations (`scripts/db/local-db.sh up`),
  then `test:db` (45/3), `test:db:upgrade` (3/3), backup/restore drill (PASS).
- The `supabase-e2e` job applies the same 28-migration chain on the disposable stack
  before all API/browser suites.

## 5. Skipped-test inventory (exact, local `npm test` + CI)

Local and CI agree: **28 files passed / 12 skipped; 885 passed / 127 skipped (1012)**.
All 127 skips come from 12 files, itemized:

| File | Skipped | Reason | Covered in CI instead |
|---|---|---|---|
| `integration/localSupabase.integration.test.ts` | 24 | needs `GM_IT_*` loopback stack (absent locally) | yes — Phases 13–18 e2e suites |
| `db/phase8.commerce.db.test.ts` | 21 | needs `GM_DB_URL` loopback PG | yes — database job `test:db` |
| `db/phase8.operations.db.test.ts` | 16 | needs `GM_DB_URL` | yes — database job |
| `integration/phase6.security.integration.test.ts` | 20 | needs `GM_IT_*` | yes — e2e + `test:db` |
| `integration/phase7.atco.integration.test.ts` | 9 | needs `GM_IT_*` | yes — e2e suites |
| `integration/phase4.integration.test.ts` | 9 | needs `GM_IT_*` | yes — e2e suites |
| `integration/phase5.integration.test.ts` | 9 | needs `GM_IT_*` | yes — e2e suites |
| `integration/phase6.upgrade.integration.test.ts` | 5 | needs `GM_IT_*` | yes — database upgrade job |
| `integration/phase6.qr-decode.integration.test.ts` | 3 | needs `GM_IT_*` + optional decoder deps | partially — QR secrecy covered by `test:db`; independent-image-decode path remains environment-gated |
| `db/phase12.isolation.db.test.ts` | 6 | needs `GM_DB_URL` | yes — database job |
| `db/phase8.upgrade.db.test.ts` | 3 | needs `GM_DB_UPGRADE=1` + `GM_DB_URL` | yes — database upgrade job |
| `db/phase10.helper-grants.db.test.ts` | 2 | needs `GM_DB_URL` | yes — database job |

No skip was removed or relabelled to inflate the pass count. The single environment-gated
gap (independent QR image decode) is recorded, not counted as passed.

## 6. Dependency and security review

- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities** (local, same tree as CI).
- CI secret scan: no committed keys (job green). `git diff --check`: clean.
- Grants/RLS posture unchanged: `register_company` executable by `authenticated` only;
  direct `INSERT` on organizations revoked; audit tables append-only; Phase 17
  operations-staff audit-read pattern preserved.

## 7. Remaining Section 4 items (open, with owner)

- [ ] Confirm ATCO has not approved registration rules — documented in §2, needs named
  ATCO decision owner sign-off (owner: ATCO sponsor).
- [ ] Reconcile any other drift — done for migrations/rules/traceability/matrix to the
  extent above; the Phase-8 traceability snapshot noted as historical.
- [x] Pick the exact release branch and commit — recommended in §3; decision and any
  merge remain explicitly awaiting approval.
- [x] Clean migration install on the release candidate — evidenced in §4 for `25c5c05`.
- [x] Skipped-test inventory — §5.
- [x] Full regression on the release candidate — this run (table above).
- [x] Dependency audit — §6.

## 8. Blockers and non-goals

- No Docker on this Mac: DB/e2e verification runs in CI only (documented, not substituted).
- ATCO decisions (tariff/VAT, refunds, registration policy P1–P39, hosting/PITR,
  port clearance, devices, legal) remain open and are not affected by these results.
- Section 3 checkboxes were not edited; Phase 17 evidence stands.

## Completion standard

The `register_company` behaviour checkbox is now supported by 29/29 real-stack checks
plus the preserved local idempotency coverage. The release-candidate recommendation,
migration reconciliation, skip inventory, and dependency review are evidenced above.
Final branch/commit and CI run URL are recorded at the top; the Google Doc was not edited.
