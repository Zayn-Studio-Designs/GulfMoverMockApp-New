# Phase 10.4 — GitHub Actions `startup_failure` escalation report (2026-10-29)

Branch: `feature/phase10.4-actions-diagnosis` (based on Phase 10.3 tip `1fee5c0`).
PR #2 left untouched (still draft, unmerged). No app, migration, test, or
workflow-content changes in this phase. Hosted `GulfMover-Demo`, LiftLog,
`.env.local`, payments, and notifications all untouched.

## Verdict

The `startup_failure` is **account-level, not repository-level**. No workflow
edit, permission toggle, or rerun available to this environment can fix it. A
human with web-UI/billing access must act (§4). GitHub Support is the
fallback (§5).

## Evidence (all read-only, all reproducible via `gh`)

1. Every push and pull-request run in `GulfMoverMockApp` since Phase 8 fails
   identically: `startup_failure`, 0 jobs, no logs, ~0s duration. Latest:
   push `40862862126` and PR `40862870415` (draft PR #2, head `1fee5c0`).
   Rerun is refused: *"This workflow run cannot be retried"* — expected for
   runs that never produced jobs.
2. All runs map to pseudo-workflow id `399517306` (`path: BuildFailed`,
   `state: deleted`, empty name): GitHub rejects the workflow set before
   dispatch, without exposing the annotation via API (check-runs: 0, jobs: 0).
3. `.github/workflows/ci.yml` is clean: `actionlint 1.7.12` no findings;
   contents API returns the exact 1885-byte file, no BOM/CRLF; only one file
   in `.github/workflows/`. Repo Actions settings: `enabled: true`,
   `allowed_actions: all`, default token permissions `read` (all normal).
4. **Decisive probe:** a brand-new private scratch repo with a minimal valid
   workflow (`1 job, 1 step, on push to main`) on its default branch also
   failed in 0s — run `40864604283`, `startup_failure`, event `push`,
   branch `main`. A default-branch trivial workflow cannot be a repo-content
   problem. Therefore the cause sits above the repository: account billing /
   spending limit, suspension, or abuse flag.
5. Billing and deletion APIs are outside this token's scopes (`plan: null`,
   billing endpoint needs `user` scope, repo delete needs `delete_repo`
   scope), so usage/limits cannot be confirmed from here — they must be
   checked in the UI (§4).

## What the API proves vs what needs the web UI

- Proven: startup dies before job creation; not caused by YAML, triggers,
  permissions, tokens, or any file in this repo.
- UI-only: the annotation banner on the run page (may name billing/abuse),
  Settings → Billing → usage meters, any suspension/flag notice, Actions
  runner availability. Do not accept "the YAML is wrong" — the scratch-repo
  probe disproves it.

## Action required from the repository administrator

1. Open `https://github.com/TOPZEDE/GulfMoverMockApp/actions/runs/40862862126`
   and read the red annotation banner (exact GitHub-side reason).
2. Settings → Billing and plans → verify payment method current; check
   Actions minutes/storage meters and any spending-limit notice. Private-repo
   Actions stops when minutes are exhausted or billing lapses.
3. Check email for GitHub policy/suspension/abuse notices on the account.
4. Delete the leftover scratch probe repo `TOPZEDE/gm-actions-probe`
   (Settings of that repo → Danger Zone → Delete; this environment's token
   lacks `delete_repo` scope so it could not clean up after the diagnostic).
   It contains one trivial `echo hello` workflow and nothing else.
5. Re-run: push any commit (or `gh run rerun` a queued run) once green;
   expect both `app` and `database` jobs on the run page before claiming CI.

## GitHub Support escalation (if admin finds nothing)

Send to <https://support.github.com> with: account `TOPZEDE`, repo
`TOPZEDE/GulfMoverMockApp`, run ids `40862862126`, `40862870415`,
`40864604283` (scratch repo, since deleted or still present), observation
"all events including a minimal default-branch workflow on a fresh repo map
to pseudo-workflow `BuildFailed` (id `399517306`) with zero jobs", plus the
run-page banner text from step 1.

## Deliberately not done

No workflow edits (nothing wrong with them), no rerun spam, no test
weakening, no removal of the database job, no merge of PR #2, no secrets
handled. CI passing is **not** claimed: zero jobs have executed.
