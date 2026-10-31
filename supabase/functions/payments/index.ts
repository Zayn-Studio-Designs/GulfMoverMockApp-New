// Supabase Edge Function (Deno): payments gateway for Gulf Mover.
//
//   POST /payments/checkout          { bookingId, method, idempotencyKey }   (user JWT)
//   POST /payments/status            { paymentId }                          (user JWT)
//   POST /payments/webhook/:provider raw provider notification             (no JWT; authenticated by the adapter)
//
// NOT DEPLOYED by this repository. Deployment needs ATCO authorisation, a hosted
// project and provider credentials — see docs/payments-and-einvoicing.md.
// Secrets (env): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   GM_PUBLIC_APP_URL, GM_FUNCTIONS_PUBLIC_URL, GM_PAYMENTS_LIVE_ENABLED,
//   GM_SANDBOX_WEBHOOK_SECRET, GM_SANDBOX_CHECKOUT_URL,
//   MOYASAR_TEST_SECRET_KEY / MOYASAR_TEST_WEBHOOK_TOKEN (and *_LIVE_* when authorised),
//   TAP_TEST_SECRET_KEY (and TAP_LIVE_SECRET_KEY when authorised).
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { handleCheckout, handleReconcile, handleStatusPoll, handleWebhook, type PaymentsDb } from '../_shared/payments/handler.ts';
import { selectProvider } from '../_shared/payments/registry.ts';
import type { ProviderId, ProviderPayment } from '../_shared/payments/types.ts';
import { buildServerEvent, logServerEvent, timingSafeEqual } from '../_shared/observability.ts';

declare const Deno: { env: { get(k: string): string | undefined; toObject(): Record<string, string> }; serve(h: (r: Request) => Promise<Response>): void };

const env = Deno.env.toObject();
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const cors = {
  'Access-Control-Allow-Origin': env.GM_PUBLIC_APP_URL ?? '',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function service() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function dbFor(authHeader: string | null): PaymentsDb {
  const asCaller = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }, global: { headers: authHeader ? { Authorization: authHeader } : {} },
  });
  const admin = service();
  const unwrap = <T,>(r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return r.data as T;
  };
  return {
    async beginCheckout(bookingId, method, key) {
      const rows = unwrap(await asCaller.rpc('begin_checkout', { p_booking_id: bookingId, p_method: method, p_idempotency_key: key }));
      return (Array.isArray(rows) ? rows[0] : rows) as never;
    },
    async readPaymentAsCaller(paymentId) {
      const rows = unwrap(await asCaller.from('payments').select('id, provider, provider_payment_id, checkout_url, mode, status').eq('id', paymentId).limit(1));
      return (rows as never[])[0] ?? null;
    },
    async attachCheckout(paymentId, providerPaymentId, checkoutUrl) {
      unwrap(await admin.rpc('attach_provider_checkout', { p_payment_id: paymentId, p_provider_payment_id: providerPaymentId, p_checkout_url: checkoutUrl }));
    },
    async applyResult(a) {
      return unwrap(await admin.rpc('apply_payment_result', {
        p_provider: a.provider, p_event_id: a.eventId, p_event_type: a.eventType, p_merchant_reference: a.merchantReference,
        p_provider_payment_id: a.providerPaymentId, p_status: a.status, p_amount_halala: a.amountHalala, p_currency: a.currency,
        p_fee_halala: a.feeHalala, p_verified_via: a.verifiedVia, p_payload_sha256: a.payloadSha256, p_failure_reason: a.failureReason,
      })) as string;
    },
    async listPaymentsToReconcile(olderThanMinutes, limit) {
      return unwrap(await admin.rpc('list_payments_to_reconcile', { p_older_than_minutes: olderThanMinutes, p_limit: limit })) as never;
    },
  };
}

// Sandbox truth is the database record itself (the sandbox checkout page records
// its simulated outcome through sandbox_simulate_payment); nothing external exists.
const sandboxLedger = {
  async get(providerPaymentId: string): Promise<ProviderPayment | null> {
    const { data } = await service().from('payments').select('provider_ref, amount_halala, currency, status')
      .eq('provider_payment_id', providerPaymentId).limit(1);
    const row = data?.[0];
    if (!row) return null;
    const status = row.status === 'succeeded' ? 'paid' : row.status === 'failed' ? 'failed' : 'pending';
    return { providerPaymentId, merchantReference: row.provider_ref, status, amountHalala: row.amount_halala,
      currency: row.currency, feeHalala: 0, failureReason: null };
  },
};

const providerFor = (id: ProviderId, mode: 'sandbox' | 'live' = 'sandbox') => {
  const selection = selectProvider(id, mode, env, sandboxLedger);
  return selection.ok ? selection.provider : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/payments/, '');
  try {
    if (path === '/checkout') {
      const body = await req.json().catch(() => ({}));
      const r = await handleCheckout(body, { db: dbFor(req.headers.get('Authorization')), providerFor,
        returnUrl: `${env.GM_PUBLIC_APP_URL}/bookings`, webhookBaseUrl: `${env.GM_FUNCTIONS_PUBLIC_URL}/payments/webhook` });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (path === '/status') {
      const body = await req.json().catch(() => ({}));
      const r = await handleStatusPoll(body, { db: dbFor(req.headers.get('Authorization')), providerFor });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (path === '/reconcile') {
      // Scheduled job only: the service role key is required (compared in constant time).
      if (!env.SUPABASE_SERVICE_ROLE_KEY || !timingSafeEqual(req.headers.get('Authorization') ?? '', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`)) return json(401, { error: 'unauthorized' });
      const mode = (env.GM_PAYMENTS_LIVE_ENABLED === 'true' ? 'live' : 'sandbox') as 'sandbox' | 'live';
      const r = await handleReconcile({ db: dbFor(null), providerFor: (id, m) => providerFor(id, m ?? mode) });
      if (r.status !== 200) await logServerEvent(buildServerEvent('payments', '/reconcile', 'reconciliation had errors', 'warning', r.body as never, env.GM_RELEASE), env);
      return json(r.status, r.body);
    }
    const hook = /^\/webhook\/([a-z-]+)$/.exec(path);
    if (hook) {
      const raw = await req.text();
      const mode = (env.GM_PAYMENTS_LIVE_ENABLED === 'true' ? 'live' : 'sandbox') as 'sandbox' | 'live';
      const r = await handleWebhook(hook[1], raw, req.headers, { db: dbFor(null), providerFor: id => providerFor(id, mode) });
      // Rejected (unverified) notifications are a security signal: log them so repeated attempts alert.
      if (r.status === 401 || r.status >= 500) {
        await logServerEvent(buildServerEvent('payments', `webhook:${hook[1]}`, `webhook responded ${r.status}`, r.status === 401 ? 'warning' : 'error',
          { status: r.status }, env.GM_RELEASE), env);
      }
      return json(r.status, r.body);
    }
    return json(404, { error: 'not_found' });
  } catch (e) {
    // Never echo provider responses or secrets: a scrubbed, fingerprinted event only.
    await logServerEvent(buildServerEvent('payments', new URL(req.url).pathname.replace(/^.*\/payments/, '') || '/', e, 'error', undefined, env.GM_RELEASE), env);
    return json(500, { error: 'internal_error' });
  }
});
