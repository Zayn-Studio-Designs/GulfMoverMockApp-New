# ATCO requirements traceability — Phase 8 (release readiness)

Branch `feature/phase8-release-readiness`, based on Phase 7 `39f018a`.
Evidence keys: **DB** = real PostgreSQL tests as the actual app roles (`src/tests/db`, 40 tests incl.
upgrade); **UT** = unit/component tests (`npm test`); **UI** = stubbed-network browser rendering
check (`scripts/e2e/ui-phase8-stubbed.mjs`, 153 checks); **IT** = supabase-js integration suites
(`src/tests/integration`, require a full local Supabase stack — **not run in Phase 8**, see test results);
**Drill** = backup/restore drill.

Status values: ✅ Implemented & verified · 🟡 Implemented, not fully verified · 🟠 Partial ·
⛔ Not implemented · 🔒 Blocked by external dependency/approval.

## 1. Customers and accounts

| Requirement | Status | Implementation | Evidence | Remaining dependency |
|---|---|---|---|---|
| Individuals book without registering a company | ✅ | `create_individual_booking` → `_reserve_booking_v2`; `/book` "Book as: Individual"; onboarding offers individual booking first | DB, UT (phase3Production), UI | — |
| Corporate accounts, multiple users, org-scoped data | ✅ | memberships, admin vs booker visibility (Phase 2–5) + `create_organization_booking` | DB, IT (Phase 6, earlier) | — |
| Ship agents book for clients with attribution; access restricted | ✅ | `account_type='agent'`, `client_name/reference`, agent org = booking org; stranger isolation | DB | Agent onboarding = ATCO marks org as agent (`set_organization_account_type`) |
| PO references, billing details | ✅ | `po_reference`, buyer snapshot on invoices | DB | — |
| No duplicate account systems; isolation not weakened | ✅ | single Supabase identity; privilege sweep | DB | — |

## 2. Schedules, fares, minimum sailing

| Requirement | Status | Implementation | Evidence | Remaining |
|---|---|---|---|---|
| Ras Tanura Service Pier → anchorage; separate return sailings | ✅ | seeded routes + `schedule_templates`; **fixed Phase 7 defect: 0 return sailings existed** | DB | Real destinations/vessels from ATCO |
| 07:00 / 09:30 / 13:00 Asia/Riyadh, ATCO-editable | ✅ | templates + `generate_sailings` (Riyadh local); `upsert_schedule_template` audited | DB, UI | Return times are provisional (+60 min) 🔒 ATCO |
| SAR 500 per passenger per one-way leg, VAT excluded unless tariff says otherwise | ✅ | versioned `tariffs` (immutable amounts, four-eyes approval), `vat_mode` | DB, UT | 🔒 Finance to approve tariff + VAT |
| Server-side exact money, browser cannot alter fare/VAT/total | ✅ | integer halala, `quote_passenger_fare`, `_price_booking`; no write grants | DB | — |
| Minimum 4 tickets or SAR 2,000 across all bookings per sailing (configurable) | ✅ | `sailing_commercial_status` (qualifying = paid/on-account by default; configurable basis) | DB | 🔒 ATCO confirms counting basis |
| Distinct states: awaiting payment / paid / awaiting minimum / minimum met / cleared / suspended-cancelled | ✅ | booking.status, payment_status, commercial_state, boarding gate, sailing.status | DB, UI | — |
| Minimum never grants clearance | ✅ | gate requires readiness + Master + port checkpoints | DB | — |
| Confirmation deadline + safe below-minimum workflow (no automatic refunds) | ✅ | `booking.confirmation_deadline_hours`, `decide_sailing_minimum` (proceed / cancel → refund review) | DB | 🔒 ATCO policy for outcome |

## 3. Booking engine and lifecycle

