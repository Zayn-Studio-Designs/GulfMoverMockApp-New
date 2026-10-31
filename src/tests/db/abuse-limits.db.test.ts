// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asUser, createOrg, createSailingPair, createStaff, createUser, dbConfigured, fails, individualBooking, owner, payInSandbox, q } from './pg';

/**
 * Production-readiness audit — area 3 (rate limiting), real PostgreSQL.
 * Migration 20261103000003_abuse_limits.sql: per-user limits on bookings, unpaid holds,
 * checkouts, material/charter requests, registrations and invitations.
 */
const d = dbConfigured ? describe : describe.skip;

d('abuse limits on write endpoints (local database)', () => {
  it('one account cannot hoard seats: the 6th unpaid hold is refused, paying one frees a slot', async () => {
    const { out } = await createSailingPair(40, 24 * 80);
    const user = await createUser('hoarder');
    const held: string[] = [];
    for (let i = 0; i < 5; i++) held.push(await individualBooking(user, out, 1));
    const err = await fails(individualBooking(user, out, 1));
    expect(err.sqlState).toBe('54000');
    expect(err.message).toMatch(/^too_many_unpaid_holds/);
    await payInSandbox(user, held[0]);
    expect(await individualBooking(user, out, 1)).toMatch(/^[0-9a-f-]{36}$/);
  }, 60000);

  it('the hold limit holds under 12 parallel requests from the same account', async () => {
    const { out } = await createSailingPair(40, 24 * 81);
    const user = await createUser('parallel-hoarder');
    await Promise.allSettled(Array.from({ length: 12 }, () => individualBooking(user, out, 1)));
    expect(Number(await owner(`select count(*) from public.bookings where created_by = ${q(user)} and payment_status = 'unpaid'`))).toBe(5);
  }, 60000);

  it('more than 10 new bookings in 10 minutes is refused even when every booking is paid', async () => {
    const { out } = await createSailingPair(40, 24 * 82);
    const user = await createUser('rapid');
    for (let i = 0; i < 10; i++) await payInSandbox(user, await individualBooking(user, out, 1));
    const err = await fails(individualBooking(user, out, 1));
    expect(err.sqlState).toBe('54000');
    expect(err.message).toMatch(/^rate_limited/);
  }, 120000);

  it('idempotent retries are never counted against the limit', async () => {
    const { out } = await createSailingPair(40, 24 * 83);
    const user = await createUser('retrier');
    const key = randomUUID();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(await individualBooking(user, out, 1, null, key));
    expect(ids.size).toBe(1);
  }, 60000);

  it('ATCO staff booking on behalf of customers are not limited', async () => {
    const { out } = await createSailingPair(40, 24 * 84);
    const ops = await createStaff('limit-ops', 'operations');
    for (let i = 0; i < 7; i++) await individualBooking(ops, out, 1);
    expect(Number(await owner(`select count(*) from public.bookings where created_by = ${q(ops)}`))).toBe(7);
  }, 60000);

  it('material/charter requests are limited to 10 per hour per user', async () => {
    const admin = await createUser('req-admin');
    const org = await createOrg(`req-${randomUUID().slice(0, 6)}`, 'corporate', admin);
    const submit = () => asUser(admin, `select public.submit_transfer_request(${q(org)}, 'charter', ${q(randomUUID())}, '{"description":"Fictional charter"}'::jsonb)`);
    for (let i = 0; i < 10; i++) await submit();
    const err = await fails(submit());
    expect(err.sqlState).toBe('54000');
    expect(err.message).toMatch(/^rate_limited/);
  }, 60000);

  it('limits are configurable without a code change', async () => {
    const { out } = await createSailingPair(40, 24 * 85);
    const user = await createUser('configurable');
    const before = await owner(`select value::text from public.platform_settings where key = 'limits.unpaid_holds_per_user'`);
    try {
      await owner(`update public.platform_settings set value = '{"value": 2}' where key = 'limits.unpaid_holds_per_user'`);
      await individualBooking(user, out, 1); await individualBooking(user, out, 1);
      expect((await fails(individualBooking(user, out, 1))).message).toMatch(/^too_many_unpaid_holds/);
    } finally {
      await owner(`update public.platform_settings set value = ${q(before)}::jsonb where key = 'limits.unpaid_holds_per_user'`);
    }
  }, 60000);
});
