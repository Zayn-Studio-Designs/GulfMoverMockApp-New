// @vitest-environment node
//
// Phase 6, section 7: the upgrade path. `supabase db reset` proves the migration chain applies to
// an empty database; it does NOT prove that a database which already holds reservations upgrades
// cleanly. The tickets migration contains exactly one data statement for that case (the
// "existing valid reservations" backfill) and this suite runs that statement, verbatim from the
// migration file, against legacy-shaped reservations.
//
// The legacy rows are produced by inserting a realistic reserved booking and legs and then deleting
// the tickets the leg trigger issued — the resulting state (a reserved booking with legs and no
// tickets) is precisely what a Phase 4 database contains. Nothing outside this suite's own fixture
// rows is touched, no database is dropped and no hosted project is involved.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { confirmedUser, futureIso, grantPlatformRole, localStackConfigured, quote, sql, type TestUser } from './helpers';

const MIGRATION = 'supabase/migrations/20261028101000_tickets_boarding_readiness.sql';
const MARKER = '-- Existing valid reservations also get one ticket per passenger per one-way leg.';

/** The backfill statement exactly as the migration ships it (no hand-copied SQL). */
function backfillStatement(): string {
  const file = readFileSync(join(process.cwd(), MIGRATION), 'utf8');
  const marker = file.indexOf(MARKER);
  const from = file.indexOf('insert into public.tickets', marker);
  const end = file.indexOf('do nothing;', from);
  if (marker < 0 || from < 0 || end < 0) throw new Error('backfill statement not found in the tickets migration');
  return file.slice(from, end + 'do nothing;'.length);
}

