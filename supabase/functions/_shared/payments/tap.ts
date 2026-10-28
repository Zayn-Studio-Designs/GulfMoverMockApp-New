import { decimalToHalala, halalaToDecimal, hmacSha256Hex, timingSafeEqual } from './crypto.ts';
import { ProviderError } from './types.ts';
import type { CheckoutRequest, CheckoutSession, FetchLike, NormalizedStatus, PaymentProvider, ProviderPayment, RefundResult, WebhookVerification } from './types.ts';

/**
 * Tap Payments adapter (GCC gateway; mada / Visa / Mastercard / Apple Pay per its public docs).
 *
 * Shape per Tap's public developer docs as researched for Phase 8. The exact
 * `hashstring` field order below follows community documentation and MUST be
 * confirmed with Tap before activation (see docs/payments-and-einvoicing.md):
 *   x_id{id}x_amount{amount}x_currency{currency}x_gateway_reference{gw}x_payment_reference{pay}x_status{status}x_created{created}
 * HMAC-SHA256 with the secret key, compared to the `hashstring` header. The
 * charge is then re-fetched server-to-server: GET {base}/v2/charges/{id}.
 */
export interface TapConfig {
  readonly secretKey: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

const STATUS: Record<string, NormalizedStatus> = {
  CAPTURED: 'paid', AUTHORIZED: 'pending', INITIATED: 'pending', IN_PROGRESS: 'pending',
  DECLINED: 'failed', FAILED: 'failed', RESTRICTED: 'failed', TIMEDOUT: 'failed', UNKNOWN: 'pending',
  CANCELLED: 'cancelled', ABANDONED: 'cancelled', VOID: 'cancelled',
};

export async function tapHashString(secretKey: string, charge: Record<string, unknown>): Promise<string> {
  const ref = (charge.reference ?? {}) as Record<string, unknown>;
  const txn = (charge.transaction ?? {}) as Record<string, unknown>;
  const amount = typeof charge.amount === 'number' ? halalaToDecimal(decimalToHalala(charge.amount)) : String(charge.amount ?? '');
  const message = `x_id${String(charge.id ?? '')}x_amount${amount}x_currency${String(charge.currency ?? '')}`
    + `x_gateway_reference${String(ref.gateway ?? '')}x_payment_reference${String(ref.payment ?? '')}`
    + `x_status${String(charge.status ?? '')}x_created${String(txn.created ?? '')}`;
  return hmacSha256Hex(secretKey, message);
}

export function createTapProvider(config: TapConfig): PaymentProvider {
  const base = (config.baseUrl ?? 'https://api.tap.company').replace(/\/$/, '');
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));

  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    if (!config.secretKey) throw new ProviderError('tap not configured', false);
    const res = await doFetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${config.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new ProviderError(`tap ${res.status}`, res.status >= 500 || res.status === 429, res.status);
    return body;
  }

  return {
    id: 'tap',
    supportedMethods: ['mada', 'visa', 'mastercard', 'apple_pay'],
    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const body = await call('/v2/charges', {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(halalaToDecimal(request.amountHalala)), currency: request.currency, description: request.description.slice(0, 255),
          reference: { transaction: request.merchantReference, order: request.merchantReference },
          source: { id: 'src_all' }, redirect: { url: request.returnUrl }, post: { url: request.webhookUrl },
          metadata: { merchant_reference: request.merchantReference },
        }),
      });
      const url = (body.transaction as Record<string, unknown> | undefined)?.url;
      if (typeof body.id !== 'string' || typeof url !== 'string' || !/^https:\/\//.test(url)) throw new ProviderError('tap: unexpected checkout response', false);
      return { providerPaymentId: body.id, checkoutUrl: url };
    },
    async verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookVerification> {
      if (!config.secretKey) return { ok: false, reason: 'not_configured' };
      const received = headers.get('hashstring');
      if (!received) return { ok: false, reason: 'missing_signature' };
      let body: Record<string, unknown>;
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return { ok: false, reason: 'malformed' }; }
      if (typeof body.id !== 'string') return { ok: false, reason: 'malformed' };
      let expected: string;
      try { expected = await tapHashString(config.secretKey, body); } catch { return { ok: false, reason: 'malformed' }; }
      if (!timingSafeEqual(expected, received.toLowerCase())) return { ok: false, reason: 'bad_signature' };
      const ref = (body.reference ?? {}) as Record<string, unknown>;
      const txn = (body.transaction ?? {}) as Record<string, unknown>;
      return { ok: true, event: { eventId: `${body.id}:${String(body.status ?? '')}:${String(txn.created ?? '')}`, eventType: `charge.${String(body.status ?? 'unknown').toLowerCase()}`,
        providerPaymentId: body.id, merchantReference: typeof ref.transaction === 'string' ? ref.transaction : null } };
    },
    async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(providerPaymentId)) throw new ProviderError('invalid payment id', false);
      const body = await call(`/v2/charges/${encodeURIComponent(providerPaymentId)}`);
      const ref = (body.reference ?? {}) as Record<string, unknown>;
      const status = STATUS[String(body.status)] ?? 'pending';
      return {
        providerPaymentId, merchantReference: typeof ref.transaction === 'string' ? ref.transaction : null, status,
        amountHalala: decimalToHalala(body.amount as number | string), currency: String(body.currency ?? ''), feeHalala: null,
        failureReason: status === 'failed' ? String((body.response as Record<string, unknown> | undefined)?.message ?? body.status) : null,
      };
    },
    async refund(providerPaymentId: string, amountHalala: number, idempotencyKey: string): Promise<RefundResult> {
      const body = await call('/v2/refunds', { method: 'POST', body: JSON.stringify({
        charge_id: providerPaymentId, amount: Number(halalaToDecimal(amountHalala)), currency: 'SAR', reason: 'requested_by_customer',
        reference: { merchant: idempotencyKey } }) });
      const s = String(body.status ?? '');
      return { providerRefundId: String(body.id ?? ''), status: s === 'REFUNDED' ? 'succeeded' : s === 'FAILED' ? 'failed' : 'processing', detail: s || null };
    },
  };
}
