# Phase 5 — company members, transfer requests, notifications and QR scanning

## Starting point and branch

| Item | Value |
|---|---|
| Base commit | `e1ed860a53d5187c021e809922eea561458259f5` (Phase 4 checkpoint) |
| Base branch | `feature/phase4-operational-platform-build` |
| Phase 5 branch | `feature/phase5-remaining-operations` |
| Local stack used | native CLI stack `gm-phase5-build` (loopback only) |

## What Phase 5 adds

Four coherent production workflows, all backed by real migrations, `SECURITY DEFINER`
RPCs, row-level security and column grants — not UI-only screens.

### Company members and invitations — `20261029100000_company_members.sql`, `20261029103000_inviter_authority.sql`

* `company_invitations` (status `pending`/`accepted`/`revoked`, 7-day provisional expiry,
  unique pending `(organization_id, email)`) and `membership_events` audit table.
* RPCs: `invite_company_member`, `cancel_company_invitation`, `accept_company_invitation`,
  `revoke_company_member`, `list_company_members`; helper `lock_company_admin` serialises
  administrative mutations on the company and re-checks *current* authority.
* Invitations can only ever create `company_booker` — an admin cannot mint another admin.
* Acceptance binds to the caller's own **confirmed** e-mail (`my_invitation_email()`), so an
  invitation cannot be claimed by anyone else.
* Direct `insert/update/delete` on `organization_memberships` was **revoked** from
  `authenticated`: consent cannot be bypassed, and every change is audited.
* `guard_invitation_acceptance` re-checks the *issuing* admin's authority at acceptance time,
  so a pending invitation cannot be used after its inviter is suspended.

### Materials and charter requests — `20261029101000_transfer_requests.sql`

* `transfer_requests` (kind `materials`/`charter`, `details jsonb`, status
  `pending_review`/`clarification_required`/`reviewed_for_planning`/`rejected`, `revision`)
  plus `transfer_request_events` audit history.
* `submit_transfer_request` is idempotent per client `request_key`, rejects a replayed key
  with different details (`payload_mismatch`), and validates the allowed field set, field
  types, length caps and date/time/passenger formats server-side.
* `review_transfer_request` is ATCO-only (`super_admin`/`operations`), requires a reason,
  uses optimistic `revision` and records the actor in the audit row.
* Review outcomes are deliberately worded **"reviewed for planning"**, never "approved
  transport": no allocation, tariff or clearance is implied.
* Visibility: `can_read_transfer` — ATCO staff, own-company admins, and bookers only for
  requests they created in an approved company.

### In-app notifications — `20261029102000_notifications.sql`

* `notifications` (owner-only RLS, `unique(user_id, event_key)` dedupe) written **only** by
  the internal `emit_notification` helper, fired by `after insert` triggers on
  `approval_events`, `membership_events`, `bookings`, `tickets`, `transfer_request_events`,
  `sailing_readiness_events` and `boarding_events`.
* `mark_notification_read` is owner-scoped (`user_id = auth.uid()`), so one user cannot touch
  another's rows. No e-mail, SMS or push delivery — in-app only.

### QR scanning on the boarding desk — `src/hooks/useCameraScanner.ts`, `src/pages/ProductionBoardingView.tsx`

* Opt-in camera scanning using the Chromium `BarcodeDetector` API; the camera opens only when
  the operator explicitly starts it and is always released on stop, on scan or on unmount
  (including a quick off/on race where an earlier permission prompt resolves late).
* Exactly **one** boarding attempt per explicit scan: frame polling stops after the first
  detection and never boards repeatedly.
* When the API is missing or permission is denied the page states that plainly and keeps the
  manual ticket-reference entry available. Scanning is a convenience, never a clearance.

## UI wiring

`src/App.tsx` adds production routes `/charters`, `/notifications`, `/company/members`,
`/admin/materials`, `/admin/charters`; `/materials` is now production-backed while the demo
path is unchanged through `ByMode`. `src/components/Layout.tsx` adds customer and staff nav
entries (staff entries gated by server-read roles) and points the bell at `/notifications`
in production.

## Local reproduction

```bash
# 1. Local stack (native CLI stack used here; Docker + `supabase start` also works)
supabase stack start --stack gm-phase5-build
supabase stack status --stack gm-phase5-build --env   # never commit this output

# 2. App against that LOCAL stack (public anon key only)
#    VITE_APP_MODE=production VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=...
#    VITE_AUTH_RESET_REDIRECT_URL=http://localhost:4317/auth/reset-callback
npm run dev

# 3. Checks
npm run typecheck && npm test && npm run build
GM_IT_SUPABASE_URL=... GM_IT_ANON_KEY=... GM_IT_SERVICE_KEY=... \
GM_IT_DB_URL=... GM_IT_MAILPIT_URL=... GM_IT_SQL_DRIVER=supabase \
  npm run test:integration
GM_E2E_APP_URL=http://localhost:4317 GM_IT_DB_URL=... GM_IT_MAILPIT_URL=... \
GM_IT_SQL_DRIVER=supabase npm run test:e2e:local
```

