# ATCO decisions required before controlled launch

Companion to `docs/atco-pending-business-rules.md` (the full P1–P39 provisional
register — still the authority on each default; nothing there is approved).
This file is the Phase 10 launch checklist: each item states what the system
does today, what is tested, who must decide, and what stays disabled until
they do. Provisional values are engineering placeholders, never approvals.

## Commercial (Finance owns; launch-blocking where noted)

| # | Decision | System today | Tested? | Gate |
|---|---|---|---|---|
| D1 | Approve the passenger tariff (currently provisional SAR 500 / leg, VAT `not_configured`, no VAT charged) | `BASE-2026-ATCO-PENDING` tariff, editable by Finance, audited | Unit + browser (sandbox) | Charging real money needs an approved tariff; the code cannot set VAT itself |
| D2 | Refund / cancellation / no-show / weather policy text and amounts | `decide_refund` requires an approved policy + two-person flow; automatic refunds impossible by design | DB integration (local stack) | No live refunds until policy approved |
| D3 | Agent commission model (rates are 0 / inactive until approved) | Rules + four-eyes approval implemented; nothing accrues | Unit | Settlements stay zero-value until a rule is approved |
| D4 | Corporate credit policy (limits, terms, overdue handling) | Fields + Finance-only writers implemented; credit inactive until Finance activates per org | Unit + DB integration | On-account booking stays off per org until activated |
| D5 | Invoice / e-invoicing treatment (commercial invoice only; ZATCA Phase-1 QR fields prepared, nothing submitted) | `p8NotTaxInvoice` labelling; `zatca_*` helpers present | Unit | No tax-invoice claim until Finance + qualified review |

## Operational (Operations owns)

| # | Decision | System today | Tested? | Gate |
|---|---|---|---|---|
| D6 | Real routes, vessels, capacities, sailing schedule (demo: Ras Tanura↔anchorage, 07:00/09:30/13:00 + provisional +60 min returns) | `schedule_templates` + `generate_sailings` (ops-only) | Unit + browser (sandbox data) | No customer sailings until real schedule entered |
| D7 | Minimum-sailing rule meaning (counts paid + on-account tickets; deadline 24 h; below-minimum → ATCO decide) | Warning-only display; reaching it never clears a sailing | Unit + browser | Operational handling of below-minimum sailings |
| D8 | Boarding checkpoints and who records the Master's decision (system enforces paid + readiness + Master go + port clearance as separate gates) | `sailing_boarding_gate` fails closed; all decisions reasoned + audited | DB integration + browser | Boarding procedure sign-off |
| D9 | Materials carriage rules (every request needs safety review; dangerous goods need a permit reference; delivery proof = signature or photo) | Enforced in RPCs; tariffs provisional (SAR 5/kg, flat SAR 500, non-binding) | Unit + browser | Carriage/insurance rules before live materials |
| D10 | Company approval policy (who approves, conflict rules, whether rejection reasons are shared, individual booking eligibility) | super_admin decides; conflict-of-interest enforced; individuals cannot book in production | DB integration + browser | P11–P17 in pending-rules |
| D11 | Staff provisioning (platform roles are granted out-of-band by the DB owner; no in-app path) | `provision_platform_role.sql`; `system_diagnostics` super_admin/it_support | Reviewed, not live-tested | Authorisation process for staff accounts |

## Technical / hosting (platform owner owns)

| # | Decision | System today | Tested? | Gate |
|---|---|---|---|---|
| D12 | Production Supabase project, region, data residency, backup/PITR, retention periods | Only `GulfMover-Demo` (staging-like) exists; retention policies unset | Backup drill script exists, not run here | No production data until hosted |
| D13 | Payment provider + merchant onboarding (Moyasar/Tap adapters tested against mocks; sandbox only in-app) | Live mode kill-switched (`payments.live_enabled=false` default) | Unit (mocked HTTP) | Merchant account + secrets + staging verification |
| D14 | Notification providers (Resend/Unifonic/WhatsApp adapters; channels disabled by default) | Outbox + dispatch function; in-app only until configured | Unit | Provider accounts + sender IDs + staging delivery test |
| D15 | Auth hardening for production (leaked-password protection OFF on hosted; staff MFA flag off) | Flags/settings exist; enforcement points in code | Code review | Dashboard toggles by authorised owner |
| D16 | Domain, TLS, redirect URLs, error-reporting endpoint | `check-env.mjs` validates; nothing registered for production | Script unit-tested | Registration before staging |
| D17 | Physical-device verification (boarding camera, RTL on real devices, accessibility audit) | Camera path exists in demo; production uses manual entry | Not performed | On-device testing before operational use |

## What engineering cannot decide

 Tariff values, VAT, refund amounts, commission rates, credit terms, vessel
 capacities, sailing times, permit/clearance procedure, carriage law,
 retention periods, privacy wording. The system keeps every one of these
 configurable and inactive-by-default; turning any of them on is an ATCO act,
 not a code change.
