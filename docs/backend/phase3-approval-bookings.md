# Gulf Mover — Phase 3: ATCO approvals, role enforcement and the live booking foundation

> **Branch:** `feature/phase3-approval-bookings`, based on `feature/phase2-company-onboarding` @ `88b0ed6`.
> **Environment used:** a LOCAL Supabase stack only (Docker, `127.0.0.1`). No remote project was linked,
> no migration was pushed anywhere, nothing was deployed. This is **not** production approval.

## 0. Starting point — what was real vs. demo before this phase

| Area | Before Phase 3 |
|---|---|
| Sign-up / sign-in / sign-out / password recovery | Real Supabase code, tested with mocks only — never run against a real Auth server |
| Company registration (`register_company`) | Real RPC + UI; RPC tested locally in Phase 1 (T1–T7), UI only with mocks |
| Company approval | **Did not exist** for application users (console SQL only) |
| Rejected vs suspended visibility for members | Not distinguishable (A20 hid both) |
| Roles in the UI | A demo "customer / ATCO staff" switch with no real authority |
| Vessels, routes, sailings, bookings, manifests | **Demo data only** (`DemoContext`, `localStorage`) — no tables existed |
| Payments, tickets/QR, boarding, materials, charters, agent/corporate tools | Demo only |

## 1. Verification levels used in this document

| Level | Meaning |
|---|---|
| **U** — unit-tested | Vitest + React Testing Library with an in-memory Supabase fake. Proves UI wiring and contracts, **not** security. |
| **DB** — verified against the local database | `npm run test:integration`: real GoTrue (with Mailpit e-mail), real PostgREST, real PostgreSQL RLS/RPCs on a freshly reset local database. |
| **BR** — verified in a browser | `npm run test:e2e:local`: Chromium driving the app in production mode against the local stack. |
| **NR** — not tested against a remote environment | Applies to **everything** below: no hosted Supabase project was used. |

## 2. What was built

### 2.1 Migrations (additive; no earlier migration edited)

| File | Contents |
|---|---|
| `20261027120000_company_review.sql` | `review_company()` RPC; removes the raw `UPDATE` grant/policy on `organizations`; `my_company_memberships()` read RPC |
| `20261027121000_operations_bookings.sql` | `vessels`, `routes`, `sailings`, `bookings`, `booking_legs`; RLS + explicit grants; `create_booking()` RPC; guard and actor-stamping triggers |

Both apply cleanly in order on a clean database (`supabase db reset`, 10 migrations, **DB**).

### 2.2 ATCO company approval — U, DB, BR

* **Database:** `review_company(p_organization_id, p_decision, p_reason)` — `SECURITY DEFINER`, `search_path = ''`,
  `EXECUTE` for `authenticated` only (explicitly revoked from `public`, `anon`, `service_role`).
  * Identity from `auth.uid()`; authority = active platform role **`super_admin`** (matches the Phase 1 matrix —
    `operations` can read organisations but cannot decide).
  * The reviewer must have an **active profile** (see §5.1) and must not belong to / have created the organisation.
  * Transitions: `pending → approved`, `pending → rejected` (reason 1–500 chars required). The same decision again →
    `unchanged` with **no** write and **no** event; anything else → SQLSTATE `55000`. Row lock (`FOR UPDATE`) makes
    concurrent reviews safe (5 parallel approvals → 1 `decided`, 4 `unchanged`, exactly one audit event — **DB**).
  * The existing audit trigger writes the event (actor = reviewer); the existing stamp trigger sets `approved_by/at`.
  * The direct `UPDATE` grant and `organizations_update_super_admin_only` policy were **removed**, so a raw PATCH
    cannot bypass these rules (tested for both a company admin and a super_admin — **DB**).
* **UI (`/admin/companies`):** status tabs, name search (escaped `ILIKE`), 20-per-page pagination, detail panel with
  exactly the stored registration fields and the audit history, approve / reject-with-reason, in-flight guard,
  success/unchanged/refusal/uncertain messages, loading/empty/error states, English/Arabic, mobile layout.
  Decision buttons are shown only to `super_admin`; `operations` sees a read-only view.

### 2.3 Restricted-state visibility — U, DB, BR

`my_company_memberships()` returns, for the caller only, their memberships with organisation name and status
(including `rejected`/`suspended`) and **no** rejection reason or approval metadata. Onboarding now distinguishes
*pending / approved / rejected / suspended / membership restricted / invited*. A rejected member sees "Registration not
approved by ATCO" without the internal reason (**BR**), and other organisations never appear (**DB**).

### 2.4 Real role enforcement — U, DB, BR