| Requirement | Status | Implementation | Evidence | Remaining |
|---|---|---|---|---|
| Outbound + return in one checkout; separate schedules, capacity, tickets, status | ✅ | two legs, per-leg tickets/commercial status/gate | DB, UI | — |
| No overbooking under concurrency; idempotent retries; payload mismatch rejected | ✅ | row locks, advisory locks, request keys | DB (6 concurrent bookers) | — |
| Payment hold & expiry releasing seats | ✅ | `hold_expires_at`, `expire_stale_holds` | DB | Scheduler on hosted project |
| Amendments, cancellations, rescheduling with validated transitions & cut-off | ✅ | `amend_booking`, `cancel_booking`, `reschedule_booking_leg` (rotates ticket secrets) | DB, UI | 🔒 cut-off hours provisional |
| Versioned policies; record versions accepted | ✅ | `service_policies`, `policy_versions` on booking, terms checkbox | DB, UT | 🔒 policy texts need approval |
| No-show, weather, suspension, waiting time policies | 🟠 | no-show recording, suspension/resume, weather via cancel/reschedule; waiting-time **policy record only** | DB | 🔒 waiting-time charges need approved policy |

## 4. Payments

| Requirement | Status | Implementation | Evidence | Remaining |
|---|---|---|---|---|
| Provider research & recommendation | ✅ | `docs/payments-and-einvoicing.md` | — | ATCO commercial choice |
| Provider-independent adapter; Moyasar + Tap + sandbox | 🟡 | `supabase/functions/_shared/payments` | UT (mocked HTTP) | 🔒 provider sandbox keys to test against real APIs |
| Secure checkout initiation, server-side transaction | ✅ | `begin_checkout` | DB | — |
| Verified status, signed/authenticated webhooks, duplicate protection, re-fetch | 🟡 | handler + `apply_payment_result` | UT + DB | Edge function not deployed (no credentials) |
| Idempotent payments & refunds, reconciliation, receipts, audit | ✅ | idempotency keys, unique in-flight, provider events, reconciliation report | DB | — |
| Browser callback never proof; no card storage | ✅ | by design + tests | DB, UT | — |
| mada / Visa / Mastercard / Apple Pay live, settling to ATCO account | 🔒 | method selection implemented | — | Merchant account, Apple Pay domain, authorisation |

## 5. Invoices, VAT, credit, settlements

| Requirement | Status | Implementation | Evidence | Remaining |
|---|---|---|---|---|
| Itemised invoices, receipts, credit notes, refunds, numbering, audit | ✅ | `invoices`/`invoice_lines`/`credit_notes`/`refunds`, gap-free counters | DB | — |
| Downloadable invoice documents | ✅ | print view (EN/AR) + PDF | UT, UI | — |
| No false paid invoice from unpaid/mock transactions | ✅ | pay-now invoice only after verified payment; sandbox flagged | DB | — |
| VAT via approved tariff; exact rounding | ✅ | `vat_breakdown`, per-line rounding | DB | 🔒 VAT treatment decision |
| ZATCA e-invoicing | 🟠 | Phase-1 QR TLV, ICV, PIH chain, UUID; not submitted | DB, UT | 🔒 VAT registration, FATOORA onboarding, CSID |
| Corporate credit: limits, terms, balances, overdue control, holds/releases, audited, not self-editable | ✅ | `set_organization_credit`, `set_credit_status`, `_credit_position`, on-account bookings | DB | 🔒 Finance approves facilities |
| Agent settlements: trips, revenue, VAT, charges, refunds, commission, adjustments, net, approval | ✅ | `agent_settlements`, rules inactive until approved, four-eyes | DB | 🔒 commission rates |

## 6. Materials and combined bookings

| Requirement | Status | Implementation | Evidence | Remaining |
|---|---|---|---|---|
| Description, quantity, weight, dimensions, volume, category, destination, sender/receiver, handling | ✅ | validated `details` (fixed UI defect: weight key) | DB | — |
| Photos/documents in private storage with validation | 🟡 | private bucket, path-scoped storage RLS, `register_request_attachment` | DB (registration/RLS functions) | Upload path not exercised against Storage API here |
| Configurable tariffs (destination, weight, size, category, handling) and quotes | ✅ | `material_tariffs` + `quote_material_request` | DB | 🔒 rates approval |
| Approval/rejection, delivery records with signature/photo per policy | ✅ | `review_transfer_request`, `record_delivery` | DB | 🔒 proof policy |
| Payload limits for combined passenger/material | ✅ | `assign_material_to_sailing`, optional passenger allowance | DB | 🔒 vessel payload figures |
| Hazardous never auto-accepted | ✅ | mandatory staff safety review for every request; permit ref for dangerous goods | DB | 🔒 legal/permit rules |

