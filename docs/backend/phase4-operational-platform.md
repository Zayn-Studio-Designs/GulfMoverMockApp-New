# Phase 4 — verified tickets, boarding and internal readiness checkpoint

## Starting point and scope

Base: checkpoint `b832ce2ca65fe4086763ddcdd68c0a829657f692`, with Phase 3 ancestor
`dad61984f5d1852a586b6d4b5cf174dfe5395b02`. Implementation branch:
`feature/phase4-operational-platform-build`. The branch already existed locally at
that exact checkpoint when this continuation began; it was reused, not overwritten.
Only pre-existing tracked modification was `.freebuff/project-id`, left untouched.

Completed this session: Priority A, reservation tickets (B), manual boarding/manifest (C),
and a deliberately limited internal readiness workflow (D). E–H are NOT implemented.
No hosted Supabase project was contacted, configured or deployed.

## Security/configuration

- Additive `20261028100000_access_hardening.sql`: `has_platform_role`, `has_org_role`
  and `active_org_ids` deny suspended profiles; revoked role/membership statuses remain
  denied. The old profile-status trigger's raw-role self-reactivation loophole is closed.
- Schedule table SELECT is column-limited: no customer-visible created_by/updated_by.
  Services and tests must select explicit allowed columns, not `*`.
- Frontend role navigation also suppresses suspended-profile roles. Database checks,
  not navigation, are authoritative; existing pages may require refresh after revocation.
- Local config requires email confirmation, allows exact loopback recovery callbacks,
  and raises LOCAL Mailpit email quota. Seed points to `seed_demo.sql` but is disabled
  on automatic reset: that legacy manual fixture requires five existing Auth users.
  It must not run before those users exist. No weakening of confirmation for tests.
- Hosted SMTP, site URL, HTTPS redirect allow-list, rate limits and first staff
  provisioning remain a separate reviewed operator task.

## Tickets and boarding

`20261028101000_tickets_boarding_readiness.sql` creates tickets and two audit tables.
The existing booking RPC/signature is unchanged. An AFTER INSERT booking-leg trigger
issues tickets within the booking transaction; unique (leg, passenger index) prevents
retry duplication. Existing reserved legs are backfilled. Outbound/return are separate.
Only collected names are used; missing names remain NULL. No payment state is invented.

Ticket reference: 96 random bits. QR: `GMT1:` plus a 256-bit random token, no PII.
Only the booking creator may SELECT their tickets or call `get_ticket_qr`; token
column SELECT is not granted. Company administrators viewing a colleague's booking
cannot retrieve its tickets. UI fetches QR on demand without browser persistence/logging.
Treat references/QR as private: possession is not identity verification.

Staff manifest RPC exposes ticket/booking references, passenger name/index, leg and
boarding status only. `super_admin`, `operations`, `boarding_staff` may use it and
`board_ticket`. Raw ticket/audit writes are denied. Boarding locks the sailing then
ticket, checks readiness/cancellation/wrong sailing/duplicate status, updates once and
writes one protected actor-stamped event. Role/profile locks protect in-flight decisions
against concurrent suspension. Eight concurrent requests produced one boarding and
seven already-boarded results, with exactly one audit actor/event in the real database.

`set_sailing_readiness`: super_admin/operations only, explicit pending/ready/blocked,
reason 1–500 chars, locked sailing, no duplicate event on repeated state. This is
INTERNAL tracking, not a legal permit or official clearance. Boarding requires ready;
four reserved tickets is a warning only. ATCO must confirm the operational gate.
No override, customer cancellation, identity/permit integration or payment bypass.
Camera scanning is explicitly not connected; manual reference or pasted QR is supported.

## UI

Production booking detail shows owner tickets/private QR, real ticket status and an
explicit “No real payment made” notice. `/boarding` and `/admin/boarding` show the
role-guarded manifest, server boarding and internal readiness/history. Production
navigation includes the desk for real roles. English/Arabic keys and RTL preserved.
Demo routes remain separate and work offline. E–H retain honest not-connected screens.

## Local reproduction

