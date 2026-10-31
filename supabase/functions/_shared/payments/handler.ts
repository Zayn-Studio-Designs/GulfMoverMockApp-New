import { sha256Hex } from './crypto.ts';
import type { PaymentMethod, PaymentProvider, ProviderId } from './types.ts';

/**
 * Transport-independent core of the `payments` edge function. The Deno entry
 * point wires real Supabase clients; tests wire fakes. Every state change goes
 * through database RPCs that re-validate amounts, ownership and idempotency.
 */
export interface CheckoutRow {
  readonly payment_id: string;
  readonly merchant_reference: string;
  readonly amount_halala: number;
  readonly currency: 'SAR';
  readonly provider: ProviderId;
  readonly mode: 'sandbox' | 'live';
  readonly outcome: 'created' | 'replayed';
}

export interface PaymentRecord {
  readonly id: string;
  readonly provider: ProviderId;
  readonly provider_payment_id: string | null;
  readonly checkout_url: string | null;
  readonly mode: 'sandbox' | 'live';
  readonly status: string;
}

export interface ApplyArgs {
  readonly provider: ProviderId;
  readonly eventId: string;
  readonly eventType: string;
  readonly merchantReference: string | null;
  readonly providerPaymentId: string;
  readonly status: 'paid' | 'failed' | 'pending' | 'cancelled';
  readonly amountHalala: number;
  readonly currency: string;
  readonly feeHalala: number | null;
  readonly verifiedVia: 'webhook' | 'server_fetch';
  readonly payloadSha256: string | null;
  readonly failureReason: string | null;
}

export interface PaymentsDb {
  /** Runs begin_checkout AS THE CALLER (user JWT), so ownership is enforced by the database. */
  beginCheckout(bookingId: string, method: PaymentMethod, idempotencyKey: string): Promise<CheckoutRow>;
  /** Reads a payment visible to the caller (RLS), for status polling. */
  readPaymentAsCaller(paymentId: string): Promise<PaymentRecord | null>;
  /** Service role. */
  attachCheckout(paymentId: string, providerPaymentId: string, checkoutUrl: string): Promise<void>;
  applyResult(args: ApplyArgs): Promise<string>;
  /** Service role: payments still pending after `olderThanMinutes` (for reconciliation). */
  listPaymentsToReconcile?(olderThanMinutes: number, limit: number): Promise<PaymentRecord[]>;
}

export type HandlerResult = { readonly status: number; readonly body: Record<string, unknown> };

const METHODS: readonly PaymentMethod[] = ['mada', 'visa', 'mastercard', 'apple_pay'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleCheckout(
  input: { bookingId?: unknown; method?: unknown; idempotencyKey?: unknown },
  deps: { db: PaymentsDb; providerFor: (id: ProviderId, mode: 'sandbox' | 'live') => PaymentProvider | null; returnUrl: string; webhookBaseUrl: string },
): Promise<HandlerResult> {
  const { bookingId, method, idempotencyKey } = input;
  if (typeof bookingId !== 'string' || !UUID.test(bookingId) || typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)
      || typeof method !== 'string' || !METHODS.includes(method as PaymentMethod)) {
    return { status: 400, body: { error: 'invalid_request' } };
  }
  const row = await deps.db.beginCheckout(bookingId, method as PaymentMethod, idempotencyKey);
  const provider = deps.providerFor(row.provider, row.mode);
  if (!provider) return { status: 503, body: { error: 'payment_provider_unavailable', payment_id: row.payment_id } };
  if (!provider.supportedMethods.includes(method as PaymentMethod)) return { status: 400, body: { error: 'method_not_supported' } };
  if (row.outcome === 'replayed') {
    const existing = await deps.db.readPaymentAsCaller(row.payment_id);
    if (existing?.checkout_url) return { status: 200, body: { payment_id: row.payment_id, checkout_url: existing.checkout_url, mode: row.mode } };
  }
  const session = await provider.createCheckout({
    merchantReference: row.merchant_reference, amountHalala: row.amount_halala, currency: row.currency,
    description: `Gulf Mover booking payment ${row.merchant_reference}`, method: method as PaymentMethod,
    returnUrl: `${deps.returnUrl}?payment=${encodeURIComponent(row.payment_id)}`,
    webhookUrl: `${deps.webhookBaseUrl}/${row.provider}`,
  });
  await deps.db.attachCheckout(row.payment_id, session.providerPaymentId, session.checkoutUrl);
  return { status: 200, body: { payment_id: row.payment_id, checkout_url: session.checkoutUrl, mode: row.mode } };
}

/**
 * Webhook: authenticate the notification, then trust ONLY the server-to-server
 * fetch of the payment. Unverifiable requests get 401 and change nothing.
 */