* The **database** is the boundary: RLS + definer RPCs + column grants (see §3).
* The UI no longer offers the demo staff switch in production. ATCO navigation entries and screens appear only when the
  **server-read** `role_assignments` (own rows, under RLS) include the required role; otherwise the screen shows
  "ATCO staff access required" and issues no admin query (**U**, **BR**).
* Demo-only modules (`/corporate`, `/operations`, `/boarding`, `/materials`, `/fleet`) render an honest
  "Not connected in this build" screen in production instead of demo actions.

### 2.5 Live booking journey — U, DB, BR

Traced end to end: browse sailings → choose outbound (and optional return on the reverse route) → passengers/contact →
`create_booking` → server reference → My bookings → reopen detail.

* **Who may book:** active `company_admin`/`company_booker` members of an **approved** organisation, with a non-suspended
  profile. Pending/rejected/suspended companies, non-members and other companies' bookers are refused by the RPC (**DB**).
* **Integrity:** sailing rows locked in id order; `CHECK (seats_booked <= seat_capacity)` makes oversell impossible even
  for a buggy caller; 10 parallel one-seat requests on a 5-seat sailing → exactly 5 succeed (**DB**). Outbound + return
  are reserved atomically — a full return sailing leaves the outbound untouched (**DB**).
* **Idempotency:** client request key per attempt, kept in `sessionStorage` until the server confirms; same key + same
  payload → `replayed` (6 concurrent retries → one booking, seats counted once — **DB**); same key + different payload →
  `payload_mismatch`.
* **Server-generated** reference `GM-XXXXXXXX`; the browser never sends a status, price, payment or user id.
* **Visibility:** creator; `company_admin` of that (approved/pending) organisation; ATCO `super_admin`/`operations`.
  A `company_booker` sees only their own bookings; another company's users see nothing (**DB**). Nobody can update or
  delete bookings directly (**DB**).
* **No payment claims:** there is no price, VAT, payment or paid column; the UI says "No price is shown and no payment is
  taken" and shows payment / sailing clearance / boarding as "Not connected yet" (**U**, **BR**).
* The 4-ticket minimum (CLAUDE.md business rule) is shown per sailing from the server's `seats_booked` as information only.

### 2.6 ATCO operations — U, DB, BR

`/admin/operations` (super_admin, operations): vessel register (name, optional passenger capacity — "not recorded" until
ATCO supplies it), one-way routes, sailing schedule (route, vessel, Saudi-local date/time → stored as UTC, seats offered,
status open/closed/cancelled), and the reservations on each departure (one embedded query). Database guards: seats offered
cannot exceed a recorded vessel capacity or fall below seats already reserved; cancelled is terminal; route/time cannot
change once seats are booked; inactive vessels/routes cannot get new sailings; no deletes. Nothing is pre-seeded.

### 2.7 Other fixes made along the way

| Fix | How it was found |
|---|---|
| Reviewer without a profile made every approval fail (`organizations.approved_by` FK → `profiles`) — now a clear `reviewer_profile_missing` refusal + provisioning procedure | **DB** test |
| `isValidTime()` (pre-existing, `src/domain/dates.ts`) returned `false` for every time (missing capture group) | U test of the new schedule form |
| Staff "My bookings" queried before roles were known and could briefly list everyone's bookings | U test |
| Company review screen overflowed horizontally on 390 px phones | BR check |
| Demo booking showed the raw key `noCapacity` (missing translation, pre-existing) | translation key audit |
| Production reset button said "Send reset code" while sending a link; production banner said booking data was demo | review of screenshots |
| `src/tests/setup.ts` assumed a DOM, blocking node-environment test files | integration suite |

## 3. Enforced at the database level (each line **DB**-tested)

* `anon`: no privilege on any of the 11 app tables and no EXECUTE on the 7 app functions (catalog check with `has_table_privilege`/`has_function_privilege`; API reads refused for 8 tables and the RPCs in the suite).
* Nobody can insert/update `role_assignments`, `approval_events` or forge memberships through the API; a super_admin
  cannot edit other staff roles from the app.
* Only `super_admin` can approve/reject; not operations, not a company admin, not for their own organisation.
* Only `super_admin`/`operations` can write vessels/routes/sailings; `seats_booked` has no column privilege.
* Bookings only via `create_booking` with membership + approval + capacity + idempotency checks.
* Booking/leg visibility as in §2.5.

## 4. Local testing (how to reproduce)

