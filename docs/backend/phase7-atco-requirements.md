# Phase 7 — ATCO requirements (implementation report)

Branch: `feature/phase7-atco-requirements`. Base: Phase 6 checkpoint `55f2856`.
Local stack only; no hosted Supabase contacted; no real money moved.

## What was built

- **Tariffs & terms** (`20261031100000`): `tariffs` (per-person halala integers, VAT flags, provisional
  default `BASE-2026-ATCO-PENDING` at SAR 500), `service_policies` (versioned booking/refund/materials
  policies, provisional until ATCO approves), `sailing_minimum_status()` (4 tickets OR SAR 2,000 revenue
  per sailing, threshold never authorises departure).
- **Individual & agent booking** (`20261031100000` + `20261031100003`): `create_individual_booking()`
  (no company needed) and `create_agent_booking()` (approved agent org, client attribution) sharing one
  `_reserve_booking()` engine — capacity locking, return-leg validation, idempotent request keys with
  payload-mismatch rejection, terms-version enforcement, audit rows in `booking_events`.
- **Lifecycle** (`20261031100001`): `amend_booking()` (contact/metadata only, unpaid bookings),
  `cancel_booking()` (seat release, terminal-state guards), status separation
  (reservation / payment / operational / boarding).
- **Sandbox payments + invoices** (`20261031100001` + `20261031100003`): `initiate_payment()` /
  `verify_payment()` (staff-only verification; client callbacks are never proof), `invoices`
  (numbers only, `zatca_status='not_submitted'`), `refund_payment()` gated behind an approved refund
  policy (provisional default blocks refunds). All money in halala integers.
- **Materials** (`20261031100002`): ATCO field set (description, quantity, weight, dimensions, sender,
  receiver, handling, photo URLs, hazardous flag), URL-scheme and date validation; hazardous/restricted
  requests stay in the planning-review workflow, never auto-approved. `delivery_records` foundation.
- **Credit/settlement/reporting foundations** (`20261031100001`): `organization_credit`,
  `agent_settlements`, `material_tariffs`, `report_sailing_occupancy`, `report_revenue_by_sailing`
  (staff-gated, derived from persisted rows).
- **Services**: `src/lib/tariffService.ts`, `lifecycleService.ts`, `paymentService.ts`.
- **Tests**: `src/tests/integration/phase7.atco.integration.test.ts` (9 DB tests); signup-failure
  regression in `src/tests/authCutover.test.tsx`.

## Fixes found by testing (this run)

See `docs/test-results.md` (Phase 7 section): regex escaping, ambiguous OUT params, numeric/bigint
report shape, invoice idempotency constraint, payment-notification trigger column, manifest embed
ambiguity from the new agent FK, and the stale-preview signup false alarm.

## Explicitly not done / not claimed

Live payment provider integration, webhooks, real refunds/charges, ZATCA submission, VAT treatment,
enforceable cancellation/refund deadlines, commercial commission/credit terms (tables exist, rates
inactive), hazardous-material legal rules, hosted staging, backups, production hardening. Sandbox
payments and provisional policies are labelled as such in code and UI.

## Completion note

Verified scope (mock + local-backend features) is ~80% of the demonstrable surface; full ATCO
production scope (live billing, compliance, hosting, operations at scale) remains well below that —
see the honest percentage in the final report, not this file.
