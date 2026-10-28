import { hmacSha256Hex, timingSafeEqual } from './crypto.ts';
import type { CheckoutRequest, CheckoutSession, FetchLike, PaymentProvider, ProviderPayment, RefundResult, WebhookVerification } from './types.ts';

/**
 * Sandbox provider: simulates a hosted checkout and SIGNED webhooks so the full
 * server-side verification path can be exercised with no merchant account and
 * no real money. Signature header: `x-gm-sandbox-signature: t=<unix>,v1=<hex>`
 * where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), 5-minute tolerance.
 * Payment state lives in the sandbox ledger passed in (tests) or the database.
 */
export interface SandboxLedger {
  get(providerPaymentId: string): Promise<ProviderPayment | null>;
}

export const SANDBOX_SIGNATURE_HEADER = 'x-gm-sandbox-signature';
export const SANDBOX_TOLERANCE_SECONDS = 300;

export async function signSandboxPayload(secret: string, rawBody: string, timestampSeconds: number): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export function createSandboxProvider(options: { secret: string; checkoutBaseUrl: string; ledger: SandboxLedger; fetch?: FetchLike }): PaymentProvider {
  const { secret, checkoutBaseUrl, ledger } = options;
  return {
    id: 'sandbox-provider',
    supportedMethods: ['mada', 'visa', 'mastercard', 'apple_pay'],
    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const providerPaymentId = `sbx_${request.merchantReference.toLowerCase()}`;
      const url = new URL(checkoutBaseUrl);
      url.searchParams.set('ref', request.merchantReference);
      return { providerPaymentId, checkoutUrl: url.toString() };
    },
    async verifyWebhook(rawBody: string, headers: Headers, nowMs = Date.now()): Promise<WebhookVerification> {
      if (!secret) return { ok: false, reason: 'not_configured' };
      const header = headers.get(SANDBOX_SIGNATURE_HEADER);
      if (!header) return { ok: false, reason: 'missing_signature' };
      const parts = Object.fromEntries(header.split(',').map(p => p.split('=', 2) as [string, string]));
      const t = Number(parts.t);
      if (!Number.isInteger(t) || !parts.v1) return { ok: false, reason: 'malformed' };
      if (Math.abs(nowMs / 1000 - t) > SANDBOX_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
      const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
      if (!timingSafeEqual(expected, parts.v1)) return { ok: false, reason: 'bad_signature' };
      try {
        const body = JSON.parse(rawBody) as { id?: unknown; type?: unknown; payment_id?: unknown; merchant_reference?: unknown };
        if (typeof body.id !== 'string' || typeof body.type !== 'string' || typeof body.payment_id !== 'string') return { ok: false, reason: 'malformed' };
        return { ok: true, event: { eventId: body.id, eventType: body.type, providerPaymentId: body.payment_id,
          merchantReference: typeof body.merchant_reference === 'string' ? body.merchant_reference : null } };
      } catch {
        return { ok: false, reason: 'malformed' };
      }
    },
    async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
      const payment = await ledger.get(providerPaymentId);
      if (!payment) throw new Error('sandbox payment not found');
      return payment;
    },
    async refund(providerPaymentId: string, _amountHalala: number, idempotencyKey: string): Promise<RefundResult> {
      return { providerRefundId: `sbx_rf_${providerPaymentId}_${idempotencyKey.slice(0, 8)}`, status: 'succeeded', detail: 'sandbox' };
    },
  };
}
