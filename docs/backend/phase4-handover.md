# Gulf Mover — Phase 4 handover (checkpoint)

> **Status: NO Phase 4 feature code has been written.** This checkpoint contains only this document.
> Phase 4 work stopped at the first step (branch creation). Everything below is a **design plan**
> derived from reading the Phase 1–3 code; none of it is implemented or tested.

## 1. Base and branch

| Item | Value |
|---|---|
| Phase 3 base commit | `dad61984f5d1852a586b6d4b5cf174dfe5395b02` (branch `feature/phase3-approval-bookings`) |
| Phase 4 branch | `feature/phase4-operational-platform` (created from the base above) |
| Checkpoint commit | the commit that adds this file (see `git log`) |

## 2. What exists (from Phase 1–3, verified then — see `docs/test-results.md`)

Working and verified against a **local** Supabase stack (not hosted): authentication incl. confirmation and
password recovery, company registration, ATCO company review (`review_company`), `my_company_memberships`,
vessels/routes/sailings management, `create_booking` with capacity locking and idempotency, My bookings.
Phase 3 results: 339 unit tests, 24 local-Supabase integration tests, 27 browser checks — all passing at `dad6198`.
**These were not re-run during Phase 4** (the baseline run was interrupted).

Key files: `supabase/migrations/2026102712*.sql`, `src/lib/{dataService,adminService,bookingService,companyService}.ts`,
`src/pages/{ProductionBookingView,ProductionBookingsView,AdminCompaniesView,AdminOperationsView}.tsx`,
`src/components/ProductionUi.tsx`, `src/tests/integration/*`, `scripts/e2e/local-journeys.mjs`,
`docs/backend/phase3-approval-bookings.md` (§4 = how to run the local stack in a restricted network).

## 3. Phase 4 features — status

| Feature | Status |
|---|---|
| Security fixes (suspended staff, staff-id exposure, config.toml) | **Not started** |
| Company-member management + invitations | **Not started** |
| Tickets + QR | **Not started** |
| Boarding + manifests | **Not started** |
| Sailing clearance / readiness | **Not started** |
| Materials requests | **Not started** |
| Charter requests | **Not started** |
| In-app notifications | **Not started** |
| Tests / docs for the above | **Not started** |

## 4. Known issues to fix first (carried from Phase 3, still present)

1. `public.has_platform_role()` ignores `profiles.status`: a suspended staff profile with an active
   `role_assignments` row keeps RLS read access. Fix: `create or replace` the helper (same signature keeps the ACL)
   adding `and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'suspended')`;
   consider the same for `has_org_role()` / `active_org_ids()`; add DB tests.
2. `vessels`/`routes`/`sailings` expose `created_by`/`updated_by` (staff auth ids) to every signed-in user.
   Fix: revoke table SELECT, re-grant column-level SELECT without those columns (services already list columns).
3. `supabase/config.toml`: `[db.seed] sql_paths = ["./seed.sql"]` but the file is `seed_demo.sql`;
   `enable_confirmations = false`; `additional_redirect_urls` lacks `/auth/reset-callback`; `email_sent = 2`/hour.
   `[experimental] stack = true` needs ghcr.io (blocked in the cloud sandbox — use a scratch copy with `stack = false`
   and `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`).

## 5. Design plan (proposed, not implemented) — follow or revise

All as additive migrations after `20261027121000`; `SECURITY DEFINER` + `set search_path = ''`; revoke EXECUTE from
`public, anon, service_role` explicitly (default privileges grant it — see `20261026190000`).

* **Invitations** — table `company_invitations(organization_id, email lower, membership_role fixed 'company_booker'
  (A2: admins cannot create admins), status pending/accepted/revoked, expires_at, invited_by, accepted_by)`; partial
  unique index on pending `(organization_id, lower(email))`. RPCs: `invite_company_member` (caller
  `has_org_role(org,'{company_admin}')` AND org approved; idempotent on existing pending), `revoke_company_invitation`,
  `accept_company_invitation` (definer reads `auth.users` of `auth.uid()`: e-mail must match AND be confirmed; row
  lock; reactivates a suspended membership), `remove_company_member` (booker only, not self → membership `suspended`),
  `list_company_members` (admin only; display name + e-mail of own company). No service key needed: acceptance is
  in-app for a signed-in user with the invited, confirmed e-mail. **No e-mail is sent** — UI must say so.
  Expiry period (e.g. 14 days) is a business decision.
