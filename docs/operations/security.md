# Security, privacy and operational controls (Phase 8)

## Authorization model (enforced in the database)

| Role | Scope | Can see passenger data? |
|---|---|---|
| Individual customer | Own bookings, tickets, payments, invoices | Own only |
| Corporate admin / booker | Admin: organization's bookings, invoices, credit position, reports. Booker: own bookings | Organization only |
| Ship agent (admin/booker of an `agent` org) | Agent bookings with client attribution; own settlement statements | Agency only |
| `boarding_staff` | Ticket manifest (no contact details/QR secrets), boarding | Names on manifest only |
| `operations` | Schedules, sailings, checkpoints, materials/charters, operational reports | Yes (operational need) |
| `finance` | Tariffs, refunds, credit, invoices, settlements, financial reports | Booking-level financial records |
| `super_admin` | All of the above + settings, policies, privacy requests, MFA switch | Yes |
| `it_support` (new) | Health/diagnostics, message-delivery problems, retention policy view | **No** — proven by `phase8.operations.db.test.ts` |

Every RLS policy and staff RPC calls `has_platform_role` / `has_org_role`. UI menus only mirror
these rules; hiding a menu is never the control. The privilege sweep test asserts: RLS enabled on
every public table, every SECURITY DEFINER function pins `search_path`, nothing new is
executable by `anon` except `health_ping`, and the only table-level write grant to
`authenticated` is the Phase 1 self-service `profiles` row (RLS + status guard).

## Authentication, sessions and MFA

- Supabase Auth (email + password, email confirmation, password recovery via registered
  redirect). Sessions are short-lived JWTs with refresh-token rotation (`supabase/config.toml`).
- **Staff MFA**: `security.staff_mfa_required` (super_admin switch, audited). When on, staff
  roles apply only to sessions with `aal = aal2`, at the database boundary. Users enrol TOTP in
  **Privacy & security** (`supabase.auth.mfa`). Recommended: ON in staging and production
  before go-live; verify enrolment of every staff account first.
- Suspended profiles lose all roles immediately (same JWT), as tested since Phase 4.

## Audit history

- `config_audit` (append-only, trigger-written): tariffs, policies, platform settings, schedule
  templates, routes, vessels, schedule-relevant sailing fields, role assignments, organization
  credit/account-type fields, commission rules, retention policies, settlement decisions,
  account payments, privacy erasures — with actor, timestamp, before/after and reason.
- `booking_events`, `payment_events`, `payment_provider_events`, `sailing_readiness_events`,
  `sailing_checkpoint_events` (Master decision, port clearance, suspension, cancellation,
  minimum decision, no-show sweep), `boarding_events`, `transfer_request_events`,
  `approval_events`, `membership_events`.
- Four-eyes rules: tariff approval, refund approval, commission-rule approval and settlement
  approval require a different person from the proposer.

## Secrets

- Browser bundle: only the publishable Supabase key; validated at build (`check:env`) and at
  runtime (`src/lib/supabase.ts` rejects server keys).
- Server secrets (service role, provider keys, webhook tokens, messaging keys) live only in
  edge-function secrets per environment. None are in the repository (CI secret scan).
- Provider **test** keys are required in sandbox mode; live keys are refused unless
  `GM_PAYMENTS_LIVE_ENABLED=true` (production only).

## Error handling

- The UI never shows raw database text: errors are classified into a fixed vocabulary
  (`src/lib/dataService.ts`) and translated (EN/AR).
- Uncertain outcomes (network/5xx) keep the same idempotency key so retries cannot double-book
  or double-charge.
- Browser errors are reported (optionally) without personal data (`src/lib/monitoring.ts`).
- Edge functions log short reasons only; never provider responses or secrets.

## Privacy

See `docs/operations/privacy-and-retention.md`.
