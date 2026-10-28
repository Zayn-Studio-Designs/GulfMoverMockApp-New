// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createOrg, createStaff, createUser, owner, q, useDatabase } from './pg';

/**
 * Upgrade path: a database migrated only to the last Phase 7 migration receives
 * real Phase-7-era data (corporate + individual bookings, held seats, tickets,
 * a verified sandbox payment and its invoice, a material request). Phase 8
 * migrations are then applied on top, and every record must survive intact.
 *
 * Opt-in (needs Docker): GM_DB_UPGRADE=1. Uses its own disposable container.
 */
const enabled = process.env.GM_DB_UPGRADE === '1';
const d = enabled ? describe : describe.skip;
const PORT = '54323';
const env = { ...process.env, GM_DB_CONTAINER: 'gm-db-upgrade', GM_DB_PORT: PORT };
const script = path.resolve(__dirname, '../../../scripts/db/local-db.sh');

d('Phase 7 → Phase 8 upgrade preserves bookings, seats, tickets and financial records', () => {
  const before: Record<string, string> = {};
  let corpBooking = ''; let indivBooking = ''; let paidPayment = ''; let outbound = ''; let back = '';

  beforeAll(async () => {
    execFileSync(script, ['up-to', '20261031100003'], { env, stdio: 'pipe' });
    useDatabase(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
    const staff = await createStaff('upg-ops', 'operations');
    const admin = await createUser('upg-corp');
    const org = await createOrg(`upg-${randomUUID().slice(0, 4)}`, 'corporate', admin);
    outbound = await owner(`select id from public.sailings where status = 'open' and departs_at > now() + interval '2 days' order by departs_at limit 1`);
    // Phase 7 seeded no return sailings (collision bug); create one the Phase 7 way.
    back = await owner(`insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
      select r.id, s.vessel_id, s.departs_at + interval '5 hours', 12, 'open' from public.routes r, public.sailings s
       where r.origin like 'Approved Anchorage%' and s.id = ${q(outbound)} returning id`);
    corpBooking = await asUser(admin, `select booking_id from public.create_booking(${q(randomUUID())}, ${q(org)}, ${q(outbound)}, 2,
      'Fictional Lead', 'lead@example.test', '+966500000010', null, ${q(back)}, 'PO-UPG')`);
    const indiv = await createUser('upg-indiv');
    const terms = await owner(`select version from public.service_policies where policy_type = 'booking_terms' limit 1`);
    indivBooking = await asUser(indiv, `select booking_id from public.create_individual_booking(${q(randomUUID())}, ${q(outbound)}, 1,
      'Fictional Individual', 'ind@example.test', '+966500000011', null, null, null, null, ${q(terms)})`);
    paidPayment = await asUser(indiv, `select public.initiate_payment(${q(indivBooking)}, 'mada')`);
    await asUser(staff, `select public.verify_payment(${q(paidPayment)}, true)`);
    await asUser(admin, `select public.submit_transfer_request(${q(org)}, 'materials', ${q(randomUUID())}, '{"description":"Pre-upgrade cargo","weight_kg":"10"}'::jsonb)`);
    for (const [k, sql] of Object.entries({
      bookings: `select count(*) || ':' || string_agg(reference || '/' || status || '/' || payment_status, ',' order by reference) from public.bookings`,
      seats: `select string_agg(id || '=' || seats_booked, ',' order by id) from public.sailings where seats_booked > 0`,
      tickets: `select string_agg(reference || '/' || status || '/' || qr_token, ',' order by reference) from public.tickets`,
      invoices: `select string_agg(invoice_number || '/' || amount_halala, ',') from public.invoices`,
      payments: `select string_agg(id || '/' || status || '/' || amount_halala, ',') from public.payments`,
      requests: `select string_agg(reference || '/' || status, ',') from public.transfer_requests`,
      legs: `select count(*) from public.booking_legs`,
    })) before[k] = await owner(sql);
    execFileSync(script, ['migrate'], { env, stdio: 'pipe' });
  }, 240_000);

  afterAll(() => {
    try { execFileSync(script, ['down'], { env, stdio: 'pipe' }); } catch { /* best effort */ }
  });

  it('keeps every booking, held seat, ticket (incl. QR secret), payment, invoice and request', async () => {
    expect(await owner(`select count(*) || ':' || string_agg(reference || '/' || status || '/' || payment_status, ',' order by reference) from public.bookings`)).toBe(before.bookings);
    expect(await owner(`select string_agg(id || '=' || seats_booked, ',' order by id) from public.sailings where seats_booked > 0`)).toBe(before.seats);
    expect(await owner(`select string_agg(reference || '/' || status || '/' || qr_token, ',' order by reference) from public.tickets`)).toBe(before.tickets);
    expect(await owner(`select string_agg(invoice_number || '/' || amount_halala, ',') from public.invoices`)).toBe(before.invoices);
    expect(await owner(`select string_agg(id || '/' || status || '/' || amount_halala, ',') from public.payments`)).toBe(before.payments);
    expect(await owner(`select string_agg(reference || '/' || status, ',') from public.transfer_requests`)).toBe(before.requests);
    expect(await owner(`select count(*) from public.booking_legs`)).toBe(before.legs);
  });

  it('backfills pricing and invoice fields without inventing VAT or holds', async () => {
    expect(await owner(`select total_halala || '/' || vat_halala || '/' || vat_mode || '/' || (hold_expires_at is null) from public.bookings where id = ${q(corpBooking)}`))
      .toBe('200000/0/not_configured/true');
    expect(await owner(`select status || '/' || total_halala || '/' || amount_paid_halala || '/' || sandbox from public.invoices where booking_id = ${q(indivBooking)}`))
      .toBe('paid/50000/50000/true');
    expect(await owner(`select count(*) from public.sailings where id in (${q(outbound)}, ${q(back)})`)).toBe('2');
  });

  it('pre-upgrade bookings continue through the Phase 8 lifecycle', async () => {
    const corpUser = await owner(`select created_by from public.bookings where id = ${q(corpBooking)}`);
    const pay = await asUser(corpUser, `select payment_id from public.begin_checkout(${q(corpBooking)}, 'visa', ${q(randomUUID())})`);
    expect(await asUser(corpUser, `select public.sandbox_simulate_payment(${q(pay)}, 'paid')`)).toBe('succeeded');
    expect(await owner(`select i.total_halala || '/' || (select count(*) from public.invoice_lines l where l.invoice_id = i.id) from public.invoices i where booking_id = ${q(corpBooking)}`))
      .toBe('200000/2');
  });
});