`psql` is not installed on this machine, so owner SQL in tests/scripts uses
`supabase db query` (`GM_IT_SQL_DRIVER=supabase`) against the loopback database only
(`sslmode=disable` for that loopback connection alone). No hosted project was contacted
and no credential was committed.

## Actual final verification

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | no errors |
| `npm test` | 0 | **375 passed**, 42 integration tests skipped without stack variables (21 files passed, 3 skipped) |
| `npm run build` | 0 | built in ~1.1 s; 647.84 kB main JS / 181.02 kB gzip; existing >500 kB warning |
| `npm run test:integration` (local variables) | 0 | **42/42**, 3 files — includes 9 new real-database Phase 5 tests |
| `npm run test:e2e:local` (local variables) | 0 | **52/52** real Chromium + local Supabase checks |
| `git diff --check` | 0 | no whitespace errors |

### What the new checks actually prove

* **Unit (`src/tests/phase5.test.tsx`, 12 tests)** — narrow RPC calls with no actor/status
  forgery, safe error mapping (no database secrets leak), refusal to read protected data
  without a session, optimistic revision on review, no direct table writes, the production
  request form submitting and rendering persisted history, request-key retention on an
  uncertain (503) response, allow-listed notification links with owner-scoped mark-read,
  Arabic coverage for every Phase 5 key, and the camera lifecycle (unsupported, denied,
  release-after-unmount).
* **Database (`src/tests/integration/phase5.integration.test.ts`, 9 tests)** — only own-company
  admins may invite; direct membership writes are refused; four concurrent invitation retries
  converge to one id and one audit event; revocation is scoped, audited once, removes access
  and cannot revoke an admin; cancelled and expired invitations refuse acceptance and
  unrelated invitations stay private; materials and charter requests persist with retry
  safety, boundary validation, single-success concurrent review and private audit; a suspended
  reviewer is refused even with a valid JWT; a stale invitation cannot be accepted after the
  inviter loses authority; notifications are owner-only, generated once per event and
  mark-read cannot alter another user.
* **Browser (52 checks)** — the Phase 5 journeys run end to end against the real stack:
  invite → accept as `company_booker` → revoke → revoked member cannot submit; materials and
  charter submission, server reference, survival across reload, ATCO review with a reason, and
  the customer seeing a planning-only decision; notification links and read state persisting;
  camera unsupported and permission-denied fallbacks keeping manual validation usable; plus
  Arabic RTL on `/materials`, `/charters`, `/company/members` and `/notifications` at 390 px
  with no horizontal overflow and **no uncaught page errors**.

## Defects repaired in this checkpoint

* `src/i18n/translations.ts` was recovered from the Phase 4 checkpoint and the Phase 5 keys
  were appended: 918 → 985 keys in **both** languages, 67 new keys per language, **0 existing
  values changed and 0 removed** (verified programmatically against `HEAD`).
* The production request form's mandatory field label and the Phase 5 copy were aligned with
  the tests that consume them; the Phase 5 unit suite and the browser journey now agree.

## Limits and completion estimate

A weighted feature checklist, not file/test counts. Phase 4 scored 55/100; Phase 5 closes the
four feature areas it targeted.

| Area | Phase 5 | Remaining gap |
|---|---|---|
| Authentication / recovery | 10/10 | — |
| Company onboarding / ATCO review | 10/10 | — |
| Database role security | 8/10 | no staff lifecycle UI |
| Schedule / booking | 12/15 | no amendment or cancellation |
| Tickets | 8/10 | no paid-ticket policy; QR pixel decoding untested |
| Boarding / readiness | 7/10 | internal only; no permit/port integration |
| Materials requests | 5/7 | no attachments, allocation or pricing |
| Charter requests | 4/6 | no quote/pricing or allocation |
| Member management | 6/6 | — |
| Notifications | 4/4 | in-app only (no delivery channel) |
| Payments / refunds / invoicing / hosted readiness | 0/12 | not started |

**74/100, approximately 74% of this defined operational product scope — not 80% and not
production readiness.** Weights are an engineering estimate, not ATCO acceptance criteria.

## Still to confirm with ATCO

* Invitation expiry is a **provisional 7-day** technical window.
* Who may invite/revoke, and whether bookers may ever invite.
* The exact wording of request outcomes ("reviewed for planning" is deliberately not approval).
* Whether materials/charter requests need attachments, pricing, allocation to a sailing, or
  delivery tracking.
* Notification recipients and whether any channel beyond in-app is required.

## Next work before launch

Payments/refunds/invoicing, customer amendment/cancellation policy, re-review and readiness
invalidation after schedule or vessel edits, a staff lifecycle UI, hosted staging with
security review/backups/monitoring, and broader accessibility plus populated-data testing.
Camera decoding of rendered QR pixels, real-device/Safari behaviour and high-volume
performance remain unverified.
