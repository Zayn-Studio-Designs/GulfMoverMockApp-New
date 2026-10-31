// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asService, asUser, createSailingPair, createUser, dbConfigured, fails, individualBooking, owner, q } from './pg';

/**
 * Production-readiness audit — area 8: reconciliation of payments whose webhook was lost.
 * Migration 20261103000005_payment_reconciliation.sql (list_payments_to_reconcile).
 */
const d = dbConfigured ? describe : describe.skip;

d('payment reconciliation (local database)', () => {
  it('lists only stale pending checkouts, only to the service role, and a reconcile result is applied once', async () => {
    const { out } = await createSailingPair(12, 24 * 90);
    const user = await createUser('reconcile');
    const booking = await individualBooking(user, out, 1);
    const pay = await asUser(user, `select payment_id from public.begin_checkout(${q(booking)}, 'mada', ${q(randomUUID())})`);
    const ref = await owner(`select provider_ref from public.payments where id = ${q(pay)}`);
    const ppid = `pay_${randomUUID()}`;
    await asService(`select public.attach_provider_checkout(${q(pay)}, ${q(ppid)}, 'https://checkout.example.test/x')`);
    const listed = () => asService(`select count(*) from public.list_payments_to_reconcile(10, 200) where id = ${q(pay)}`);
    expect(await listed()).toBe('0'); // too recent
    await owner(`update public.payments set created_at = now() - interval '20 minutes' where id = ${q(pay)}`);
    expect(await listed()).toBe('1');
    expect((await fails(asUser(user, `select * from public.list_payments_to_reconcile(10, 50)`))).message).toMatch(/not authorized|permission denied/);
    // The provider says "paid": reconcile and a racing status poll share the event id -> applied once.
    const total = await owner(`select total_halala from public.bookings where id = ${q(booking)}`);
    const apply = () => asService(`select public.apply_payment_result('sandbox-provider', ${q(`fetch:${ppid}:paid`)}, 'reconcile_fetch', ${q(ref)}, ${q(ppid)}, 'paid', ${total}, 'SAR', 0, 'server_fetch', null)`);
    await Promise.allSettled([apply(), apply(), apply()]);
    expect(await owner(`select status from public.payments where id = ${q(pay)}`)).toBe('succeeded');
    expect(await owner(`select count(*) from public.invoices where booking_id = ${q(booking)}`)).toBe('1');
    expect(await listed()).toBe('0');
  }, 60000);
});
