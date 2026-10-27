# Phase 7 — ATCO requirements traceability

Base: `feature/phase6-verification-hardening` @ `55f2856d2371bba1d21f7586d50a73cf0b74832f`.
Scope: original ATCO technical/commercial requirements. Status values: Implemented / Partial / Missing / Pending-ATCO.

## 1. Customers and accounts

| ATCO requirement | Status | Evidence / gap |
|---|---|---|
| Individual customers can book without a company | Missing | `create_booking` requires active company_admin/booker of approved org (P15). `role_assignments` already allows platform `individual_customer` role but no booking path uses it. **Phase 7: add.** |
| Corporate accounts, multiple users, org-scoped data | Implemented | orgs, memberships, invitations, company_admin vs booker visibility. Verified Phase 5/6. |
| Purchase-order references, billing details | Partial | `po_reference` stored; no invoice, no billing profile. **Phase 7: invoices.** |
| Ship agents booking on behalf of clients | Partial | `agent` role exists in role matrix but no booking path or attribution. **Phase 7: add.** |
| Agent commissions / settlement | Missing | No model. **Phase 7: foundation tables, inactive rates.** |
| Credit limits, payment terms, overdue controls | Missing | No model. **Phase 7: foundation, inactive enforcement.** |

## 2. Routes, schedules, fares, minimum sailing

| Requirement | Status | Evidence / gap |
|---|---|---|
| Ras Tanura Service Pier → anchorage/vessels; separate return availability | Partial | Generic routes/sailings exist; no seeded ATCO route or schedule. **Phase 7: seed.** |
| Departures 07:00 / 09:30 / 13:00 Asia/Riyadh, ATCO-editable | Partial | Sailings editable by ops; no seeded times, no timezone helper. **Phase 7: seed + helper.** |
| Fare SAR 500 per person per one-way leg, excl. VAT unless approved | Missing | No fare/price anywhere (P20). **Phase 7: tariff table, minor units.** |
| Money in exact minor units, no float | Missing | **Phase 7: halala integers.** |
| Minimum 4 tickets OR SAR 2,000 revenue, evaluated per sailing | Partial | Count warning only (P23); no revenue concept. **Phase 7: configurable thresholds + evaluator.** |
| Reservation vs paid vs threshold vs operational vs suspended states | Missing | Only `reserved` exists. **Phase 7: status separation.** |
| Configurable confirmation deadline, cancellation/refund/reschedule policy | Missing | No policy. **Phase 7: versioned policies, provisional defaults marked pending.** |

## 3. Booking lifecycle

| Requirement | Status | Evidence |
|---|---|---|
| Passenger/destination details, vessel name/IMO, permit status | Partial | Names, contact, PO stored; no vessel/IMO/permit fields. **Phase 7: add optional fields.** |
| Electronic tickets | Implemented | Per-leg tickets, QR, verified Phase 4/6. |
| Amendments | Missing | **Phase 7: amend RPC (names/contact/PO, re-validate).** |
| Cancellations / rescheduling | Missing | **Phase 7: cancel RPC with policy check, seat release.** |
| Versioned terms acceptance with timestamp | Missing | **Phase 7: terms table + acceptance on booking.** |
| Return legs separate tickets/capacity, atomic, idempotent | Implemented | Verified. Preserve. |

## 4. Payments, invoices, refunds

| Requirement | Status | Plan |
|---|---|---|
| mada / Visa / Mastercard / Apple Pay into ATCO account | Missing | No code. Phase 7: provider-independent tables + sandbox provider, no real money. |
| Initiation, verified result, reconciliation, audit, retries | Missing | Phase 7: `payments` + `payment_events`, server-side status only. |
| Refunds, credit notes, receipts, invoices | Missing | Phase 7: tables + invoice numbers, PDF later. |
| No client callback as proof; no raw card storage | n/a | Enforced by design. |
| Saudi provider research | Missing | Phase 7: document recommendation, no credentials. |

## 5. Materials, operations, reports, policies, notifications

| Requirement | Status | Plan |
|---|---|---|
| Materials fields (desc, qty, weight, dims, photos, destination, sender/receiver, handling) | Partial | `details` JSON allows subset; no photos, no hazardous control. Phase 7: extend allowed keys + validation. |
| Material tariffs, suitability, delivery records | Missing | Phase 7: tariff + delivery tables, provisional. |
| Restricted/hazardous never auto-approved | Implemented (principle) | Statuses are planning-only; keep. |
| Reports (occupancy, pax, materials, revenue, activity, payments, cancellations, balances, settlements) | Missing | Phase 7: DB views + CSV export UI. |
| Versioned cancellation/no-show/weather/refund/waiting/baggage/port policies | Missing | Phase 7: policy table. |
| Email/SMS/WhatsApp messaging | Partial | In-app notifications only. Phase 7: provider interface table, sandbox only. |

## 6. Hosting / handover

| Requirement | Status |
|---|---|
| Dev/staging/prod separation, env docs, migration/backup/monitoring planning | Partial (docs exist, local only). Phase 7: handover doc update, no prod claim. |

## Priority order for this phase

1. Individual + agent booking access.
2. Tariff, Saudi schedules, minimum-sailing evaluation.
3. Amendments, cancellation, terms acceptance.
4. Payment/invoice/refund sandbox.
5. Materials tariffs, attachments, delivery records.
6. Credit + settlement foundations.
7. Reports, exports, policy configuration.