const suite = localStackConfigured ? describe : describe.skip;
suite('Phase 6: a database holding pre-ticket reservations upgrades without losing or inventing tickets', () => {
  let owner: TestUser; let boarding: TestUser; let orgId = ''; let outboundId = ''; let returnId = '';
  let legacyBookingId = ''; let outboundLegId = ''; let returnLegId = '';
  let backfill = '';
  const pier = `P6 upgrade pier ${randomUUID()}`;
  const anchorage = `P6 upgrade anchorage ${randomUUID()}`;

  beforeAll(async () => {
    const reviewer = await confirmedUser('p6up-reviewer'); grantPlatformRole(reviewer.id, 'super_admin');
    boarding = await confirmedUser('p6up-boarding'); grantPlatformRole(boarding.id, 'boarding_staff');
    owner = await confirmedUser('p6up-owner');
    const reg = await owner.client.rpc('register_company', {
      p_registration_key: randomUUID(), p_legal_name: `P6 upgrade company ${randomUUID()}`,
      p_profile_display_name: 'Fictional Owner',
    });
    expect(reg.error).toBeNull(); orgId = reg.data[0].id;
    expect((await reviewer.client.rpc('review_company', { p_organization_id: orgId, p_decision: 'approve' })).error).toBeNull();

    backfill = backfillStatement();
    const vessel = sql(`insert into public.vessels(name,passenger_capacity) values (${quote(`P6 upgrade vessel ${randomUUID()}`)},6) returning id`);
    const outRoute = sql(`insert into public.routes(origin,destination) values (${quote(pier)},${quote(anchorage)}) returning id`);
    const backRoute = sql(`insert into public.routes(origin,destination) values (${quote(anchorage)},${quote(pier)}) returning id`);
    outboundId = sql(`insert into public.sailings(vessel_id,route_id,departs_at,seat_capacity) values (${quote(vessel)},${quote(outRoute)},${quote(futureIso(96))},6) returning id`);
    returnId = sql(`insert into public.sailings(vessel_id,route_id,departs_at,seat_capacity) values (${quote(vessel)},${quote(backRoute)},${quote(futureIso(120))},6) returning id`);

    // A reservation in the pre-ticket shape: three passengers on the outbound sailing, two on the
    // return, and only two names on record (one passenger's name was never collected).
    legacyBookingId = sql(`insert into public.bookings
        (reference,organization_id,created_by,request_key,request_hash,passenger_count,contact_name,contact_email,contact_phone,passenger_names)
      values (${quote(`GM-${randomUUID().slice(0, 8).toUpperCase()}`)},${quote(orgId)},${quote(owner.id)},
        ${quote(randomUUID())},'legacy-fixture',3,'Fictional Lead','fiction@example.test','+966130000000',
        array['Legacy One','Legacy Two']) returning id`);
    outboundLegId = sql(`insert into public.booking_legs(booking_id,sailing_id,leg,passengers)
      values (${quote(legacyBookingId)},${quote(outboundId)},'outbound',3) returning id`);
    returnLegId = sql(`insert into public.booking_legs(booking_id,sailing_id,leg,passengers)
      values (${quote(legacyBookingId)},${quote(returnId)},'return',2) returning id`);
    // Remove the tickets the leg trigger just issued: this is the Phase 4 state.
    sql(`delete from public.tickets where booking_leg_id in (${quote(outboundLegId)},${quote(returnLegId)})`);
  }, 90_000);

  it('starts from a reservation that has legs but no tickets at all', () => {
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(legacyBookingId)}`)).toBe('0');
    expect(sql(`select count(*) from public.booking_legs where booking_id = ${quote(legacyBookingId)}`)).toBe('2');
  });

  it('the migration backfill issues one ticket per passenger per leg, without inventing names', () => {
    sql(backfill);
    expect(sql(`select count(*) from public.tickets where booking_leg_id = ${quote(outboundLegId)}`)).toBe('3');
    expect(sql(`select count(*) from public.tickets where booking_leg_id = ${quote(returnLegId)}`)).toBe('2');
    expect(sql(`select string_agg(passenger_name, ',' order by passenger_index) from public.tickets
      where booking_leg_id = ${quote(outboundLegId)} and passenger_name is not null`)).toBe('Legacy One,Legacy Two');
    // The passenger with no recorded name keeps a NULL name: the backfill never invents one.
    expect(sql(`select count(*) from public.tickets where booking_leg_id = ${quote(outboundLegId)} and passenger_name is null`)).toBe('1');
    expect(sql(`select count(distinct passenger_index) from public.tickets where booking_leg_id = ${quote(outboundLegId)}`)).toBe('3');
    // Every backfilled ticket is first class: formatted reference, own QR secret, valid, not boarded.
    expect(sql(`select count(*) from public.tickets where booking_leg_id = ${quote(outboundLegId)}
      and reference ~ '^TK-[0-9A-F]{24}$' and qr_token ~ '^[0-9a-f]{64}$' and status = 'valid' and boarded_at is null`)).toBe('3');
    expect(sql(`select count(distinct qr_token) from public.tickets where booking_id = ${quote(legacyBookingId)}`)).toBe('5');
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(legacyBookingId)} and created_at is null`)).toBe('0');
  });

  it('re-running the backfill changes nothing (idempotent, no duplicates)', () => {
    const before = sql(`select string_agg(reference, ',' order by reference) from public.tickets where booking_id = ${quote(legacyBookingId)}`);
    sql(backfill); sql(backfill);
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(legacyBookingId)}`)).toBe('5');
    expect(sql(`select string_agg(reference, ',' order by reference) from public.tickets where booking_id = ${quote(legacyBookingId)}`)).toBe(before);
  });

  it('a backfilled reservation is usable: the owner gets a QR and staff see the manifest', async () => {
    const ticket = sql(`select id from public.tickets where booking_leg_id = ${quote(outboundLegId)} order by passenger_index limit 1`);
    const code = await owner.client.rpc('get_ticket_qr', { p_ticket_id: ticket });
    expect(code.error).toBeNull();
    expect(code.data).toMatch(/^GMT1:[0-9a-f]{64}$/);
    const manifest = await boarding.client.rpc('ticket_manifest', { p_sailing_id: outboundId });
    expect(manifest.error).toBeNull();
    expect((manifest.data as unknown[]).length).toBe(3);
    // A stranger still sees none of it.
    const stranger = await confirmedUser('p6up-stranger');
    expect((await stranger.client.rpc('get_ticket_qr', { p_ticket_id: ticket })).error).not.toBeNull();
    expect((await stranger.client.from('tickets').select('id').eq('booking_id', legacyBookingId)).data).toEqual([]);
  });

  it('reservations created after the upgrade still issue tickets through the leg trigger', async () => {
    const booked = await owner.client.rpc('create_booking', {
      p_request_key: randomUUID(), p_organization_id: orgId, p_outbound_sailing_id: outboundId,
      p_passenger_count: 2, p_contact_name: 'Fictional Lead', p_contact_email: 'fiction@example.test',
      p_contact_phone: '+966130000000', p_return_sailing_id: returnId, p_passenger_names: ['Modern One'],
    });
    expect(booked.error).toBeNull();
    const bookingId: string = booked.data[0].booking_id;
    // Two passengers on two one-way legs: four tickets, each tied to its own leg's sailing.
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(bookingId)}`)).toBe('4');
    expect(sql(`select count(*) from public.tickets t join public.booking_legs l on l.id = t.booking_leg_id
      where t.booking_id = ${quote(bookingId)} and t.sailing_id <> l.sailing_id`)).toBe('0');
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(bookingId)} and passenger_name is null`)).toBe('0');
  });
});
