// Production-readiness audit — area 8: a payment whose webhook was lost is completed by the
// scheduled reconciliation, through the same idempotent path as the customer's status poll.
import { describe, expect, it, vi } from 'vitest';
import { handleReconcile, handleStatusPoll, type ApplyArgs, type PaymentRecord, type PaymentsDb } from '../../supabase/functions/_shared/payments/handler';
import type { PaymentProvider, ProviderPayment } from '../../supabase/functions/_shared/payments/types';

const rec = (id: string, ppid: string): PaymentRecord => ({ id, provider: 'moyasar', provider_payment_id: ppid, checkout_url: null, mode: 'sandbox', status: 'pending' });
const remote = (ppid: string, status: ProviderPayment['status']): ProviderPayment =>
  ({ providerPaymentId: ppid, merchantReference: `GMP-${ppid}`, status, amountHalala: 50000, currency: 'SAR', feeHalala: 0, failureReason: null });

function setup(stale: PaymentRecord[], remoteStatus: Record<string, ProviderPayment['status'] | Error>) {
  const applied: ApplyArgs[] = [];
  const db: PaymentsDb = {
    beginCheckout: vi.fn(), readPaymentAsCaller: async id => stale.find(r => r.id === id) ?? null, attachCheckout: vi.fn(),
    applyResult: async a => { applied.push(a); return 'applied'; },
    listPaymentsToReconcile: async () => stale,
  };
  const provider = { id: 'moyasar', fetchPayment: async (ppid: string) => {
    const s = remoteStatus[ppid]; if (s instanceof Error) throw s; return remote(ppid, s);
  } } as unknown as PaymentProvider;
  return { db, applied, providerFor: () => provider };
}

describe('scheduled payment reconciliation', () => {
  it('applies captured / failed results, leaves pending ones, and survives a provider error', async () => {
    const { db, applied, providerFor } = setup([rec('a', 'p1'), rec('b', 'p2'), rec('c', 'p3'), rec('d', 'p4')],
      { p1: 'paid', p2: 'pending', p3: new Error('provider 503'), p4: 'failed' });
    const r = await handleReconcile({ db, providerFor });
    expect(r.body).toEqual({ checked: 4, applied: 2, still_pending: 1, provider_unavailable: 0, errors: 1 });
    expect(r.status).toBe(207);
    expect(applied.map(a => [a.providerPaymentId, a.status, a.verifiedVia])).toEqual([['p1', 'paid', 'server_fetch'], ['p4', 'failed', 'server_fetch']]);
  });

  it('uses the SAME event id as the customer status poll, so a poll and a reconcile can never double-apply', async () => {
    const stale = [rec('11111111-1111-4111-8111-111111111111', 'p9')];
    const a = setup(stale, { p9: 'paid' });
    await handleReconcile({ db: a.db, providerFor: a.providerFor });
    await handleStatusPoll({ paymentId: '11111111-1111-4111-8111-111111111111' }, { db: a.db, providerFor: a.providerFor });
    expect(new Set(a.applied.map(x => x.eventId)).size).toBe(1);
  });

  it('is not available without the reconcile query (fails closed)', async () => {
    const { db, providerFor } = setup([], {});
    delete (db as { listPaymentsToReconcile?: unknown }).listPaymentsToReconcile;
    expect((await handleReconcile({ db, providerFor })).status).toBe(501);
  });
});