The installed CLI supports **native** stacks; Docker and system psql were absent.
A NEW isolated stack `gm-phase4-build` ran PostgreSQL, Auth, REST and Mailpit.
All 12 migrations were present in its clean database (10 baseline + 2 additive).
No unrelated local stack was reset. CLI-managed runtime files live outside the checkout;
only CLI commands managed them, no direct reading/editing of those files.

```bash
npm run typecheck
npm test
npm run build
git diff --check
# Native CLI version used here supports these flags (check your CLI --help):
supabase start --stack gm-phase4-build --runtime native \
  --exclude realtime,storage,functions,studio,analytics,pooler --frozen
# Obtain credentials locally with supabase status --stack gm-phase4-build --env.
# Never commit the output; never put the service key in VITE_* variables.
# Set GM_IT_SUPABASE_URL, GM_IT_ANON_KEY, GM_IT_SERVICE_KEY,
# GM_IT_DB_URL, GM_IT_MAILPIT_URL from that LOCAL stack.
GM_IT_SQL_DRIVER=supabase npm run test:integration
# Start Vite in production app mode with the LOCAL public key and explicit callback:
# VITE_APP_MODE=production VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=...
# VITE_AUTH_RESET_REDIRECT_URL=http://localhost:4317/auth/reset-callback
npm run dev -- --host 127.0.0.1 --port 4317 --strictPort
GM_IT_SQL_DRIVER=supabase GM_E2E_APP_URL=http://localhost:4317 npm run test:e2e:local
```

Native SQL driver uses `supabase db query` JSON instead of psql (loopback only,
sslmode=disable only for that loopback connection). Docker/psql remains the default.
Existing browser script now captures screenshots only if explicitly requested via
`GM_E2E_CAPTURE_SCREENSHOTS=1`; none were taken in this session.

## Actual final verification

| Command | Exit | Result |
|---|---:|---|
| npm run typecheck | 0 | no errors |
| npm test | 0 | 363 passed, 33 integration tests skipped without stack variables; 20 files passed, 2 skipped |
| npm run build | 0 | 630.00 kB main JS; existing >500 kB warning |
| npm run test:integration with local variables | 0 | 33/33, 2 files (24 existing + 9 new) |
| npm run test:e2e:local with local variables | 0 | 35/35 Chromium checks, real local stack |

New DB checks cover suspended/revoked staff, suspended company helpers, private schedule
columns, issuance/retries, uncollected names, QR privacy, ownership, customer refusal,
manifest access, pending/blocked/wrong/cancelled states, concurrent scans and actor audit.
Browser covers existing confirmation/approval/booking/reset journeys plus four tickets
for two passengers/two legs, private QR rendering, readiness refusal then successful
boarding, duplicate refusal, persisted status after refresh, Arabic phone ticket and desk
DOM/no overflow. No uncaught page errors. Camera decoding was NOT tested.

Baseline failures repaired: ES2020-incompatible Array.at test usage; unbounded worker
contention caused two UI timeouts (targeted serial run passed; bounded two-worker suite
passes). Existing tests updated where the intended feature contract changed: explicit
schedule columns, connected boarding route, new honest status wording. No tests removed.

## Limits and completion estimate

A weighted feature checklist, not file/test counts: authentication/recovery 10/10;
company onboarding/review 10/10; role security 8/10 (no staff lifecycle UI);
schedule/booking 12/15 (no amendment/cancellation); tickets 8/10 (no paid-ticket policy,
no camera decoding); boarding/readiness 7/10 (internal only, no permit integration);
materials 0/7; charters 0/6; member management 0/6; notifications 0/4;
payments/refunds/invoicing/hosted operational readiness 0/12. **55/100, approximately
55% of this defined operational product scope, not 80% or production readiness.**
Weights are an engineering estimate, not ATCO acceptance criteria.

Remaining: E–H, payment/invoice/refund provider work, customer cancellation policy,
re-review/readiness invalidation after schedule/vessel edits, hosted staging/security
review/backups/monitoring, broader browser/accessibility testing. Ticket backfill is
present but not separately exercised against a populated pre-Phase-4 snapshot. Boarding
uses whole-sailing locks (safe, serialises scans); high-volume performance unmeasured.
QR displayed as SVG was browser-tested; decoding the rendered pixels was not.