export async function handleWebhook(
  providerId: string, rawBody: string, headers: Headers,
  deps: { db: PaymentsDb; providerFor: (id: ProviderId) => PaymentProvider | null; nowMs?: number },
): Promise<HandlerResult> {
  if (!['sandbox-provider', 'moyasar', 'tap'].includes(providerId)) return { status: 404, body: { error: 'unknown_provider' } };
  if (rawBody.length > 256 * 1024) return { status: 413, body: { error: 'payload_too_large' } };
  const provider = deps.providerFor(providerId as ProviderId);
  if (!provider) return { status: 503, body: { error: 'provider_not_configured' } };
  const verification = await provider.verifyWebhook(rawBody, headers, deps.nowMs);
  if (!verification.ok) return { status: 401, body: { error: 'unverified_webhook', reason: verification.reason } };
  const payment = await provider.fetchPayment(verification.event.providerPaymentId);
  const outcome = await deps.db.applyResult({
    provider: provider.id, eventId: verification.event.eventId, eventType: verification.event.eventType,
    merchantReference: payment.merchantReference ?? verification.event.merchantReference, providerPaymentId: payment.providerPaymentId,
    status: payment.status, amountHalala: payment.amountHalala, currency: payment.currency, feeHalala: payment.feeHalala,
    verifiedVia: 'webhook', payloadSha256: await sha256Hex(rawBody), failureReason: payment.failureReason,
  });
  // 200 for every processed or duplicate event so the provider stops retrying.
  return { status: 200, body: { outcome } };
}

/** Customer returns from the hosted page: poll the provider server-side; never trust the redirect. */
export async function handleStatusPoll(
  input: { paymentId?: unknown },
  deps: { db: PaymentsDb; providerFor: (id: ProviderId, mode: 'sandbox' | 'live') => PaymentProvider | null },
): Promise<HandlerResult> {
  if (typeof input.paymentId !== 'string' || !UUID.test(input.paymentId)) return { status: 400, body: { error: 'invalid_request' } };
  const record = await deps.db.readPaymentAsCaller(input.paymentId);
  if (!record) return { status: 404, body: { error: 'not_found' } };
  if (!record.provider_payment_id || !['initiated', 'pending'].includes(record.status)) return { status: 200, body: { status: record.status } };
  const provider = deps.providerFor(record.provider, record.mode);
  if (!provider) return { status: 503, body: { error: 'payment_provider_unavailable' } };
  const payment = await provider.fetchPayment(record.provider_payment_id);
  if (payment.status === 'pending') return { status: 200, body: { status: 'pending' } };
  const outcome = await deps.db.applyResult({
    provider: provider.id, eventId: `fetch:${payment.providerPaymentId}:${payment.status}`, eventType: 'status_fetch',
    merchantReference: payment.merchantReference, providerPaymentId: payment.providerPaymentId, status: payment.status,
    amountHalala: payment.amountHalala, currency: payment.currency, feeHalala: payment.feeHalala,
    verifiedVia: 'server_fetch', payloadSha256: null, failureReason: payment.failureReason,
  });
  return { status: 200, body: { status: payment.status, outcome } };
}

/**
 * Scheduled reconciliation (service role): for every payment still pending after 10 minutes,
 * ask the provider for its real status and apply it through the same idempotent path as the
 * status poll. Covers a lost webhook when the customer never returned to the site. One
 * provider failure never stops the batch; it is counted and retried on the next run.
 */
export async function handleReconcile(
  deps: { db: PaymentsDb; providerFor: (id: ProviderId, mode: 'sandbox' | 'live') => PaymentProvider | null },
  options: { olderThanMinutes?: number; limit?: number } = {},
): Promise<HandlerResult> {
  if (!deps.db.listPaymentsToReconcile) return { status: 501, body: { error: 'reconcile_not_supported' } };
  const rows = await deps.db.listPaymentsToReconcile(options.olderThanMinutes ?? 10, options.limit ?? 50);
  const counts = { checked: rows.length, applied: 0, still_pending: 0, provider_unavailable: 0, errors: 0 };
  for (const record of rows) {
    if (!record.provider_payment_id) continue;
    const provider = deps.providerFor(record.provider, record.mode);
    if (!provider) { counts.provider_unavailable += 1; continue; }
    try {
      const payment = await provider.fetchPayment(record.provider_payment_id);
      if (payment.status === 'pending') { counts.still_pending += 1; continue; }
      await deps.db.applyResult({
        provider: provider.id, eventId: `fetch:${payment.providerPaymentId}:${payment.status}`, eventType: 'reconcile_fetch',
        merchantReference: payment.merchantReference, providerPaymentId: payment.providerPaymentId, status: payment.status,
        amountHalala: payment.amountHalala, currency: payment.currency, feeHalala: payment.feeHalala,
        verifiedVia: 'server_fetch', payloadSha256: null, failureReason: payment.failureReason,
      });
      counts.applied += 1;
    } catch {
      counts.errors += 1;
    }
  }
  return { status: counts.errors > 0 ? 207 : 200, body: counts };
}