1. Docker + Supabase CLI (2.122 used). This environment could not pull from `public.ecr.aws`/`ghcr.io`, so the stack
   was started with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` and `experimental.stack = false` in a **scratch copy**
   of `supabase/config.toml` (the committed file is unchanged; see §6 for its findings). Services excluded: studio,
   realtime, storage, imgproxy, edge-runtime, logflare, vector, supavisor, postgres-meta.
2. The scratch config also set `enable_confirmations = true`, raised the local e-mail rate limit and allowed the
   `/auth/reset-callback` redirect URLs — to exercise the confirmation and recovery flows a hosted project would use.
3. Export from `supabase status -o env` (values stay on your machine; never commit them):
   `GM_IT_SUPABASE_URL=$API_URL GM_IT_ANON_KEY=$ANON_KEY GM_IT_SERVICE_KEY=$SERVICE_ROLE_KEY GM_IT_DB_URL=$DB_URL GM_IT_MAILPIT_URL=$MAILPIT_URL`.
   The suites refuse to run unless every URL is a loopback address. The service key is used only to create confirmed
   throw-away users in tests.
4. `npm run test:integration` — 24 real-stack tests.
5. Start the app in production mode against the stack (`VITE_APP_MODE=production`, `VITE_SUPABASE_URL=$API_URL`,
   `VITE_SUPABASE_ANON_KEY=$ANON_KEY`, `VITE_AUTH_RESET_REDIRECT_URL=http://localhost:4317/auth/reset-callback`,
   `npx vite --port 4317`) and run `GM_E2E_APP_URL=http://localhost:4317 npm run test:e2e:local`
   (`GM_E2E_CHROMIUM` may point at a pre-installed Chromium).

## 5. Administrator provisioning (trusted procedure)

There is **no** application path to obtain a platform role. `supabase/scripts/provision_platform_role.sql` is run by the
project owner as the database owner after ATCO confirms the person's identity and authority; it requires exactly one
confirmed auth user, creates the profile (needed by `review_company`) and the role, inside one transaction. Tested
locally: a valid user is provisioned; an unknown e-mail aborts with no write. Super_admin rows remain immutable from the
application (`guard_role_hierarchy`). **Owner decision needed:** who in ATCO authorises provisioning and how it is logged.

### 5.1 Owner configuration still to set manually (hosted project)

* Auth → URL configuration: site URL and `https://<origin>/auth/reset-callback` redirect.
* Auth → e-mail: confirmations on (recommended), SMTP provider, rate limits, templates (English/Arabic).
* `VITE_APP_MODE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_AUTH_RESET_REDIRECT_URL` at build time.
* Apply migrations through the normal reviewed pipeline (not done here), then provision the first super_admin (§5).

## 6. Findings about the committed local configuration (not changed)

* `[db.seed] sql_paths = ["./seed.sql"]` but the repository file is `seed_demo.sql` → the seed never loads on reset.
* `[auth.email] enable_confirmations = false` locally; production behaviour depends on the hosted project.
* `additional_redirect_urls` does not include `/auth/reset-callback`; `email_sent = 2`/hour blocks repeated local tests.
* `[experimental] stack = true` makes the CLI fetch images from `ghcr.io`.

## 6a. Known minor exposures / open security items

* `vessels`, `routes` and `sailings` are readable by every signed-in user, including the `created_by`/`updated_by`
  columns (ATCO staff auth user ids). Not personal data in itself, but a column-restricted view would be tidier.
* Profile suspension blocks `register_company`, `create_booking` and `review_company`, but `has_platform_role()` does
  not consider profile status, so a suspended staff profile with an active role keeps RLS read access until its role is
  also suspended. Revocation procedure: suspend the role assignment (§5).
* A company admin of a *pending* organisation can already add bookers (existing Phase 1 policy); they still cannot book
  until approval.
* The integration and browser suites ran on a local stack only; rate limits, SMTP, TLS and hosted Auth settings were
  not exercised.

## 7. Still demo-only or not implemented

Payments, fares/VAT, invoices, refunds/cancellations, tickets/QR and Wallet passes, boarding/check-in, manifests export,
materials requests, charters, agent/corporate credit tools, member invitations/acceptance, company-detail edits,
suspension/reinstatement workflow, profile/notification settings, individual (non-company) bookings, booking
cancellation, ATCO staff management UI, audit log for vessel/route/sailing edits (only `created_by`/`updated_by`).

## 8. Next milestone before any production launch

1. ATCO decisions in `docs/atco-pending-business-rules.md` §4 (who may book, cancellation/refund, fares, roles).
2. Payments with a real provider and server-verified payment records, then tickets and boarding against real bookings.
3. Hosted staging project: apply migrations via CI, re-run the integration and browser suites there, security review /
   penetration test, backups and monitoring.
