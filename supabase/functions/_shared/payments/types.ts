/**
 * Provider-independent payment contract used by the `payments` edge function.
 *
 * Rules every adapter must follow:
 *  - Amounts cross this boundary as integer halala (1 SAR = 100 halala). No floats.
 *  - No card data ever reaches Gulf Mover: adapters only create hosted checkouts
 *    (or provider-tokenised sessions) and read results.
 *  - A webhook is only a hint until verified; adapters authenticate it AND the
 *    edge function re-fetches the payment server-to-server before applying it.
 *  - Secrets come from edge-function environment variables, never the browser.
 */
export type ProviderId = 'sandbox-provider' | 'moyasar' | 'tap';

export type PaymentMethod = 'mada' | 'visa' | 'mastercard' | 'apple_pay';

/** Normalised provider outcome, mapped onto apply_payment_result(p_status). */
export type NormalizedStatus = 'paid' | 'failed' | 'pending' | 'cancelled';

export interface CheckoutRequest {
  readonly merchantReference: string; // our GMP-… reference (payments.provider_ref)
  readonly amountHalala: number;
  readonly currency: 'SAR';
  readonly description: string;
  readonly method: PaymentMethod;
  readonly returnUrl: string; // where the provider sends the browser afterwards (never proof of payment)
  readonly webhookUrl: string;
}

export interface CheckoutSession {
  readonly providerPaymentId: string;
  readonly checkoutUrl: string;
}

export interface ProviderPayment {
  readonly providerPaymentId: string;
  readonly merchantReference: string | null;
  readonly status: NormalizedStatus;
  readonly amountHalala: number;
  readonly currency: string;
  readonly feeHalala: number | null;
  readonly failureReason: string | null;
}

export interface VerifiedWebhook {
  readonly eventId: string;
  readonly eventType: string;
  readonly providerPaymentId: string;
  readonly merchantReference: string | null;
}

export type WebhookVerification =
  | { readonly ok: true; readonly event: VerifiedWebhook }
  | { readonly ok: false; readonly reason: 'missing_signature' | 'bad_signature' | 'stale' | 'malformed' | 'not_configured' };

export interface RefundResult {
  readonly providerRefundId: string;
  readonly status: 'processing' | 'succeeded' | 'failed';
  readonly detail: string | null;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  /** Methods this adapter can offer once the merchant account enables them. */
  readonly supportedMethods: readonly PaymentMethod[];
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  verifyWebhook(rawBody: string, headers: Headers, nowMs?: number): Promise<WebhookVerification>;
  /** Server-to-server status read: the only input apply_payment_result trusts. */
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  refund(providerPaymentId: string, amountHalala: number, idempotencyKey: string): Promise<RefundResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly httpStatus: number | null = null) {
    super(message);
  }
}

/** Minimal fetch signature so adapters are testable without network access. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
