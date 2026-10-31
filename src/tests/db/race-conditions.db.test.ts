// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asService, asUser, createOrg, createSailingPair, createStaff, createUser, currentTerms,
  dbConfigured, fails, individualBooking, owner, payInSandbox, q,
} from './pg';

/**
 * Production-readiness audit — area 1 (race conditions), real PostgreSQL.
 *
 * Every scenario fires its competing calls at the same moment from separate
 * database sessions (one psql process each) and then checks the invariant that
 * must survive: no oversold seats, no duplicate booking/payment/invoice/refund,
 * no credit-limit or payment-total overrun, no negative quantities.
 * Skipped without a local database (`npm run db:up`).
 */
const d = dbConfigured ? describe : describe.skip;
const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
const ok = <T>(r: PromiseSettledResult<T>[]) => r.filter((x): x is PromiseFulfilledResult<T> => x.status === 'fulfilled');
const reasons = (r: PromiseSettledResult<unknown>[]) => r.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map(x => String(x.reason?.message ?? x.reason));

d('race conditions under concurrent load (local database)', () => {
  let finA: string; let finB: string;
  beforeAll(async () => {
    finA = await createStaff('race-finA', 'finance');
    finB = await createStaff('race-finB', 'finance');
  }, 60000);

  it('40 users racing for the last 12 seats never oversell, and seat counters stay exact', async () => {
    const { out } = await createSailingPair(12, 24 * 60);
    const users = await Promise.all(Array.from({ length: 40 }, (_, i) => createUser(`seat-race-${i}`)));
    const results = await settle(users.map((u, i) => individualBooking(u, out, 1 + (i % 3))));
    const booked = await owner(`select seats_booked||'|'||seat_capacity from public.sailings where id = ${q(out)}`);
    const [seats, cap] = booked.split('|').map(Number);
    expect(seats).toBeLessThanOrEqual(cap);
    // The counter equals the passengers actually holding seats (no drift, no negative values).
    expect(Number(await owner(`select coalesce(sum(l.passengers), 0) from public.booking_legs l join public.bookings b on b.id = l.booking_id
      where l.sailing_id = ${q(out)} and b.status not in ('cancelled', 'expired', 'refunded')`))).toBe(seats);
    expect(Number(await owner(`select count(*) from public.tickets where sailing_id = ${q(out)}`))).toBe(seats);
    expect(ok(results).length).toBeGreaterThan(0);
    for (const reason of reasons(results)) expect(reason).toMatch(/sailing_full|not enough seats|capacity/i);
  }, 120000);

  it('the same booking request sent 10 times at once creates exactly one booking', async () => {
    const { out } = await createSailingPair(12, 24 * 61);
    const user = await createUser('replay-race');
    const key = randomUUID();
    const results = await settle(Array.from({ length: 10 }, () => individualBooking(user, out, 2, null, key)));
    const ids = new Set(ok(results).map(r => r.value));
    expect(ids.size).toBe(1);
    expect(await owner(`select count(*) from public.bookings where created_by = ${q(user)} and request_key = ${q(key)}`)).toBe('1');
    expect(await owner(`select seats_booked from public.sailings where id = ${q(out)}`)).toBe('2');
  }, 60000);

  it('parallel checkouts for one booking allow only one in-flight payment', async () => {
    const { out } = await createSailingPair(12, 24 * 62);
    const user = await createUser('checkout-race');
    const booking = await individualBooking(user, out, 1);
    const results = await settle(Array.from({ length: 8 }, () =>
      asUser(user, `select payment_id from public.begin_checkout(${q(booking)}, 'mada', ${q(randomUUID())})`)));
    expect(ok(results).length).toBeGreaterThan(0);
    expect(await owner(`select count(*) from public.payments where booking_id = ${q(booking)} and status in ('initiated', 'pending')`)).toBe('1');
  }, 60000);

  it('duplicate payment confirmations (8 at once) capture once and issue exactly one invoice', async () => {
    const { out } = await createSailingPair(12, 24 * 63);
    const user = await createUser('webhook-race');
    const booking = await individualBooking(user, out, 1);
    const ref = await asUser(user, `select merchant_reference from public.begin_checkout(${q(booking)}, 'mada', ${q(randomUUID())})`);
    const total = await owner(`select total_halala from public.bookings where id = ${q(booking)}`);
    const providerId = `pay_${randomUUID()}`;
    // Same provider event delivered repeatedly + distinct events for the same payment, all concurrent.
    const evt = `evt-${randomUUID()}`;
    const calls = [...Array.from({ length: 4 }, () => evt), ...Array.from({ length: 4 }, () => `evt-${randomUUID()}`)]
      .map(e => asService(`select public.apply_payment_result('sandbox-provider', ${q(e)}, 'payment_paid', ${q(ref)}, ${q(providerId)}, 'paid', ${total}, 'SAR', 0, 'webhook', null)`));
    await settle(calls);
    expect(await owner(`select count(*) from public.payments where booking_id = ${q(booking)} and status = 'succeeded'`)).toBe('1');
    expect(await owner(`select count(*) from public.invoices where booking_id = ${q(booking)}`)).toBe('1');
    expect(await owner(`select payment_status from public.bookings where id = ${q(booking)}`)).toBe('paid');
    expect(await owner(`select count(*) from public.payment_provider_events where event_id = ${q(evt)}`)).toBe('1');
  }, 60000);

  it('parallel sandbox "pay" clicks never double-capture', async () => {
    const { out } = await createSailingPair(12, 24 * 64);
    const user = await createUser('double-click');
    const booking = await individualBooking(user, out, 1);
    const pay = await asUser(user, `select payment_id from public.begin_checkout(${q(booking)}, 'mada', ${q(randomUUID())})`);
    await settle(Array.from({ length: 6 }, () => asUser(user, `select public.sandbox_simulate_payment(${q(pay)}, 'paid')`)));
    expect(await owner(`select count(*) from public.invoices where booking_id = ${q(booking)}`)).toBe('1');
    expect(await owner(`select count(*) from public.payments where booking_id = ${q(booking)} and status = 'succeeded'`)).toBe('1');
  }, 60000);

  it('concurrent on-account bookings can never exceed the company credit limit', async () => {
    const admin = await createUser('credit-race-admin');
    const org = await createOrg(`credit-race-${randomUUID().slice(0, 6)}`, 'corporate', admin);
    await asUser(finA, `select public.set_organization_credit(${q(org)}, 250000, 30)`); // room for 5 one-way seats
    await asUser(finB, `select public.set_credit_status(${q(org)}, 'active', 'Facility (fictional)')`);
    const { out } = await createSailingPair(40, 24 * 65);
    const terms = await currentTerms();
    const results = await settle(Array.from({ length: 12 }, () => asUser(admin, `select booking_id from public.create_organization_booking(${q(randomUUID())}, ${q(org)}, ${q(out)}, 1,
      'Fictional Crew', 'crew@example.test', '+966500000003', ${q(terms)}, 'on_account', null, null, 'PO-RACE', null, null)`)));
    const outstanding = Number(await owner(`select coalesce(sum(total_halala - amount_paid_halala), 0) from public.invoices
      where organization_id = ${q(org)} and settlement_mode = 'on_account' and status in ('issued', 'partially_paid')`));
    expect(outstanding).toBeLessThanOrEqual(250000);
    expect(ok(results).length).toBe(outstanding / 50000);
    for (const reason of reasons(results)) expect(reason).toMatch(/credit_limit_exceeded/);
  }, 120000);

  it('concurrent bank payments against one invoice can never overpay it', async () => {
    const admin = await createUser('overpay-admin');
    const org = await createOrg(`overpay-${randomUUID().slice(0, 6)}`, 'corporate', admin);
    await asUser(finA, `select public.set_organization_credit(${q(org)}, 900000, 30)`);
    await asUser(finB, `select public.set_credit_status(${q(org)}, 'active', 'Facility (fictional)')`);
    const { out } = await createSailingPair(12, 24 * 66);
    const terms = await currentTerms();
    const booking = await asUser(admin, `select booking_id from public.create_organization_booking(${q(randomUUID())}, ${q(org)}, ${q(out)}, 2,
      'Fictional Crew', 'crew@example.test', '+966500000003', ${q(terms)}, 'on_account', null, null, 'PO-PAY', null, null)`);
    const invoice = await owner(`select id from public.invoices where booking_id = ${q(booking)}`);
    // Each transfer pays 60% of the invoice: only one may be recorded.
    const results = await settle(Array.from({ length: 6 }, (_, i) => asUser(finA, `select public.record_account_payment(${q(invoice)}, 60000, ${q(`BANK-${i}`)})`)));
    expect(ok(results)).toHaveLength(1);
    expect(await owner(`select amount_paid_halala||'|'||total_halala from public.invoices where id = ${q(invoice)}`)).toBe('60000|100000');
  }, 60000);

  it('parallel refund requests open at most one refund and never exceed the captured amount', async () => {
    const { out } = await createSailingPair(12, 24 * 67);
    const user = await createUser('refund-race');
    const booking = await individualBooking(user, out, 1);
    await payInSandbox(user, booking);
    const pay = await owner(`select id from public.payments where booking_id = ${q(booking)} and status = 'succeeded'`);
    await settle(Array.from({ length: 6 }, () => asUser(finA, `select public.request_refund(${q(pay)}, 50000, 'Duplicate refund attempt (fictional)')`)));
    expect(await owner(`select count(*) from public.refunds where payment_id = ${q(pay)} and status in ('pending_review', 'approved', 'processing')`)).toBe('1');
  }, 60000);

  it('the database itself refuses negative seats, oversold seats, payload overruns and invoice overpayment', async () => {
    const { out } = await createSailingPair(12, 24 * 68);
    expect((await fails(owner(`update public.sailings set seats_booked = -1 where id = ${q(out)}`))).sqlState).toBe('23514');
    expect((await fails(owner(`update public.sailings set seats_booked = 13 where id = ${q(out)}`))).sqlState).toBe('23514');
    expect((await fails(owner(`update public.sailings set payload_capacity_kg = 100, payload_booked_kg = 101 where id = ${q(out)}`))).sqlState).toBe('23514');
    const inv = await owner(`select id from public.invoices limit 1`);
    if (inv) expect((await fails(owner(`update public.invoices set amount_paid_halala = total_halala + 1 where id = ${q(inv)}`))).sqlState).toMatch(/23514|P0001|42501/);
  }, 60000);

  it('a duplicate company registration fired 8 times at once creates one company', async () => {
    const user = await createUser('reg-race');
    const key = randomUUID();
    const results = await settle(Array.from({ length: 8 }, () => asUser(user, `select id from public.register_company(${q(key)},
      'Race Test Shipping LLC', 'Race Tester', 'Race Test', null, null, 'race@example.test', '+966500000009', 'en')`)));
    expect(new Set(ok(results).map(r => r.value)).size).toBe(1);
    expect(await owner(`select count(*) from public.organizations where registration_key = ${q(key)}`)).toBe('1');
  }, 60000);
});
