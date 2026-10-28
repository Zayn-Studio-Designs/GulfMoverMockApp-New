// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decimalToHalala, halalaToDecimal, hmacSha256Hex } from '../../supabase/functions/_shared/payments/crypto.ts';
import { handleCheckout, handleStatusPoll, handleWebhook, type ApplyArgs, type PaymentsDb } from '../../supabase/functions/_shared/payments/handler.ts';
import { createMoyasarProvider } from '../../supabase/functions/_shared/payments/moyasar.ts';
import { selectProvider } from '../../supabase/functions/_shared/payments/registry.ts';
import { createSandboxProvider, signSandboxPayload, SANDBOX_SIGNATURE_HEADER } from '../../supabase/functions/_shared/payments/sandbox.ts';
import { createTapProvider, tapHashString } from '../../supabase/functions/_shared/payments/tap.ts';
import type { ProviderPayment } from '../../supabase/functions/_shared/payments/types.ts';
import { createResendEmail, dispatchOutbox, renderMessage, type OutboxDb, type OutboxRow } from '../../supabase/functions/_shared/messaging/providers.ts';
import { formatHalala, formatSar, halalaToCsvDecimal } from '../domain/money';
import { decodeZatcaQr, encodeZatcaQr } from '../domain/zatcaQr';
import { buildPdf, pdfSafeText } from '../domain/pdf';

const PAY_ID = '11111111-1111-4111-8111-111111111111';
const BOOKING = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

function fakeDb(overrides: Partial<PaymentsDb> = {}) {
  const applied: ApplyArgs[] = [];
  const db: PaymentsDb = {
    beginCheckout: vi.fn(async () => ({ payment_id: PAY_ID, merchant_reference: 'GMP-ABC', amount_halala: 100000, currency: 'SAR' as const,
      provider: 'sandbox-provider' as const, mode: 'sandbox' as const, outcome: 'created' as const })),
    readPaymentAsCaller: vi.fn(async () => ({ id: PAY_ID, provider: 'sandbox-provider' as const, provider_payment_id: 'sbx_gmp-abc',
      checkout_url: 'http://127.0.0.1:4321/sandbox-checkout?ref=GMP-ABC', mode: 'sandbox' as const, status: 'pending' })),
    attachCheckout: vi.fn(async () => undefined),
    applyResult: vi.fn(async (a: ApplyArgs) => { applied.push(a); return 'succeeded'; }),
    ...overrides,
  };
  return { db, applied };
}

const ledger = (p: ProviderPayment | null) => ({ get: async () => p });
const paid: ProviderPayment = { providerPaymentId: 'sbx_gmp-abc', merchantReference: 'GMP-ABC', status: 'paid', amountHalala: 100000, currency: 'SAR', feeHalala: 0, failureReason: null };

describe('money helpers (integer halala only)', () => {
  it('formats and converts without floating point', () => {
    expect(formatHalala(123456789)).toBe('1,234,567.89');
    expect(formatHalala(5)).toBe('0.05');
    expect(formatSar(50000)).toBe('SAR 500.00');
    expect(formatSar(50000, 'ar')).toBe('500.00 ر.س');
    expect(halalaToCsvDecimal(123456)).toBe('1234.56');
    expect(halalaToDecimal(100001)).toBe('1000.01');
    expect(decimalToHalala('1150.5')).toBe(115050);
    expect(decimalToHalala(0.1 + 0.2)).toBe(30);
    expect(() => decimalToHalala('1.234')).toThrow();
    expect(() => formatHalala(1.5)).toThrow();
  });
});

