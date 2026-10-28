import { createMoyasarProvider } from './moyasar.ts';
import { createSandboxProvider, type SandboxLedger } from './sandbox.ts';
import { createTapProvider } from './tap.ts';
import type { PaymentProvider, ProviderId } from './types.ts';

/** Reads adapter configuration from a plain env map (Deno.env.toObject() in the edge function). */
export interface ProviderEnv {
  readonly [key: string]: string | undefined;
}

export type ProviderSelection =
  | { readonly ok: true; readonly provider: PaymentProvider }
  | { readonly ok: false; readonly reason: string };

/**
 * Returns the configured adapter, or a reason it cannot be used. Live mode is
 * refused unless GM_PAYMENTS_LIVE_ENABLED=true is set in the function's env
 * (in addition to the database switch payments.live_enabled).
 */
export function selectProvider(id: ProviderId, mode: 'sandbox' | 'live', env: ProviderEnv, sandboxLedger: SandboxLedger): ProviderSelection {
  if (mode === 'live' && env.GM_PAYMENTS_LIVE_ENABLED !== 'true') return { ok: false, reason: 'live_payments_disabled' };
  if (mode === 'live' && id === 'sandbox-provider') return { ok: false, reason: 'sandbox_provider_in_live_mode' };
  switch (id) {
    case 'sandbox-provider':
      if (!env.GM_SANDBOX_WEBHOOK_SECRET || !env.GM_SANDBOX_CHECKOUT_URL) return { ok: false, reason: 'sandbox_not_configured' };
      return { ok: true, provider: createSandboxProvider({ secret: env.GM_SANDBOX_WEBHOOK_SECRET, checkoutBaseUrl: env.GM_SANDBOX_CHECKOUT_URL, ledger: sandboxLedger }) };
    case 'moyasar': {
      const prefix = mode === 'live' ? 'MOYASAR_LIVE' : 'MOYASAR_TEST';
      const secretKey = env[`${prefix}_SECRET_KEY`]; const webhookToken = env[`${prefix}_WEBHOOK_TOKEN`];
      if (!secretKey || !webhookToken) return { ok: false, reason: 'moyasar_not_configured' };
      if (mode === 'sandbox' && !secretKey.startsWith('sk_test_')) return { ok: false, reason: 'moyasar_test_key_required' };
      return { ok: true, provider: createMoyasarProvider({ secretKey, webhookToken }) };
    }
    case 'tap': {
      const secretKey = env[mode === 'live' ? 'TAP_LIVE_SECRET_KEY' : 'TAP_TEST_SECRET_KEY'];
      if (!secretKey) return { ok: false, reason: 'tap_not_configured' };
      if (mode === 'sandbox' && !secretKey.startsWith('sk_test_')) return { ok: false, reason: 'tap_test_key_required' };
      return { ok: true, provider: createTapProvider({ secretKey }) };
    }
    default:
      return { ok: false, reason: 'unknown_provider' };
  }
}
