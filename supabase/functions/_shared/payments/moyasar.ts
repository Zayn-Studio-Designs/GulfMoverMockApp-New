import { timingSafeEqual } from './crypto.ts';
import { ProviderError } from './types.ts';
import type { CheckoutRequest, CheckoutSession, FetchLike, NormalizedStatus, PaymentProvider, ProviderPayment, RefundResult, WebhookVerification } from './types.ts';

/**
 * Moyasar adapter (Saudi gateway; mada / Visa / Mastercard / Apple Pay per its public docs).
 *
 * Integration shape taken from Moyasar's public documentation as researched for
 * Phase 8 (see docs/payments-and-einvoicing.md). Confirm every field against the
 * current API reference and ATCO's merchant agreement BEFORE activation:
 *  - Hosted checkout: POST {base}/v1/invoices (amount in halala, currency SAR,
 *    callback_url, metadata) → { id, url }.
 *  - Webhook: JSON with `id`, `type` (e.g. payment_paid), `secret_token`, `data`
 *    (payment object). Authenticated by comparing secret_token to our configured
 *    token (Moyasar does not document an HMAC signature), THEN the payment is
 *    re-fetched from GET {base}/v1/payments/{id} — the only trusted input.
 *  - Refund: POST {base}/v1/payments/{id}/refund { amount }.
 * Auth: HTTP Basic with the SECRET API key as username (server-side only).
 */
export interface MoyasarConfig {
  readonly secretKey: string;
  readonly webhookToken: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

const STATUS: Record<string, NormalizedStatus> = {
  paid: 'paid', captured: 'paid', failed: 'failed', voided: 'cancelled', canceled: 'cancelled', cancelled: 'cancelled',
  initiated: 'pending', authorized: 'pending', verified: 'pending', refunded: 'paid',
};

export function createMoyasarProvider(config: MoyasarConfig): PaymentProvider {
  const base = (config.baseUrl ?? 'https://api.moyasar.com').replace(/\/$/, '');
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  const auth = `Basic ${btoa(`${config.secretKey}:`)}`;

  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    if (!config.secretKey) throw new ProviderError('moyasar not configured', false);
    const res = await doFetch(`${base}${path}`, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new ProviderError(`moyasar ${res.status}: ${String(body.message ?? body.type ?? 'error')}`, res.status >= 500 || res.status === 429, res.status);
    return body;
  }

  return {
    id: 'moyasar',
    supportedMethods: ['mada', 'visa', 'mastercard', 'apple_pay'],
    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const body = await call('/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({
          amount: request.amountHalala, currency: request.currency, description: request.description.slice(0, 255),
          callback_url: request.webhookUrl, success_url: request.returnUrl, back_url: request.returnUrl,
          metadata: { merchant_reference: request.merchantReference },
        }),
      });
      if (typeof body.id !== 'string' || typeof body.url !== 'string' || !/^https:\/\//.test(body.url)) {
        throw new ProviderError('moyasar: unexpected checkout response', false);
      }
      return { providerPaymentId: body.id, checkoutUrl: body.url };
    },
    async verifyWebhook(rawBody: string, _headers: Headers): Promise<WebhookVerification> {
      if (!config.webhookToken) return { ok: false, reason: 'not_configured' };
      let body: Record<string, unknown>;
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return { ok: false, reason: 'malformed' }; }
      if (typeof body.secret_token !== 'string') return { ok: false, reason: 'missing_signature' };
      if (!timingSafeEqual(body.secret_token, config.webhookToken)) return { ok: false, reason: 'bad_signature' };
      const data = body.data as Record<string, unknown> | undefined;
      if (typeof body.id !== 'string' || typeof body.type !== 'string' || !data || typeof data.id !== 'string') return { ok: false, reason: 'malformed' };
      const metadata = data.metadata as Record<string, unknown> | undefined;
      return { ok: true, event: { eventId: body.id, eventType: body.type, providerPaymentId: data.id,
        merchantReference: typeof metadata?.merchant_reference === 'string' ? metadata.merchant_reference : null } };
    },
    async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(providerPaymentId)) throw new ProviderError('invalid payment id', false);
      const body = await call(`/v1/payments/${encodeURIComponent(providerPaymentId)}`);
      const metadata = body.metadata as Record<string, unknown> | undefined;
      const status = STATUS[String(body.status)] ?? 'pending';
      if (typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount)) throw new ProviderError('moyasar: invalid amount', false);
      return {
        providerPaymentId, merchantReference: typeof metadata?.merchant_reference === 'string' ? metadata.merchant_reference : null,
        status, amountHalala: body.amount, currency: String(body.currency ?? ''),
        feeHalala: typeof body.fee === 'number' && Number.isSafeInteger(body.fee) ? body.fee : null,
        failureReason: status === 'failed' ? String((body.source as Record<string, unknown> | undefined)?.message ?? 'declined') : null,
      };
    },
    async refund(providerPaymentId: string, amountHalala: number, _idempotencyKey: string): Promise<RefundResult> {
      const body = await call(`/v1/payments/${encodeURIComponent(providerPaymentId)}/refund`, { method: 'POST', body: JSON.stringify({ amount: amountHalala }) });
      const refunded = typeof body.refunded === 'number' ? body.refunded : 0;
      return { providerRefundId: `${providerPaymentId}:refund:${refunded}`, status: refunded >= amountHalala ? 'succeeded' : 'processing', detail: null };
    },
  };
}
