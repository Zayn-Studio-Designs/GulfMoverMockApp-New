# Phase 9.2 — Hosted end-to-end journey (GulfMover-Demo)

Branch: detached worktree at `768912d` (`feature/phase9-live-database-integrations`).
Hosted: `GulfMover-Demo` (`kidcqtcggzfvkhskqyqf`, ap-southeast-1, ACTIVE_HEALTHY).
App: sibling checkout served at `http://localhost:3000/` in production mode (publishable key only).
No commit/push performed (not authorized). Payments: sandbox only. No real people, mail, or money.

## Branch alignment (Step 1)

An earlier session worked on a stale Phase 7 base under a colliding local branch name.
That work was preserved by renaming the local branch to `feature/phase9-local-connection-work`;
a clean sibling checkout (`../GulfMoverMockApp-phase9`) was created from verified remote
`768912d`, and the ignored `.env.local` was copied into it (byte-identical, still git-ignored).
All journey work below ran from the correct checkout.

## Migration reconciliation (Step 2)

- Sibling has all 27 repository migrations (21 through Phase 7 + 6 Phase 8 files, 3724 added lines).
- Hosted-only `20261028161448_pin_trigger_search_paths`: no source file exists. Verified live that
  all 18 trigger functions carry `proconfig = {search_path=""}`, and repo CREATE FUNCTION sources
  declare `security definer set search_path = ''` inline — a fresh build from repo sources reproduces
  the pinned state. No equivalent migration added (would be a no-op plus ledger noise); hosted ledger
  row left untouched. The earlier "Phase 8 drift" claim (from inspecting the stale checkout) was wrong.
- Seed compatibility checked column-by-column before running (profiles, organizations, approval_events,
  memberships, role_assignments, platform_settings incl. partial-unique conflict targets). Guard-trigger
  bodies reviewed: `guard_organizations_insert_by_user` and `guard_role_hierarchy` pass for owner-context
  seeding; `log_organization_status_changes` auto-writes Company B's `submitted` event as the seed expects.

## Auth setup (Step 3) — no signup retries

Signup was email-rate-limited (429) and `@dev.invalid` can never receive mail, so no confirmation
emails were involved at any point. Five fictional users were created via the Auth Admin API
(server-side, pre-confirmed `email_confirm: true`): `atco-admin`, `atco-ops`, `company-a-admin`,
`company-a-booker`, `company-b-booker` (all `@dev.invalid`). The service-role key was used
transiently in one local command only — never written to files, git, browser storage, or logs;
rotation is recommended as hygiene. Global email confirmation stays ON (`mailer_autoconfirm=false`).
Direct `auth.users` SQL writes were avoided. Dashboard fallback (if Admin API unavailable):
Authentication → Users → Add user → Create new user → Auto Confirm User.

## Demo data (Step 4)

`supabase/seed_demo.sql` applied section-by-section via SQL (idempotent guards held):
corporate_approval setting; 5 profiles; Sea Horizon (approved, backdated submitted+approved history)
and Jannah (pending, trigger-written submitted event verified); 3 memberships; super_admin + operations
role assignments (out-of-band path explicitly allowed by `guard_role_hierarchy`). Verified:
3 approval events with correct order, 3 memberships, correct org linkage. All fictional.

## Authenticated journey (Step 5) — PASSED

Signed in via browser as `company-a-booker@dev.invalid`:
1. Company gate showed "Company approved by ATCO — Sea Horizon (Demo) — Company booker".
2. Booking form loaded live routes, live sailings (Oct 29–Nov 11, 07:00/09:30/13:00 Riyadh, 12 seats),
   server-quoted SAR 500 fare, provisional terms v1.
3. Corporate booking created through `create_booking` RPC → **GM-BF1AD8BD** (outbound 29 Oct 09:30 Riyadh).
   DB: 1 booking (`reserved`→`paid`), 1 leg, 1 ticket (`valid`, opaque `TK-…` reference + random `qr_token`).
4. Sandbox mada checkout → server-verified success (browser redirect never treated as proof):
   payment `succeeded` (sandbox), invoice **GM-INV-2026-000001** (`paid`, "Commercial invoice (not a tax
   invoice)" — no ZATCA claim), minimum counter 1 of 4, clearance stays "Awaiting operations readiness".
5. Browser restarted onto the booking URL: full state re-fetched from hosted (Paid / Paid verified /
   invoice / history incl. "Payment verified", "Invoice issued"; ticket "Issued — not boarded").
