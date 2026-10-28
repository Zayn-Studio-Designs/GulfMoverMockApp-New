# Payments, invoicing and Saudi e-invoicing (Phase 8)

Status: **sandbox only. No real money has been processed, no merchant account exists, no
provider credentials were used, and nothing has been submitted to ZATCA.** Live activation is
blocked in three independent places (database setting `payments.live_enabled`, edge-function
env `GM_PAYMENTS_LIVE_ENABLED`, and provider test-key checks) until ATCO supplies an approved
merchant account and authorises testing.

## 1. What is implemented

| Capability | Where | Verified by |
|---|---|---|
| Server-side price (tariff version × passengers × legs, VAT per tariff) — browser never sends amounts | `quote_passenger_fare`, `_price_booking` (`20261101100001/2`) | `src/tests/db/phase8.commerce.db.test.ts` |
| Checkout initiation: idempotent per key, one in-flight payment per booking, hold-expiry check, live mode refused unless enabled | `begin_checkout` | DB tests |
| Provider-independent adapter contract | `supabase/functions/_shared/payments/types.ts` | `src/tests/phase8Adapters.test.ts` |
| Sandbox provider with HMAC-signed webhooks (5-min tolerance, constant-time compare) | `_shared/payments/sandbox.ts` | adapter tests |
| Moyasar adapter (hosted invoice checkout, secret-token webhook auth, mandatory server re-fetch) | `_shared/payments/moyasar.ts` | adapter tests (mocked HTTP) |
| Tap adapter (hosted charge, `hashstring` HMAC verification, server re-fetch) | `_shared/payments/tap.ts` | adapter tests (mocked HTTP) |
| Webhook handler: unverified → 401, verified → re-fetch → apply; duplicates harmless | `_shared/payments/handler.ts`, `functions/payments/index.ts` | adapter tests |
| Applying results: service-role only, amount/currency must match, duplicate event ids ignored, a provider id is never re-pointed, capture after expiry/cancel → refund review | `apply_payment_result` / `_apply_payment_result` | DB tests (incl. reference-conflict and late capture) |
| Invoices: sequential `GM-INV-YYYY-NNNNNN` (gap-free counter), line items per leg that must reconcile to the booking total, buyer/seller snapshots, sandbox flag | `_issue_booking_invoice`, `invoice_lines` | DB tests |
| Receipts | payment rows + receipt list on the booking page | UI + DB |
| Refunds: request → approve (approved refund policy + different person) → provider → credit note `GM-CN-YYYY-NNNNNN` | `request_refund`, `decide_refund`, `apply_refund_result`, `_complete_refund` | DB tests |
| On-account (credit) invoices with due dates; Finance records bank transfers | `_reserve_booking_v2(on_account)`, `record_account_payment` | DB tests |
| Reconciliation report (booking vs captured vs invoice) | `report_payment_reconciliation` | DB tests |
| Printable invoice (EN/AR, RTL) + Latin PDF download | `src/pages/InvoiceView.tsx`, `src/domain/pdf.ts` | unit + stubbed browser check |

**The browser redirect is never proof of payment.** Only `apply_payment_result` (service role,
called after a verified webhook or a server-to-server status fetch) or the sandbox simulator
(refused unless `payments.mode = 'sandbox'` and the payment itself is a sandbox payment) can mark
a payment succeeded.

**No card data** is ever collected: checkout is the provider's hosted page; Gulf Mover stores
only its own merchant reference, the provider's payment id, amounts and statuses.

## 2. Provider research (official sources where reachable)

Research performed 28 Oct 2026 from this cloud session. `docs.moyasar.com` and `zatca.gov.sa`
could not be fetched directly from this environment (host not allowed); findings below come from
search results that index those official pages, and are marked accordingly. **Fees and
settlement terms are not stated here because none were verifiable from official sources — ATCO
must obtain written quotes.**