describe('sandbox provider: signed webhooks', () => {
  const provider = createSandboxProvider({ secret: 'test-secret', checkoutBaseUrl: 'http://127.0.0.1:4321/sandbox-checkout', ledger: ledger(paid) });
  const body = JSON.stringify({ id: 'evt_1', type: 'payment.paid', payment_id: 'sbx_gmp-abc', merchant_reference: 'GMP-ABC' });

  it('accepts a correctly signed, fresh notification', async () => {
    const now = 1_800_000_000_000;
    const headers = new Headers({ [SANDBOX_SIGNATURE_HEADER]: await signSandboxPayload('test-secret', body, now / 1000) });
    const r = await provider.verifyWebhook(body, headers, now);
    expect(r.ok && r.event.providerPaymentId).toBe('sbx_gmp-abc');
  });

  it('rejects tampered, stale, unsigned and wrongly keyed notifications', async () => {
    const now = 1_800_000_000_000;
    const sig = await signSandboxPayload('test-secret', body, now / 1000);
    expect(await provider.verifyWebhook(body.replace('evt_1', 'evt_2'), new Headers({ [SANDBOX_SIGNATURE_HEADER]: sig }), now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await provider.verifyWebhook(body, new Headers({ [SANDBOX_SIGNATURE_HEADER]: sig }), now + 301_000)).toEqual({ ok: false, reason: 'stale' });
    expect(await provider.verifyWebhook(body, new Headers(), now)).toEqual({ ok: false, reason: 'missing_signature' });
    const wrong = await signSandboxPayload('other-secret', body, now / 1000);
    expect(await provider.verifyWebhook(body, new Headers({ [SANDBOX_SIGNATURE_HEADER]: wrong }), now)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('payments handler', () => {
  const sandbox = createSandboxProvider({ secret: 's3cret', checkoutBaseUrl: 'http://127.0.0.1:4321/sandbox-checkout', ledger: ledger(paid) });

  it('creates a hosted checkout from server-side amounts and attaches it', async () => {
    const { db } = fakeDb();
    const r = await handleCheckout({ bookingId: BOOKING, method: 'mada', idempotencyKey: KEY },
      { db, providerFor: () => sandbox, returnUrl: 'http://127.0.0.1:4321/bookings', webhookBaseUrl: 'http://127.0.0.1:54321/functions/v1/payments/webhook' });
    expect(r.status).toBe(200);
    expect(r.body.checkout_url).toBe('http://127.0.0.1:4321/sandbox-checkout?ref=GMP-ABC');
    expect(db.attachCheckout).toHaveBeenCalledWith(PAY_ID, 'sbx_gmp-abc', 'http://127.0.0.1:4321/sandbox-checkout?ref=GMP-ABC');
  });

  it('rejects malformed input and an unavailable provider without side effects', async () => {
    const { db } = fakeDb();
    expect((await handleCheckout({ bookingId: 'x', method: 'mada', idempotencyKey: KEY }, { db, providerFor: () => sandbox, returnUrl: '', webhookBaseUrl: '' })).status).toBe(400);
    expect((await handleCheckout({ bookingId: BOOKING, method: 'cash', idempotencyKey: KEY }, { db, providerFor: () => sandbox, returnUrl: '', webhookBaseUrl: '' })).status).toBe(400);
    expect((await handleCheckout({ bookingId: BOOKING, method: 'mada', idempotencyKey: KEY }, { db, providerFor: () => null, returnUrl: '', webhookBaseUrl: '' })).status).toBe(503);
    expect(db.attachCheckout).not.toHaveBeenCalled();
  });

  it('applies only server-fetched results from verified webhooks', async () => {
    const { db, applied } = fakeDb();
    const body = JSON.stringify({ id: 'evt_9', type: 'payment.paid', payment_id: 'sbx_gmp-abc' });
    const now = Date.now();
    const ok = await handleWebhook('sandbox-provider', body, new Headers({ [SANDBOX_SIGNATURE_HEADER]: await signSandboxPayload('s3cret', body, Math.floor(now / 1000)) }),
      { db, providerFor: () => sandbox, nowMs: now });
    expect(ok.status).toBe(200);
    expect(applied[0]).toMatchObject({ status: 'paid', amountHalala: 100000, verifiedVia: 'webhook', eventId: 'evt_9' });
    expect(applied[0].payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    const bad = await handleWebhook('sandbox-provider', body, new Headers({ [SANDBOX_SIGNATURE_HEADER]: 't=1,v1=00' }), { db, providerFor: () => sandbox, nowMs: now });
    expect(bad.status).toBe(401);
    expect(applied).toHaveLength(1);
    expect((await handleWebhook('paypal', body, new Headers(), { db, providerFor: () => sandbox })).status).toBe(404);
  });

  it('status poll asks the provider server-side and ignores pending', async () => {
    const pending = createSandboxProvider({ secret: 's', checkoutBaseUrl: 'http://127.0.0.1/x', ledger: ledger({ ...paid, status: 'pending' }) });
    const { db, applied } = fakeDb();
    expect((await handleStatusPoll({ paymentId: PAY_ID }, { db, providerFor: () => pending })).body).toEqual({ status: 'pending' });
    expect(applied).toHaveLength(0);
    const r = await handleStatusPoll({ paymentId: PAY_ID }, { db, providerFor: () => sandbox });
    expect(r.body.status).toBe('paid');
    expect(applied[0]).toMatchObject({ verifiedVia: 'server_fetch', eventId: 'fetch:sbx_gmp-abc:paid' });
  });
});

describe('Moyasar adapter (mocked HTTP, no network)', () => {
  it('creates an invoice checkout with halala amounts and Basic auth', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'inv_1', url: 'https://checkout.example/inv_1' }), { status: 201 }));
    const p = createMoyasarProvider({ secretKey: 'sk_test_x', webhookToken: 'tok', fetch: fetchMock });
    const s = await p.createCheckout({ merchantReference: 'GMP-1', amountHalala: 50000, currency: 'SAR', description: 'd', method: 'mada', returnUrl: 'https://app/b', webhookUrl: 'https://fn/w' });
    expect(s).toEqual({ providerPaymentId: 'inv_1', checkoutUrl: 'https://checkout.example/inv_1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.moyasar.com/v1/invoices');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('sk_test_x:')}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ amount: 50000, currency: 'SAR', metadata: { merchant_reference: 'GMP-1' } });
  });

  it('authenticates webhooks by secret token and maps fetched payments', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'pay_1', status: 'paid', amount: 50000, currency: 'SAR', fee: 1150, metadata: { merchant_reference: 'GMP-1' } })));
    const p = createMoyasarProvider({ secretKey: 'sk_test_x', webhookToken: 'tok', fetch: fetchMock });
    const raw = JSON.stringify({ id: 'evt', type: 'payment_paid', secret_token: 'tok', data: { id: 'pay_1', metadata: { merchant_reference: 'GMP-1' } } });
    expect(await p.verifyWebhook(raw, new Headers())).toMatchObject({ ok: true, event: { providerPaymentId: 'pay_1', merchantReference: 'GMP-1' } });
    expect(await p.verifyWebhook(raw.replace('"tok"', '"bad"'), new Headers())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await p.fetchPayment('pay_1')).toMatchObject({ status: 'paid', amountHalala: 50000, feeHalala: 1150, merchantReference: 'GMP-1' });
    await expect(p.fetchPayment('../../etc')).rejects.toThrow(/invalid payment id/);
  });
});

