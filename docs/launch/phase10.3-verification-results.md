# Phase 10.3 verification results (2026-10-29)

Branch: `feature/phase10.3-database-ci-proof` (based on Phase 10.2 tip `12712cc`).
Draft PR for CI trigger: `TOPZEDE/GulfMoverMockApp#2` (draft, base
`feature/phase10.2-ci-security-verification` — **do not merge**).
Hosted `GulfMover-Demo` untouched. No live payments, no notifications sent.

## 1. GitHub Actions result for the Phase 10.2 commit (Task 1)

No workflow ever ran for `12712cc`, and none can run in this repository right now.

- Push run for `12712cc`: `actions/runs/40750748687` → `startup_failure`,
  0 jobs, empty workflow name, no logs (`log not found`). Same outcome for
  all 7 prior push runs back to Phase 8 (`40708020532` … `40750748687`).
- The run maps to pseudo-workflow id `399517306` (`path: BuildFailed`,
  `state: deleted`, empty name) — GitHub rejected the workflow set before
  dispatching any job.
- Bisect on this branch: a trivial `Ping` workflow (`1 job, 1 step,
  `run: echo hello`, actionlint-clean) also `startup_failure` in 0s
  (`actions/runs/40861589347`); with `ci.yml` removed and only `ping.yml`
  present it still fails (`40861700117`). Restored `ci.yml` afterwards, so
  the branch diff contains no workflow changes.
- `actionlint 1.7.12` (Homebrew) reports **no findings** on `ci.yml`.
  Repo settings via API: Actions `enabled: true`, `allowed_actions: all`.
  Default branch `main` (`b2289d`, only `.gitignore` + initial commit) has no
  `.github/workflows`, so the workflows API lists `total_count: 0` — that is
  expected and is not the cause (feature-branch pushes carry their own files).
- Draft PR #2 pull-request run (`40861863771`) also `startup_failure`
  (`Unknown event`). Both `push` and `pull_request` triggers are affected.
- Conclusion: **repo-level CI blocker, not a workflow-syntax bug.** Exact
  GitHub-side cause unknown (no diagnostic exposed via API/CLI). Next step
  for someone with admin/UI access: open the failed run in the web UI for the
  annotation banner, check Settings → Actions → general/runner-group and any
  spending-limit or abuse-flag notice. No empty commits were made to chase
  this; the three diagnostic commits (ping add / ci remove / revert) document
  the bisect and net to zero workflow diff.

## 2. Database proof on a disposable PostgreSQL (Task 2)

CI being unavailable, the database job was proven locally instead.

- A loopback PostgreSQL 17.11 was already listening on `127.0.0.1:54322`
  with supabase-style roles (`anon`, `authenticated`, `service_role`) and 47
  public tables; its migration ledger held exactly the 27 repository
  migrations (`20261026144000` … `20261101100005`). I did not start it and
  cannot verify its provenance, so it is treated strictly as a **disposable
  test fixture**: the only writes I made were the Phase 10 migration below
  plus fictional `gm-db-*@example.test` rows created by the repo's own test
  harness. A from-scratch clean install remains the CI database job's
  responsibility (blocked, §1).
- Pre-migration catalog truth:
  - `_reserve_booking_terms(boolean, text)` — ACL `{postgres=X/postgres}`,
    `anon/authenticated/public` execute = **f**. Already owner-only on a
    clean install (the earlier `REVOKE … FROM PUBLIC` covers `authenticated`
    too, since no explicit grant exists). The migration's first `REVOKE` is a
    correct no-op safeguard here, not a live fix.
  - `_riyadh_date(timestamptz)` and `_zatca_initial_pih()` — ACL `NULL`
    (= PostgreSQL default PUBLIC execute), `anon/authenticated/public` = **t**.
    **Genuinely exposed; the migration is the real fix.**
  - Full `_*` sweep: 18 helpers, all others already `f/f/f`.
- Applied `supabase/migrations/20261102000000_phase10_security_hardening.sql`
  from the repo file (`psql -1 -f`, `ON_ERROR_STOP=1`): `REVOKE, REVOKE,
  REVOKE`, recorded `20261102000000` in
  `supabase_migrations.schema_migrations`. Post-migration: all three helpers
  `f/f/f` for `anon`/`authenticated`/`public`.
- `GM_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`
  `npm run test:db` → **3 files passed, 1 skipped; 39 passed, 3 skipped,
  0 failed** (exit 0). Critically,
  `src/tests/db/phase10.helper-grants.db.test.ts` **2/2 passed against real
  PostgreSQL**: catalog invisibility of the three helpers for client roles
  *and* server-side report/invoice/sandbox-booking paths still working.
  Commerce + operations suites (tariffs, lifecycle, credit, settlements,
  materials/charters, comms suppression, privacy, privilege sweep,
  role-gated reports) all passed with the hardening applied.
- Still blocked (need Docker; `docker` binary absent here):
  `npm run test:db:upgrade` (spawns its own containers via
  `scripts/db/local-db.sh`) and `scripts/db/backup-restore-drill.sh`.
  Recorded as blocked, not as passes.

## 3. Browser verification (Task 3)

- Rebuilt app + `vite preview` on `127.0.0.1:4317` (production `.env.local`):
  `GM_E2E_APP_URL=http://127.0.0.1:4317 node scripts/e2e/phase10-2-routes.mjs`
  → **82/82 checks passed** (no regression vs Phase 10.2). Scope unchanged:
  signed-out/demo isolated UI — navigation wiring, alias/auth-gate behaviour,
  EN/AR rendering incl. RTL, no raw keys, clean console. Signed-out
  production correctly lands on `/signin` (recorded as pass).
- Authenticated browser journeys (booker own-access, cross-company denial,
  ops sailing control, booker-vs-staff gating, boarding-gate rejection, QR
  secrecy, server-side guards) **could not run**: no auth backend exists in
  this environment (no local GoTrue; hosted project off-limits for mutation).
  This is explicitly **not** claimed. The authorization evidence stands on:
  - the DB suites above (RLS + JWT-role tests: strangers rejected from org
    bookings, agent isolation, staff-only payment/claim paths, anon-denied
    diagnostics, privilege sweep, role-gated reports) — all against real PG;
  - component tests (`corporateWorkspace`, `rewiredRoutes`, onboarding,
    phase3/4 security) in the unit suite — all passing.
- An earlier run of the same script showed 4/24 because the preview server
  had exited between shell calls (`ERR_CONNECTION_REFUSED`); rerun in a
  single serve+test command gives the 82/82 above. Not an app defect.

## 4. Audit of verification claims (Task 4)

- `src/tests/securityGrants.test.ts` (9/9 passing): single left-to-right
  pass, signature-keyed events, `EXECUTE`/`ALL`/`ALL PRIVILEGES`,
  in-order dynamic loops, loud failure on `ALTER DEFAULT PRIVILEGES`
  (absent from all 28 migrations — verified by grep) and on unresolvable
  forms. **Source-level regression guard, not DB proof** — the DB proof is
  §2 above, kept separate as required.
- Migration review: the `_`-internal convention holds; the one genuine
  exposure class was helpers created *after* the Phase 8 dynamic revoke loop
  (`_riyadh_date` in `…100005`, `_zatca_initial_pih` in `…100002` without
  loop coverage), now closed. `_reserve_booking_terms` revoke is hardening.
  `security-rpc-matrix.md` §C annotated accordingly (no score/claim change
  beyond that note).
- `scripts/e2e/phase10-2-routes.mjs`, `.github/workflows/ci.yml`,
  `scripts/db/local-db.sh`, `supabase/tests/auth_stub.sql` reviewed: no
  unsupported grant forms, no ordering tricks, no default-privilege changes
  that could silently bypass the source audit. No tests weakened or skipped
  to get green (skip counts: DB upgrade file needs Docker; 11 unit files are
  pre-existing environment-gated skips, unchanged).

## 5. Full verification suite (this branch)

- `npm run typecheck` → exit 0.
- `npm test` → **28 files passed, 11 skipped; 885 passed, 121 skipped,
  0 failed** (exit 0).
- `npm run build` → exit 0 (pre-existing chunk-size warning only).
- `npm run check:env -- development` → 0 errors, 0 warnings.
- `npm run test:db` (disposable loopback PG, §2) → 39 passed, 3 skipped,
  0 failed.
- `git diff --check` → clean.
- Not run (blocked): `test:db:upgrade`, backup drill, CI app+database jobs.
- Secrets scan: no secret values in diffs, logs, or build output; `.env.local`
  untouched and uncommitted; no service-role keys handled.

## 6. Readiness and remaining work

Readiness stays **~75%** engineering readiness for controlled launch
(1795/24, unchanged — no category scores changed; security-row evidence text
now cites real catalog proof). What's new: security hardening verified
against actual PostgreSQL; browser routes re-verified 82/82 on this branch.

Remaining blockers (unchanged owners): CI repo-level `BuildFailed` (§1) and
Docker-gated suites need infrastructure access; ATCO decisions
D1/D3–D6/D9/D10/D12–D14/D16, live payments, port clearance, legal, hosting,
physical devices, production approval. `GulfMover-Demo` migration + hosted
advisor re-check still pending a controlled apply outside this phase.