6. RLS proven with per-user tokens: A-booker sees the booking; atco-ops sees it; B-booker list is empty
   AND direct-ID plus ticket access return `[]` (denied by DB, not hidden by UI); anon gets 401 on routes.
7. Boarding enforcement: booker `board_ticket` RPC → `42501 not authorized`; ticket still `valid`,
   `boarded_at` NULL. Booker's UI offers no boarding action.

## Security review (Step 6)

- Linter: 2 INFO (`document_counters`, `notification_outbox` RLS-enabled-no-policy = deny-by-default,
  no user grants); many WARN `authenticated can execute SECURITY DEFINER` = by-design RPC surface,
  authorization enforced inside bodies (`auth.uid()`/role checks, exercised above); 1 WARN anon-executable
  `health_ping()` (read-only liveness probe, takes no input — accepted, note it).
- 148 SECURITY DEFINER functions, 0 with mutable `search_path`. Storage: private
  `material-attachments` bucket, authenticated-only policies scoped by
  `can_read/can_write_request_object(name)`. Notifications table is pointer-style
  (`event_key`/`kind`, no bodies) with owner-only SELECT; journey produced exactly the 4 expected
  events for the booker (booking_created, tickets_created, payment initiated/succeeded).
- Auth config: `uri_allow_list` now includes `http://localhost:3000/*` and `http://127.0.0.1:3000/*`
  (was empty; site_url already localhost). Nothing else changed.

## Defects found (not fixed — no commit authorized)

1. Untranslated nav labels in Phase 8/9 UI: `p5MaterialsShort`, `p5CharterShort`, `p5MembersShort`
   render as raw keys (EN and presumably AR). Cosmetic; booking flow unaffected.
2. `health_ping()` anon-executable — accepted as-is (no input, read-only), recorded for ATCO review.

## Checks (correct checkout)

- `npm run typecheck` → 0 errors. `npm test` (with `VITE_APP_MODE=demo VITE_AUTH_RESET_REDIRECT_URL=`
  overrides since ignored `.env.local` leaks production mode into vitest) → **850 passed, 119 skipped
  (integration suites need a local-stack env), 0 failed**. `npm run build` → OK. `git diff --check` → clean.

## Still requires you

- Rotate the Supabase service-role/secret key (it transited this session; publishable key unaffected).
- Decide on `mailer_autoconfirm` (left ON-required), custom SMTP for real confirmation mail, and the
  hosted `pin_trigger_search_paths` ledger row (effect covered; row left as history).
- Hosted staging hardening, backup/recovery checks, and physical-device camera testing remain future work.
  Not production-ready; no live money, compliance, or hosting claims.

## Phase 9.3 — Navigation translations + sandbox clarity (uncommitted)

Keys added to `src/i18n/translations.ts` (EN+AR): `p5MaterialsShort` Materials/المواد,
`p5CharterShort` Charters/الرحلات الخاصة, `p5MembersShort` Members/الأعضاء,
`p4BoardingShort` Boarding/الصعود. The phone-size nav renders `t(key+'Short')`;
these four were missing, so raw identifiers showed. All 23 Layout nav keys + Short
variants now resolve (covered by a new regression test in `src/tests/i18n.test.ts`
that scans Layout.tsx for `key: '…'`).
Sandbox wording: new `p8SandboxPaidNotice` ("DEMO PAYMENT — simulated success, no real
money collected." / "دفعة تجريبية — نجاح مُحاكى، لم تُحصَّل أي أموال حقيقية.") shown on
the booking status card when payment is paid and every payment is sandbox-mode
(`BookingCommerce`); `InvoiceView` shows it for paid sandbox invoices (other sandbox
docs keep `p8SandboxDoc`); `CompanyReportsView` invoice rows gained the `· sandbox/تجريبي`
suffix (data already carried the flag via INVOICE_SELECT). Verified in browser EN + AR
(RTL): nav labels translated, DEMO notice on booking GM-BF1AD8BD, invoice `· تجريبي`.
Checks: typecheck 0 errors; full suite 852 passed / 119 skipped / 0 failed;
build OK; `git diff --check` clean. Modified (uncommitted): BookingCommerce.tsx,
phase8.ts, translations.ts, CompanyReportsView.tsx, InvoiceView.tsx, tests/i18n.test.ts.
No hosted data changed; GM-BF1AD8BD untouched.