| Provider | Methods (per provider docs) | Webhook authentication | Status verification | Notes / evidence |
|---|---|---|---|---|
| **Moyasar** (KSA) | mada, Visa, Mastercard, Apple Pay (STC Pay also listed) | Payload field `secret_token` that the merchant configures; no HMAC signature documented | `GET /v1/payments/{id}` with secret key; Moyasar's quickstart recommends verifying status, amount and currency before fulfilling | [Webhook reference](https://docs.moyasar.com/api/other/webhooks/webhook-reference), [Setting up webhooks](https://docs.moyasar.com/guides/dashboard/setting-up-webhooks), [5-minute integration](https://docs.moyasar.com/getting-started/min-quickstart). A third-party integrator claims HMAC signing; **not confirmed** — the adapter therefore treats the token as authentication only and always re-fetches. |
| **Tap Payments** (GCC) | mada, Visa, Mastercard, Apple Pay | `hashstring` header = HMAC-SHA256 over selected charge fields with the secret key | `GET /v2/charges/{id}` | [Tap developer docs](https://developers.tap.company/docs), [Apple Pay web SDK](https://developers.tap.company/docs/apple-pay-1). The exact hashstring field order used here comes from community documentation and **must be confirmed with Tap**. |
| **HyperPay** (KSA, OPPWA) | mada, Visa, Mastercard, Apple Pay | Encrypted webhook payload (AES-GCM) per its docs | Server status query | [Webhook decryption example](https://hyperpay.docs.oppwa.com/tutorials/webhooks/decryption-example) — page content not retrievable here; adapter not implemented (the contract supports adding it). |

### Recommendation (for ATCO Finance / IT decision)

Start merchant onboarding discussions with **Moyasar** as the primary candidate (Saudi-focused,
documented hosted checkout with all four required methods, simple API that matched our adapter
contract), keeping **Tap** as the alternative already implemented behind the same contract.
The final choice depends on information only ATCO can obtain: SAMA licensing status confirmation,
settlement timing into ATCO's bank account, MDR/fees per method, Apple Pay merchant-domain
requirements, refund and chargeback handling, and reconciliation report formats. Switching
provider is a configuration change (`payments.provider` + edge-function secrets), not a rewrite.

### Activation checklist (all ATCO-owned)

1. Contract with the provider; merchant account in ATCO's name settling to ATCO's bank account.
2. Provider **test** keys → `supabase secrets set MOYASAR_TEST_SECRET_KEY=… MOYASAR_TEST_WEBHOOK_TOKEN=…` on **staging**.
3. Deploy `payments` edge function to staging; register its `/payments/webhook/moyasar` URL in the provider dashboard.
4. Run the staging payment test plan (success, decline, abandonment, duplicate webhook, amount mismatch, refund) — no real cards.
5. Apple Pay: domain verification file on the production domain (provider-specific).
6. Finance sign-off; then production: set `seller.legal_name`, `seller.vat_number`, live keys, `GM_PAYMENTS_LIVE_ENABLED=true`, and `update_platform_setting('payments.live_enabled', true)` by a super_admin (the database refuses live mode while the seller identity is unset).

## 3. VAT and Saudi e-invoicing (ZATCA / FATOORA)

### What the application does now

- **VAT treatment is a property of each approved tariff version** (`not_configured`, `exclusive`,
  `inclusive`, `exempt`, `zero_rated`; rate in basis points). The seeded SAR 500 tariff is
  `not_configured` — **no VAT is charged or claimed** until ATCO Finance decides.
- Exact integer arithmetic, half-up rounding **per line**; invoice lines reconcile to the booking
  total and to the captured payment (tested, including 15% exclusive and inclusive cases).
- Document type is derived, never chosen by a user: without seller VAT registration or with VAT
  not configured, documents are **commercial invoices (not tax invoices)** and say so.
- ZATCA-preparation fields on every invoice and credit note: document UUID, a single gap-free
  invoice counter (ICV) across invoices and credit notes, previous-document hash chain (PIH,
  initial value as used in ZATCA SDK samples — to be confirmed), and the **Phase-1 QR TLV**
  (tags 1–5: seller name, VAT number, timestamp, total incl. VAT, VAT total), produced by the
  database and cross-checked byte-for-byte against an independent TypeScript encoder.
- `zatca_status` remains `not_submitted` for every document.

### What Phase 2 (integration) requires and is NOT done

Per ZATCA material and integrator guides found in research
([ZATCA FAQ](https://zatca.gov.sa/en/E-Invoicing/Introduction/FAQ/Documents/E-Invoicing%20FAQ%20En.pdf),
[Retarus Phase 2 process](https://docs.retarus.com/sci/process-description-saudi-arabia-phase-2)):
UBL 2.1 XML invoices, XAdES cryptographic stamp with a ZATCA-issued certificate, device (EGS)
onboarding (CSR → compliance CSID → production CSID), clearance (B2B) / reporting (B2C) API
calls, and the Phase-2 QR with cryptographic tags. Our integrity hash is **not** the ZATCA
invoice hash (which is computed over canonicalised XML).

**These require ATCO's VAT registration, its ZATCA FATOORA portal access, its wave/obligation
date and Finance approval.** Options: integrate a certified e-invoicing provider, or build the
XML/signing/clearance service once credentials exist. **No ZATCA compliance is claimed.**
