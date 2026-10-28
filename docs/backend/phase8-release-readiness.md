# Phase 8 — Release readiness (implementation report)

Branch `feature/phase8-release-readiness`, based on Phase 7 `39f018a` (verified as the tip of
`origin/feature/phase7-atco-requirements`). Local disposable databases only; no hosted project,
DNS, cloud resource, real money, real messages or real credentials were touched.

## Baseline found (verified, not taken from earlier reports)

- `npm test` on `39f018a`: 376 passed, 79 skipped (the supabase-js suites skip without a stack).
- Phase 7 services for individual/agent booking, payments, tariffs and reports were **not used
  by any page**; the production UI showed no price, no payment and refused individuals.
- Defects found and fixed: Phase 7 seed created **zero return sailings** (unique
  `(vessel_id, departs_at)` collision); corporate `create_booking` recorded no fare (unpayable);
  boarding ignored payment state; revenue report double-counted return journeys and used UTC
  dates; materials form sent `weight` while the server accepts only `weight_kg`.

## Migrations (additive, forward-only)

| File | Scope |
|---|---|
| `20261101100000_phase8_config_tariffs_schedule.sql` | `config_audit`; versioned, immutable tariffs with VAT modes and four-eyes approval; exact VAT arithmetic; server quotes; validated settings RPC; Asia/Riyadh schedule templates + generator |
| `20261101100001_phase8_booking_operations.sql` | Engine v2 (individual/corporate/agent, pay-now/on-account, payload), per-leg pricing for every path, holds/expiry, minimum-sailing states, Master's decision, port clearance, suspension, sailing cancellation → refund review, no-shows, ticket revocation, rescheduling with QR rotation, payment-aware boarding gate |
| `20261101100002_phase8_payments_invoicing.sql` | Provider-independent payments, provider events (dedupe), verified result application, sandbox simulator, invoices + lines, gap-free numbering, credit notes, four-eyes policy-gated refunds, ZATCA-prep fields (ICV, PIH chain, Phase-1 QR), reconciliation |
| `20261101100003_phase8_credit_settlements.sql` | Credit activation/holds, balances, commission rules (inactive until approved), settlement statements |
| `20261101100004_phase8_materials_charters.sql` | Mandatory safety review, quotes from parameterised tariffs, payload-checked assignment, manifests, proof of delivery, private attachments, charter allocation |
| `20261101100005_phase8_comms_privacy_reports.sql` | IT-support role, staff MFA enforcement, notification preferences + outbox, privacy requests/export/erasure/legal holds/retention, health & diagnostics, management reports |

## Application

Pages: rewritten `/book`; booking detail payment/documents/lifecycle panels; `/invoices/:id`;
`/admin/finance`, `/admin/reports`, `/admin/sailings`, `/admin/system`; `/account`
(notifications, privacy, MFA); `/company/account`; materials/charter actions. All strings EN/AR.
Edge functions (not deployed): `payments` (sandbox, Moyasar, Tap adapters) and
`notifications-dispatch` (Resend, Unifonic, WhatsApp Cloud adapters).
Release: env checker, environment templates, CSP/security headers, PWA manifest + shell-only
service worker, monitoring hook, CI workflow, backup/restore drill.

## Not done / not claimed

Live payments, deployed edge functions, ZATCA Phase 2, real external messaging, hosted
backups/PITR, real-device and Safari testing, supabase-js integration suites and the browser
journey script against a full local stack (API images were unavailable here — Docker Hub
rate-limited and GitHub release binaries not permitted), formal accessibility audit.
See `docs/requirements-traceability.md` and `docs/test-results.md`.
