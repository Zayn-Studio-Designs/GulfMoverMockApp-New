// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { confirmedUser, futureIso, grantPlatformRole, localStackConfigured, quote, sql, type TestUser } from './helpers';

const suite = localStackConfigured ? describe : describe.skip;
suite('Phase 4: security and tickets against local PostgreSQL/PostgREST', () => {
  let ops: TestUser; let owner: TestUser; let stranger: TestUser; let boarding: TestUser;
  let sailingId: string; let bookingId: string; let ticketId: string; let reference: string; let qr: string;
  beforeAll(async () => {
    ops = await confirmedUser('p4-ops'); owner = await confirmedUser('p4-owner');
    stranger = await confirmedUser('p4-stranger'); boarding = await confirmedUser('p4-boarding');
    grantPlatformRole(ops.id, 'operations'); grantPlatformRole(boarding.id, 'boarding_staff');
    const reviewer = await confirmedUser('p4-reviewer'); grantPlatformRole(reviewer.id, 'super_admin');
    const reg = await owner.client.rpc('register_company', {
      p_registration_key: randomUUID(), p_legal_name: `P4 company ${randomUUID()}`,
      p_profile_display_name: 'Fictional Owner',
    });
    expect(reg.error).toBeNull(); const orgId = reg.data[0].id;
    expect((await reviewer.client.rpc('review_company', { p_organization_id: orgId, p_decision: 'approve' })).error).toBeNull();
    const vessel = await ops.client.from('vessels').insert({ name: `P4 vessel ${randomUUID()}`, passenger_capacity: 8 }).select('id').single();
    expect(vessel.error).toBeNull();
    const route = await ops.client.from('routes').insert({ origin: `P4 pier ${randomUUID()}`, destination: 'Fictional anchorage' }).select('id').single();
    expect(route.error).toBeNull();
    const sailing = await ops.client.from('sailings').insert({ vessel_id: vessel.data!.id, route_id: route.data!.id, departs_at: futureIso(48), seat_capacity: 8 }).select('id').single();
    expect(sailing.error).toBeNull(); sailingId = sailing.data!.id;
    const args = { p_request_key: randomUUID(), p_organization_id: orgId, p_outbound_sailing_id: sailingId,
      p_passenger_count: 2, p_contact_name: 'Fictional Lead', p_contact_email: 'fiction@example.test', p_contact_phone: '+966130000000' };
    const booked = await owner.client.rpc('create_booking', args); expect(booked.error).toBeNull(); bookingId = booked.data[0].booking_id;
    const retry = await owner.client.rpc('create_booking', args); expect(retry.data[0].booking_id).toBe(bookingId);
    const tickets = await owner.client.from('tickets').select('id,reference,passenger_name').eq('booking_id', bookingId);
    expect(tickets.error).toBeNull(); expect(tickets.data).toHaveLength(2);
    ticketId = tickets.data![0].id; reference = tickets.data![0].reference;
    const code = await owner.client.rpc('get_ticket_qr', { p_ticket_id: ticketId }); expect(code.error).toBeNull(); qr = code.data;
  }, 60000);

  it('suspended staff lose privileges with the same JWT and cannot self-reactivate', async () => {
    const admin = await confirmedUser('p4-suspended-admin'); grantPlatformRole(admin.id, 'super_admin');
    sql(`update public.profiles set status = 'suspended' where id = ${quote(admin.id)}`);
    expect((await admin.client.rpc('has_platform_role', { p_roles: ['super_admin'] })).data).toBe(false);
    expect((await admin.client.from('profiles').update({ status: 'active' }).eq('id', admin.id)).error).not.toBeNull();
    expect((await admin.client.from('bookings').select('id').eq('id', bookingId)).data).toEqual([]);
    const write = await admin.client.from('vessels').insert({ name: `forbidden ${randomUUID()}` });
    expect(write.error).not.toBeNull();
  });
  it('revoked staff and suspended company administrators lose derived permissions immediately', async () => {
    const revoked = await confirmedUser('p4-revoked'); grantPlatformRole(revoked.id, 'boarding_staff');
    sql(`update public.role_assignments set status='suspended' where user_id=${quote(revoked.id)}`);
    expect((await revoked.client.rpc('ticket_manifest', { p_sailing_id: sailingId })).error?.code).toBe('42501');
    expect((await revoked.client.rpc('board_ticket', { p_code: reference, p_sailing_id: sailingId })).error?.code).toBe('42501');
    const member = await confirmedUser('p4-suspended-company');
    const reg = await member.client.rpc('register_company', { p_registration_key: randomUUID(), p_legal_name: `Restricted ${randomUUID()}`, p_profile_display_name: 'Fictional Administrator' });
    expect(reg.error).toBeNull();
    sql(`update public.profiles set status='suspended' where id=${quote(member.id)}`);
    expect((await member.client.rpc('has_org_role', { p_org: reg.data[0].id, p_roles: ['company_admin'] })).data).toBe(false);
    expect((await member.client.rpc('active_org_ids')).data).toEqual([]);
  });
  it('ordinary authenticated users cannot select internal staff IDs', async () => {
    for (const table of ['sailings', 'vessels', 'routes']) {
      expect((await owner.client.from(table).select('created_by,updated_by')).error).not.toBeNull();
      expect((await owner.client.from(table).select('id').limit(1)).error).toBeNull();
    }
  });
  it('tickets persist once per passenger per leg, contain no invented names and hide QR tokens', async () => {
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(bookingId)}`)).toBe('2');
    expect(sql(`select count(*) from public.tickets where booking_id = ${quote(bookingId)} and passenger_name is null`)).toBe('1');
    expect((await owner.client.from('tickets').select('qr_token')).error).not.toBeNull();
    expect(qr).toMatch(/^GMT1:[0-9a-f]{64}$/); expect(qr).not.toContain('Fictional');
  });
  it('other users cannot read tickets, retrieve QR or access manifests/boarding/clearance', async () => {
    expect((await stranger.client.from('tickets').select('id').eq('id', ticketId)).data).toEqual([]);
    for (const [fn, args] of [
      ['get_ticket_qr', { p_ticket_id: ticketId }], ['ticket_manifest', { p_sailing_id: sailingId }],
      ['board_ticket', { p_code: reference, p_sailing_id: sailingId }],
      ['set_sailing_readiness', { p_sailing_id: sailingId, p_status: 'ready', p_reason: 'Forged decision' }],
    ] as const) expect((await stranger.client.rpc(fn, args)).error).not.toBeNull();
  });
  it('server refuses pending readiness, unknown QR and wrong sailing without writing events', async () => {
    const scan = (code: string, sailing = sailingId) => boarding.client.rpc('board_ticket', { p_code: code, p_sailing_id: sailing });
    expect((await scan(qr)).data).toBe('not_ready');
    expect((await scan('GMT1:' + '0'.repeat(64))).data).toBe('not_found');
    // Different existing sailing; lock and revalidate the requested departure.
    const other = sql(`insert into public.sailings(route_id,vessel_id,departs_at,seat_capacity)
      select route_id,vessel_id,departs_at + interval '1 hour',8 from public.sailings where id=${quote(sailingId)} returning id`);
    expect((await scan(qr, other.split('\n')[0])).data).toBe('wrong_sailing');
    expect(sql(`select count(*) from public.boarding_events where ticket_id = ${quote(ticketId)}`)).toBe('0');
  });
  it('clearance decision is audited, retried without duplicates and does not require an invented four-ticket cancellation', async () => {
    const args = { p_sailing_id: sailingId, p_status: 'ready', p_reason: 'Internal readiness only, fictional exercise' };
    expect((await ops.client.rpc('set_sailing_readiness', args)).error).toBeNull();
    expect((await ops.client.rpc('set_sailing_readiness', args)).error).toBeNull();
    expect(sql(`select count(*) from public.sailing_readiness_events where sailing_id = ${quote(sailingId)}`)).toBe('1');
    const manifest = await boarding.client.rpc('ticket_manifest', { p_sailing_id: sailingId });
    expect(manifest.error).toBeNull(); expect(manifest.data).toHaveLength(2);
  });
  it('concurrent QR and reference boarding produces exactly one success and audit actor', async () => {
    const scans = await Promise.all(Array.from({ length: 8 }, (_, i) => boarding.client.rpc('board_ticket', { p_code: i % 2 ? reference : qr, p_sailing_id: sailingId })));
    expect(scans.every(s => !s.error)).toBe(true);
    expect(scans.filter(s => s.data === 'boarded')).toHaveLength(1);
    expect(scans.filter(s => s.data === 'already_boarded')).toHaveLength(7);
    expect(sql(`select count(*) from public.boarding_events where ticket_id = ${quote(ticketId)} and actor_user_id = ${quote(boarding.id)}`)).toBe('1');
    expect((await boarding.client.from('boarding_events').insert({ ticket_id: ticketId, sailing_id: sailingId, actor_user_id: owner.id })).error).not.toBeNull();
  });
  it('blocked/cancelled sailings and cancelled tickets cannot board', async () => {
    const second = sql(`select reference from public.tickets where booking_id = ${quote(bookingId)} and id <> ${quote(ticketId)}`);
    const scan = () => boarding.client.rpc('board_ticket', { p_code: second, p_sailing_id: sailingId });
    await ops.client.rpc('set_sailing_readiness', { p_sailing_id: sailingId, p_status: 'blocked', p_reason: 'Review needed' });
    expect((await scan()).data).toBe('not_ready');
    await ops.client.rpc('set_sailing_readiness', { p_sailing_id: sailingId, p_status: 'ready', p_reason: 'Reviewed internally' });
    sql(`update public.tickets set status='cancelled' where reference=${quote(second)}`);
    expect((await scan()).data).toBe('cancelled');
    await ops.client.from('sailings').update({ status: 'cancelled' }).eq('id', sailingId);
    expect((await scan()).data).toBe('sailing_cancelled');
  });
});
