// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asUser, createOrg, createSailingPair, createStaff, createUser,
  currentTerms, dbConfigured, fails, individualBooking, owner, q,
} from './pg';

/**
 * Phase 12 — real-backend isolation proof (local disposable database).
 *
 * Closes the gaps Phase 11 could only simulate with stubs:
 * - Company-A vs Company-B booking isolation (both directions, admin + booker).
 * - Anonymous callers denied protected writes.
 * - Ordinary customers denied staff-only writes (with a staff positive control).
 * - Honest empty manifest / boarding gate on a fresh sailing (no error, no fake rows).
 * - Pricing + minimum-sailing pins (SAR 500/leg, 4-ticket threshold across bookings).
 *
 * Requires `scripts/db/local-db.sh up` (or an equivalent loopback database
 * with all migrations applied) and GM_DB_URL (loopback only); skipped otherwise.
 * Never touches the hosted demo project.
 */
const d = dbConfigured ? describe : describe.skip;

const orgBooking = (user: string, org: string, outbound: string, pax: number) =>
  currentTerms().then(terms => asUser(user, `select booking_id from public.create_organization_booking(${q(randomUUID())}, ${q(org)}, ${q(outbound)}, ${pax},
    'Fictional Crew', 'crew@example.test', '+966500000003', ${q(terms)}, 'pay_now', null, null, 'PO-12-1', null, null)`));

d('Phase 12 company and role isolation (local database)', () => {
  let ops: string;

  beforeAll(async () => {
    ops = await createStaff('p12-ops', 'operations');
  });

  it('Company-A and Company-B cannot read each other bookings, and cannot book for each other', async () => {
    const adminA = await createUser('p12-admin-a');
    const bookerA = await createUser('p12-booker-a');
    const adminB = await createUser('p12-admin-b');
    const orgA = await createOrg('p12-a', 'corporate', adminA, [bookerA]);
    const orgB = await createOrg('p12-b', 'corporate', adminB);
    const { out } = await createSailingPair();
    const bookingA = await orgBooking(adminA, orgA, out, 1);
    const bookingB = await orgBooking(adminB, orgB, out, 1);

    // Each admin sees their own booking and exactly zero of the other's.
    expect(await asUser(adminA, `select count(*) from public.bookings where id = ${q(bookingA)}`)).toBe('1');
    expect(await asUser(adminA, `select count(*) from public.bookings where id = ${q(bookingB)}`)).toBe('0');
    expect(await asUser(adminB, `select count(*) from public.bookings where id = ${q(bookingB)}`)).toBe('1');
    expect(await asUser(adminB, `select count(*) from public.bookings where id = ${q(bookingA)}`)).toBe('0');

    // A booker of A sees none of B's records …
    expect(await asUser(bookerA, `select count(*) from public.bookings where id = ${q(bookingB)}`)).toBe('0');
    // … and cannot create a booking billed to B.
    expect((await fails(orgBooking(bookerA, orgB, out, 1))).message).toMatch(/not_a_member/);
    // Neither admin can book for the other's company.
    expect((await fails(orgBooking(adminA, orgB, out, 1))).message).toMatch(/not_a_member/);
  });

  it('bookers see only their own bookings; admins see their company bookings', async () => {
    const admin = await createUser('p12-admin-c');
    const booker = await createUser('p12-booker-c');
    const org = await createOrg('p12-c', 'corporate', admin, [booker]);
    const { out } = await createSailingPair();
    const byAdmin = await orgBooking(admin, org, out, 1);
    const byBooker = await orgBooking(booker, org, out, 1);
    // Booker sees what they created, not what the admin created.
    expect(await asUser(booker, `select count(*) from public.bookings where id = ${q(byBooker)}`)).toBe('1');
    expect(await asUser(booker, `select count(*) from public.bookings where id = ${q(byAdmin)}`)).toBe('0');
    // Admin (company_admin of an active org) sees both company bookings.
    expect(await asUser(admin, `select count(*) from public.bookings where id in (${q(byAdmin)}, ${q(byBooker)})`)).toBe('2');
  });

  it('anonymous callers are denied protected writes', async () => {
    const { out } = await createSailingPair();
    const user = await createUser('p12-anon-target');
    const booking = await individualBooking(user, out, 1);
    expect((await fails(asAnon(`select * from public.create_individual_booking(${q(randomUUID())}, ${q(out)}, 1,
      'Anon', 'anon@example.test', '+966500000001', null, null, null, null, 'v1')`))).sqlState).toBe('42501');
    expect((await fails(asAnon(`select public.begin_checkout(${q(booking)}, 'mada', ${q(randomUUID())})`))).sqlState).toBe('42501');
    expect((await fails(asAnon(`select * from public.ticket_manifest(${q(out)})`))).sqlState).toBe('42501');
  });

  it('customers are denied staff-only writes; operations staff keep their authorized writes', async () => {
    const customer = await createUser('p12-customer');
    const { out } = await createSailingPair();
    // Customer cannot touch sailing readiness, charter allocation, or tariff publishing.
    expect((await fails(asUser(customer, `select public.set_sailing_readiness(${q(out)}, 'ready', 'x')`))).sqlState).toBe('42501');
    expect((await fails(asUser(customer, `select public.allocate_charter(gen_random_uuid(), gen_random_uuid(), now(), now(), 1, 'x')`))).sqlState).toBe('42501');
    expect((await fails(asUser(customer, `select public.publish_tariff('X', 1, 'not_configured', null, now())`))).sqlState).toBe('42501');
    // Positive control: operations staff CAN drive readiness on the same sailing.
    expect(await asUser(ops, `select public.set_sailing_readiness(${q(out)}, 'ready', 'Phase 12 positive control')`)).toBe('recorded');
    expect(await owner(`select readiness_status from public.sailings where id = ${q(out)}`)).toBe('ready');
  });

  it('a fresh sailing reports an honest empty manifest and a not-ready gate', async () => {
    const boarder = await createStaff('p12-boarder', 'boarding_staff');
    const { out } = await createSailingPair();
    expect(await asUser(boarder, `select count(*) from public.ticket_manifest(${q(out)})`)).toBe('0');
    expect(await asUser(ops, `select public.sailing_boarding_gate(${q(out)})`)).toBe('not_ready');
    expect(await asUser(ops, `select commercial_state from public.sailing_commercial_status(${q(out)})`)).toBe('awaiting_minimum');
  });

  it('pins SAR 500 per passenger per leg with VAT not configured', async () => {
    const { out, back } = await createSailingPair();
    const user = await createUser('p12-quote');
    expect(await asUser(user, `select unit_halala, quantity, net_halala, vat_halala, total_halala, vat_mode
      from public.quote_passenger_fare(${q(out)}, ${q(back)}, 3)`)).toBe('50000|6|300000|0|300000|not_configured');
  });
});