* **Tickets** — `tickets(booking_id, booking_leg_id, sailing_id, passenger_index, passenger_name nullable (never
  invented), reference TK-…, qr_token random 32 bytes, status valid/boarded/cancelled, booking_reference copy)`;
  unique `(booking_leg_id, passenger_index)`; issue inside `create_booking` (create or replace) so replays never
  duplicate; backfill existing bookings in the migration. Column-level SELECT excludes `qr_token`; RPC
  `get_ticket_qr(ticket_id)` returns it only to the booking creator. QR payload `GMT1:<token>` (no personal data);
  `qrcode.react` is already a dependency.
* **Boarding** — RPC `board_ticket(p_code, p_sailing_id)` for `boarding_staff`/`operations`/`super_admin`; ticket
  row `FOR UPDATE`; returns an outcome (boarded / already_boarded / not_found / wrong_sailing / cancelled /
  sailing_not_cleared / sailing_cancelled) and records `boarding_events` (actor = `auth.uid()`, no client actor,
  no update/delete grants). Manifest = tickets for a sailing (RLS: staff roles incl. boarding_staff).
  Camera scanning untested — provide manual entry.
* **Clearance** — `sailings.clearance_status pending/cleared/blocked` (not client-writable; outside the existing
  column grants), `sailing_clearance_events` (reason, actor, time; staff-only RLS); RPC `set_sailing_clearance`
  (super_admin/operations; reason required for blocked; idempotent). Boarding requires `cleared` — a provisional rule
  to record for ATCO. 4-ticket minimum = warning only.
* **Materials / charters** — `material_requests` (fields from the demo model: description, quantity, weight,
  dimensions, destination, optional booking link, handling notes; statuses pending_review / clarification_required /
  accepted / rejected) and `charter_requests` (route, requested date, optional preferred Saudi time, passenger count,
  material summary, notes; statuses awaiting_review / information_required / accepted_for_planning / rejected), each
  with request_key idempotency, server references, event tables, requester re-submit RPC, staff review RPC. No prices,
  no confirmed allocation.
* **Notifications** — `notifications(user_id, kind, subject_type, subject_id, params jsonb, link, read_at,
  dedupe_key unique per user)`; inserted only by an internal definer helper called from the RPCs/triggers above
  (org approved/rejected, invitation created/accepted, membership revoked, booking reserved + tickets issued,
  material/charter submitted/updated, sailing clearance/cancellation, ticket boarded). UI translates by `kind`
  (EN/AR). Users read/mark only their own (`update(read_at)` column grant + RLS `user_id = auth.uid()`).
* **UI** — production routes `/company/members`, `/tickets`, `/tickets/:reference`, `/admin/boarding`,
  `/admin/readiness`, `/materials` + `/admin/materials`, `/charters` + `/admin/charters`, `/notifications`;
  nav driven by server-read roles (`usePlatformRoles`) as in Phase 3; demo routes unchanged via `ByMode` in `App.tsx`.

## 6. Tests and checks run in this checkpoint

* `git diff --check` — see the checkpoint commit message / report.
* No typecheck, unit, integration or browser run was completed in Phase 4 (baseline interrupted). Code is unchanged
  from `dad6198`, whose results are recorded in `docs/test-results.md`.
* No migration was created or tested in Phase 4. Nothing touched a hosted Supabase project.

## 7. Next tasks, in priority order

1. Re-run the baseline at this commit (`npm run typecheck`, `npm test`, `npm run build`, local stack +
   `npm run test:integration`, `npm run test:e2e:local`).
2. Security fixes in §4 with DB tests.
3. Tickets (+ issuance inside `create_booking`, backfill) → boarding + clearance (they depend on each other).
4. Notifications helper (so later features can emit events).
5. Member management/invitations.
6. Materials and charter requests.
7. EN/AR translations, mobile checks, integration + browser journeys, docs (`phase4-operational-platform.md`,
   `test-results.md`, pending business rules: invitation expiry, clearance-before-boarding, who boards, request
   statuses, notification recipients).