describe('Tap adapter (mocked HTTP, no network)', () => {
  it('verifies the hashstring header and converts decimal amounts exactly', async () => {
    const charge = { id: 'chg_1', amount: 1150.5, currency: 'SAR', status: 'CAPTURED', reference: { gateway: 'g1', payment: 'p1', transaction: 'GMP-2' }, transaction: { created: '1700000000000' } };
    const p = createTapProvider({ secretKey: 'sk_test_t', fetch: vi.fn(async () => new Response(JSON.stringify(charge))) });
    const hash = await tapHashString('sk_test_t', charge);
    expect(hash).toBe(await hmacSha256Hex('sk_test_t', 'x_idchg_1x_amount1150.50x_currencySARx_gateway_referenceg1x_payment_referencep1x_statusCAPTUREDx_created1700000000000'));
    expect(await p.verifyWebhook(JSON.stringify(charge), new Headers({ hashstring: hash }))).toMatchObject({ ok: true, event: { merchantReference: 'GMP-2' } });
    expect(await p.verifyWebhook(JSON.stringify({ ...charge, amount: 1 }), new Headers({ hashstring: hash }))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await p.fetchPayment('chg_1')).toMatchObject({ status: 'paid', amountHalala: 115050 });
  });
});

describe('provider selection guards live activation', () => {
  const l = ledger(null);
  it('refuses live mode unless explicitly enabled and refuses live keys in sandbox', () => {
    expect(selectProvider('moyasar', 'live', { MOYASAR_LIVE_SECRET_KEY: 'sk_live_x', MOYASAR_LIVE_WEBHOOK_TOKEN: 't' }, l)).toEqual({ ok: false, reason: 'live_payments_disabled' });
    expect(selectProvider('moyasar', 'sandbox', { MOYASAR_TEST_SECRET_KEY: 'sk_live_x', MOYASAR_TEST_WEBHOOK_TOKEN: 't' }, l)).toEqual({ ok: false, reason: 'moyasar_test_key_required' });
    expect(selectProvider('sandbox-provider', 'live', { GM_PAYMENTS_LIVE_ENABLED: 'true' }, l)).toEqual({ ok: false, reason: 'sandbox_provider_in_live_mode' });
    expect(selectProvider('tap', 'sandbox', {}, l)).toEqual({ ok: false, reason: 'tap_not_configured' });
    expect(selectProvider('moyasar', 'sandbox', { MOYASAR_TEST_SECRET_KEY: 'sk_test_x', MOYASAR_TEST_WEBHOOK_TOKEN: 't' }, l).ok).toBe(true);
  });
});