## 7. Charters

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| Request, view, status, staff decisions, history | ✅ | DB (Phase 5/7) | — |
| Confirmed only with approval + conflict-free allocation | ✅ | DB | 🔒 charter pricing policy |

## 8. Operations, clearance, boarding

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| Schedules, vessels, capacity, manifests (passenger + material) | ✅ | DB, UI | — |
| Readiness, Master's decision, port clearance checkpoints with who/when/why | ✅ | DB | 🔒 official port permit integration (none exists) |
| Suspension/amendment, cancellation with refund review | ✅ | DB | — |
| Boarding blocks invalid/revoked/cancelled/used/unpaid tickets; one-time under concurrency | ✅ | DB (3 concurrent scans) | — |
| QR camera on physical devices, Safari, operational devices | 🔒 | — | Real devices required |

## 9. Notifications

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| In-app notifications for booking, payment, tickets, sailing changes, refunds, requests, boarding | ✅ | DB | — |
| Email/SMS/WhatsApp adapters, outbox, dedupe, retries, delivery status, consent, staff visibility | 🟡 | DB + UT | 🔒 provider accounts, Sender ID, WhatsApp templates |
| Never claim sent when only queued | ✅ | DB | — |

## 10. Administration, reports, exports, RBAC

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| Occupancy, passengers, materials, revenue by trip/destination, customer/corporate activity, payments/refunds, cancellations, balances, settlements; daily/monthly | ✅ | DB, UI | — |
| CSV (Excel-compatible) and PDF exports | ✅ | UT, UI | — |
| Roles: ATCO admin, operations, finance, boarding, IT support, corporate admin, agent, individual; least privilege at DB | ✅ | DB privilege sweep | — |
| Audit of fares, schedules, approvals, refunds, credit, permissions | ✅ | DB | — |

## 11. Privacy and security

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| Export/access requests, erasure with financial-record safeguards, legal holds | ✅ | DB | 🔒 legal review |
| Configurable retention (no invented periods) | ✅ | DB | 🔒 periods |
| Privileged-user MFA | ✅ (DB enforcement) / 🟡 (enrolment UI) | DB, UI | Enrolment untested against live Auth |
| Support staff cannot see passenger data | ✅ | DB | — |

## 12. Infrastructure and release

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| Env validation, dev/staging/prod templates | ✅ | UT | — |
| Security headers/CSP, PWA | ✅ | UT, UI | Host-specific deployment |
| Health checks, diagnostics, monitoring hook | ✅ | DB, UT | Collector account |
| CI (typecheck, tests, build, DB, upgrade, drill, secret scan) | 🟡 | workflow written; not executed on GitHub yet | First CI run |
| Backup & restore tested | ✅ (local drill) / 🔒 (hosted PITR) | Drill | Hosted project |
| Clean install + upgrade path | ✅ | DB | — |
| Deployment, rollback, migration sequencing docs | ✅ | docs/operations | — |
| Hosted Supabase, DNS, production deploy | 🔒 | — | Authorisation + credentials |

## 13. Accessibility, design, devices

| Requirement | Status | Evidence | Remaining |
|---|---|---|---|
| Responsive phone/tablet/desktop, no horizontal overflow (new pages) | ✅ | UI (fixed one phone overflow) | — |
| English/Arabic, RTL | ✅ | UT (425 key checks), UI | Native-speaker review |
| Labels on all form controls (new pages) | ✅ | UI | Screen-reader test |
| Keyboard focus, contrast audit | 🟡 | existing styles; not audited with tooling this phase | Accessibility audit |
| Real iPhone/Android/Safari | 🔒 | not performed | Devices |
| Native apps | ⛔ (out of scope) | — | Separately quoted |