describe('notification dispatcher', () => {
  const row = (over: Partial<OutboxRow>): OutboxRow => ({ outbox_id: 'o1', channel: 'email', template_key: 'booking_created', target: '/bookings/GM-1', locale: 'en', recipient: 'a@example.test', attempts: 1, ...over });
  it('marks sent only with a provider id; failures and missing recipients are recorded', async () => {
    const completed: Array<[string, string]> = [];
    const db: OutboxDb = {
      claim: async () => [row({}), row({ outbox_id: 'o2', recipient: null }), row({ outbox_id: 'o3', channel: 'sms', recipient: '+966500000000' }), row({ outbox_id: 'o4' })],
      complete: async (id, outcome) => { completed.push([id, outcome]); return outcome; },
    };
    let call = 0;
    const email = createResendEmail({ apiKey: 'k', from: 'no-reply@example.test', appUrl: 'https://app.example', fetch: vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response(JSON.stringify({ id: 'msg_1' })) : new Response('{}', { status: 503 });
    }) });
    const counts = await dispatchOutbox(db, { email });
    expect(counts).toEqual({ claimed: 4, sent: 1, failed: 2, no_recipient: 1 });
    expect(completed).toEqual([['o1', 'sent'], ['o2', 'no_recipient'], ['o3', 'failed'], ['o4', 'failed']]);
  });
  it('renders minimal bilingual content without personal data and only same-site links', () => {
    expect(renderMessage('booking_created', 'ar', '/bookings/GM-1', 'https://app.example').text).toBe('تم إنشاء حجزك في Gulf Mover.\nhttps://app.example/bookings/GM-1');
    expect(renderMessage('booking_created', 'en', 'https://evil.example', 'https://app.example').text).toContain('\nhttps://app.example');
  });
});

describe('ZATCA QR TLV and PDF documents', () => {
  it('round-trips the five Phase-1 fields including Arabic seller names', () => {
    const b64 = encodeZatcaQr({ sellerName: 'شركة تجريبية', vatNumber: '300000000000003', timestamp: '2026-11-01T09:30:00Z', totalWithVat: '1150.00', vatTotal: '150.00' });
    expect(decodeZatcaQr(b64)).toEqual({ 1: 'شركة تجريبية', 2: '300000000000003', 3: '2026-11-01T09:30:00Z', 4: '1150.00', 5: '150.00' });
  });
  it('writes a structurally valid PDF with escaped text', () => {
    const bytes = buildPdf('Invoice (test)', [{ text: 'GM-INV-2026-000001', bold: true, size: 14 }, { text: 'Total SAR 1,000.00 (fictional)' }]);
    const text = String.fromCharCode(...bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(Total SAR 1,000.00 \\(fictional\\)) Tj');
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    expect(pdfSafeText('عربي')).toBe('????');
  });
});
