// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PASSWORD, anonClient, confirmedUser, email, futureIso, grantPlatformRole, grantRoleOnly, latestMailTo, localStackConfigured,
  openVerifyLink, quote, sql, verifyLink, type TestUser,
} from './helpers';

/**
 * REAL local-Supabase integration suite: GoTrue (auth + Mailpit e-mail), PostgREST and
 * PostgreSQL RLS/RPCs — nothing mocked. Skipped unless the GM_IT_* variables point at a
 * loopback stack (see docs/backend/phase3-approval-bookings.md §Local testing).
 */
const suite = localStackConfigured ? describe : describe.skip;

const registration = (key: string, legalName: string) => ({
  p_registration_key: key, p_legal_name: legalName, p_profile_display_name: 'IT Person',
  p_display_name: null, p_registration_number: null, p_billing_contact: null,
  p_contact_email: null, p_contact_phone: null, p_language: 'en',
});

async function registerCompany(user: TestUser, legalName: string) {
  const { data, error } = await user.client.rpc('register_company', registration(randomUUID(), legalName));
  if (error) throw new Error(`register_company: ${error.message}`);
  return (data as Array<{ id: string; status: string }>)[0];
}

const bookingArgs = (orgId: string, sailingId: string, extra: Record<string, unknown> = {}) => ({
  p_request_key: randomUUID(), p_organization_id: orgId, p_outbound_sailing_id: sailingId,
  p_passenger_count: 1, p_contact_name: 'IT Lead Passenger', p_contact_email: 'lead@example.test',
  p_contact_phone: '+966 13 000 0000', ...extra,
});

const events = (orgId: string) =>
  sql(`select decision || ':' || coalesce(reason, '') from public.approval_events where subject_type = 'organization' and subject_id = ${quote(orgId)} order by occurred_at, id`)
    .split('\n').filter(Boolean);

suite('local Supabase: authentication (GoTrue + Mailpit)', () => {
  it('sign-up requires e-mail confirmation: no session until the emailed link is used', async () => {
    const address = email('signup');
    const client = anonClient();
    const { data, error } = await client.auth.signUp({ email: address, password: PASSWORD, options: { data: { display_name: 'IT Signup' } } });
    expect(error).toBeNull();
    expect(data.session).toBeNull(); // confirmation pending
    const early = await anonClient().auth.signInWithPassword({ email: address, password: PASSWORD });
    expect(early.error?.code).toBe('email_not_confirmed');

    const mail = await latestMailTo(address);
    const redirect = await openVerifyLink(verifyLink(mail));
    expect(redirect.hash).toContain('access_token=');

    const signedIn = await anonClient().auth.signInWithPassword({ email: address, password: PASSWORD });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.session).not.toBeNull();
  });

  it('sign-in with a wrong password is refused with invalid_credentials; sign-out ends the session', async () => {
    const user = await confirmedUser('signout');
    const wrong = await anonClient().auth.signInWithPassword({ email: user.email, password: 'wrong-password-1' });
    expect(wrong.error?.code).toBe('invalid_credentials');
    expect((await user.client.auth.getSession()).data.session).not.toBeNull();
    const out = await user.client.auth.signOut();
    expect(out.error).toBeNull();
    expect((await user.client.auth.getSession()).data.session).toBeNull();
    const after = await user.client.rpc('my_company_memberships');
    expect(after.error).not.toBeNull(); // anon may not execute it
  });

  it('password reset: the e-mailed recovery link returns to /auth/reset-callback with a recovery session that can set a new password', async () => {
    const user = await confirmedUser('reset');
    const redirectTo = 'http://127.0.0.1:3000/auth/reset-callback';
    const req = await anonClient().auth.resetPasswordForEmail(user.email, { redirectTo });
    expect(req.error).toBeNull();
    const mail = await latestMailTo(user.email);
    const redirect = await openVerifyLink(verifyLink(mail));
    expect(`${redirect.origin}${redirect.pathname}`).toBe(redirectTo);
    const fragment = new URLSearchParams(redirect.hash.slice(1));
    expect(fragment.get('type')).toBe('recovery');

    const recovery = anonClient();
    const set = await recovery.auth.setSession({ access_token: fragment.get('access_token')!, refresh_token: fragment.get('refresh_token')! });
    expect(set.error).toBeNull();
    const update = await recovery.auth.updateUser({ password: 'it-NewPassw0rd-2' });
    expect(update.error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: PASSWORD })).error?.code).toBe('invalid_credentials');
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: 'it-NewPassw0rd-2' })).error).toBeNull();
  });

  it('an expired/used recovery link redirects with an error instead of a session', async () => {
    const user = await confirmedUser('reused');
    await anonClient().auth.resetPasswordForEmail(user.email, { redirectTo: 'http://127.0.0.1:3000/auth/reset-callback' });
    const link = verifyLink(await latestMailTo(user.email));
    await openVerifyLink(link);              // first use consumes the token
    const second = await openVerifyLink(link); // second use must fail
    const params = new URLSearchParams(second.hash.slice(1) || second.search.slice(1));
    expect(params.get('error_code') ?? params.get('error')).toBeTruthy();
    expect(second.hash).not.toContain('access_token=');
  });
});

suite('local Supabase: company registration, onboarding reads and ATCO review', () => {
  let customer: TestUser;
  let other: TestUser;
  let admin: TestUser;
  let ops: TestUser;

  beforeAll(async () => {
    [customer, other, admin, ops] = await Promise.all([
      confirmedUser('customer'), confirmedUser('other'), confirmedUser('admin'), confirmedUser('ops'),
    ]);
    grantPlatformRole(admin.id, 'super_admin');
    grantPlatformRole(ops.id, 'operations');
  });

  it('register_company is idempotent per key and creates a pending org, one admin membership and one submitted event', async () => {
    const key = randomUUID();
    const first = await customer.client.rpc('register_company', registration(key, `IT Pending Co ${key.slice(0, 4)}`));
    expect(first.error).toBeNull();
    const row = (first.data as Array<{ id: string; status: string; outcome: string }>)[0];
    expect(row).toMatchObject({ status: 'pending', outcome: 'created' });
    const replay = await customer.client.rpc('register_company', registration(key, `IT Pending Co ${key.slice(0, 4)}`));
    expect((replay.data as Array<{ id: string; outcome: string }>)[0]).toMatchObject({ id: row.id, outcome: 'replayed' });
    const mismatch = await customer.client.rpc('register_company', registration(key, 'Different Name'));
    expect(mismatch.error?.message).toMatch(/^payload_mismatch/);
    expect(sql(`select count(*) from public.organizations where registration_key = ${quote(key)}`)).toBe('1');
    expect(sql(`select count(*) from public.organization_memberships where organization_id = ${quote(row.id)} and membership_role = 'company_admin'`)).toBe('1');
    expect(events(row.id)).toEqual(['submitted:']);
  });

  it('my_company_memberships returns only the caller\'s own memberships, including status, without reasons', async () => {
    const org = await registerCompany(other, 'IT Other Co');
    const mine = await customer.client.rpc('my_company_memberships');
    expect(mine.error).toBeNull();
    const rows = mine.data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.organization_id !== org.id)).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(['display_name', 'legal_name', 'membership_role', 'membership_status', 'organization_id', 'organization_status']);
    // Another customer's organisation is invisible through the table, too.
    const peek = await customer.client.from('organizations').select('id').eq('id', org.id);
    expect(peek.data).toEqual([]);
  });

  it('an ordinary user and a company admin cannot approve — not even their own registration', async () => {
    const org = await registerCompany(customer, 'IT Self Approve Co');
    const self = await customer.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(self.error?.code).toBe('42501');
    const stranger = await other.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(stranger.error?.code).toBe('42501');
    const operations = await ops.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(operations.error?.code).toBe('42501'); // operations may view, not decide
    const anonymous = await anonClient().rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(anonymous.error).not.toBeNull();
    // The raw table path is closed as well.
    const patch = await customer.client.from('organizations').update({ status: 'approved' }).eq('id', org.id).select();
    expect(patch.error?.code).toBe('42501');
    const adminPatch = await admin.client.from('organizations').update({ status: 'approved' }).eq('id', org.id).select();
    expect(adminPatch.error?.code).toBe('42501');
    expect(sql(`select status from public.organizations where id = ${quote(org.id)}`)).toBe('pending');
    expect(events(org.id)).toEqual(['submitted:']);
  });

  it('a super_admin approves a pending company once; retries are unchanged and add no event; contradictory decisions are refused', async () => {
    const org = await registerCompany(customer, 'IT Approve Co');
    const list = await admin.client.from('organizations').select('id, legal_name, status').eq('status', 'pending');
    expect((list.data ?? []).some(o => o.id === org.id)).toBe(true);
    const approve = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(approve.error).toBeNull();
    expect((approve.data as Array<{ status: string; outcome: string }>)[0]).toMatchObject({ status: 'approved', outcome: 'decided' });
    const again = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect((again.data as Array<{ outcome: string }>)[0].outcome).toBe('unchanged');
    const contradict = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'reject', p_reason: 'late change' });
    expect(contradict.error?.code).toBe('55000');
    expect(sql(`select status || ':' || (approved_by = ${quote(admin.id)}) from public.organizations where id = ${quote(org.id)}`)).toBe('approved:true');
    expect(events(org.id)).toEqual(['submitted:', 'approved:']);
    expect(sql(`select actor_user_id from public.approval_events where subject_id = ${quote(org.id)} and decision = 'approved'`)).toBe(admin.id);
  });

  it('concurrent approvals of the same company produce exactly one approval event', async () => {
    const org = await registerCompany(other, 'IT Race Co');
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' })));
    const outcomes = results.map(r => (r.data as Array<{ outcome: string }> | null)?.[0]?.outcome).sort();
    expect(outcomes).toEqual(['decided', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(events(org.id)).toEqual(['submitted:', 'approved:']);
  });

  it('rejection requires a reason, records it in the audit event, and the member sees the status but not the reason', async () => {
    const org = await registerCompany(other, 'IT Reject Co');
    const noReason = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'reject' });
    expect(noReason.error?.code).toBe('22023');
    const reject = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'reject', p_reason: 'Registration documents incomplete' });
    expect(reject.error).toBeNull();
    const retry = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'reject', p_reason: 'Registration documents incomplete' });
    expect((retry.data as Array<{ outcome: string }>)[0].outcome).toBe('unchanged');
    const approveAfter = await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(approveAfter.error?.code).toBe('55000');
    expect(events(org.id)).toEqual(['submitted:', 'rejected:Registration documents incomplete']);

    const memberView = await other.client.rpc('my_company_memberships');
    const row = (memberView.data as Array<Record<string, unknown>>).find(r => r.organization_id === org.id);
    expect(row?.organization_status).toBe('rejected');
    expect(JSON.stringify(memberView.data)).not.toContain('Registration documents incomplete');
    const memberEvents = await other.client.from('approval_events').select('reason').eq('subject_id', org.id);
    expect(memberEvents.data).toEqual([]); // hidden from members of a rejected organisation (A20)
  });

  it('invalid ids, decisions and unknown organisations are refused', async () => {
    expect((await admin.client.rpc('review_company', { p_organization_id: randomUUID(), p_decision: 'approve' })).error?.code).toBe('P0002');
    const org = await registerCompany(other, 'IT Invalid Co');
    expect((await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'suspend' })).error?.code).toBe('22023');
    expect((await admin.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve', p_reason: 'note' })).error?.code).toBe('22023');
  });

  it('a super_admin role without a provisioned profile cannot approve (clear error, nothing written)', async () => {
    const bare = await confirmedUser('bare-admin');
    grantRoleOnly(bare.id, 'super_admin');
    const org = await registerCompany(other, 'IT Bare Admin Co');
    const res = await bare.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(res.error?.code).toBe('55000');
    expect(res.error?.message).toMatch(/^reviewer_profile_missing/);
    expect(events(org.id)).toEqual(['submitted:']);
  });

  it('a suspended super_admin cannot approve', async () => {
    const suspended = await confirmedUser('suspended-admin');
    grantPlatformRole(suspended.id, 'super_admin');
    sql(`update public.profiles set status = 'suspended' where id = ${quote(suspended.id)}`);
    const org = await registerCompany(other, 'IT Suspended Admin Co');
    const res = await suspended.client.rpc('review_company', { p_organization_id: org.id, p_decision: 'approve' });
    expect(res.error?.code).toBe('42501');
    expect(sql(`select status from public.organizations where id = ${quote(org.id)}`)).toBe('pending');
  });

  it('a reviewer cannot decide on an organisation they belong to', async () => {
    const own = await registerCompany(admin, 'IT Admin Own Co');
    const res = await admin.client.rpc('review_company', { p_organization_id: own.id, p_decision: 'approve' });
    expect(res.error?.code).toBe('42501');
    expect(res.error?.message).toMatch(/^conflict_of_interest/);
  });

  it('nobody can promote themselves or touch role assignments through the API', async () => {
    const self = await customer.client.from('role_assignments').insert({ user_id: customer.id, role: 'super_admin' }).select();
    expect(self.error).not.toBeNull();
    const opsRow = await customer.client.from('role_assignments').insert({ user_id: customer.id, role: 'operations' }).select();
    expect(opsRow.error).not.toBeNull();
    const adminEdit = await admin.client.from('role_assignments').update({ status: 'suspended' }).eq('user_id', ops.id).select();
    expect(adminEdit.error).not.toBeNull();
    const membership = await customer.client.from('organization_memberships')
      .insert({ organization_id: randomUUID(), user_id: customer.id, membership_role: 'company_admin', status: 'active' }).select();
    expect(membership.error).not.toBeNull();
    const event = await customer.client.from('approval_events')
      .insert({ subject_type: 'organization', subject_id: randomUUID(), decision: 'approved', actor_user_id: customer.id }).select();
    expect(event.error).not.toBeNull();
    expect(sql(`select count(*) from public.role_assignments where user_id = ${quote(customer.id)}`)).toBe('0');
  });

  it('anonymous callers can read none of the protected tables', async () => {
    for (const table of ['profiles', 'organizations', 'organization_memberships', 'role_assignments', 'approval_events', 'vessels', 'sailings', 'bookings']) {
      const res = await anonClient().from(table).select('*').limit(1);
      expect(res.error, table).not.toBeNull();
    }
  });
});

suite('local Supabase: operations data and bookings', () => {
  let ops: TestUser;
  let admin: TestUser;
  let bookerA: TestUser;   // company admin of approved org A
  let colleagueA: TestUser; // company_booker of org A
  let bookerB: TestUser;   // company admin of approved org B
  let pendingUser: TestUser; // admin of a still-pending org
  let loner: TestUser;     // no company
  let orgA: string; let orgB: string; let orgPending: string;
  let outRoute: string; let backRoute: string; let vessel: string;

  const newSailing = async (route: string, hours: number, capacity: number): Promise<string> => {
    const { data, error } = await ops.client.from('sailings')
      .insert({ route_id: route, vessel_id: vessel, departs_at: futureIso(hours), seat_capacity: capacity }).select('id').single();
    if (error) throw new Error(`sailing insert: ${error.message}`);
    return data.id as string;
  };
  const book = (user: TestUser, args: Record<string, unknown>) => user.client.rpc('create_booking', args);
  const firstRow = <T,>(data: unknown) => (data as T[])[0];

  beforeAll(async () => {
    [ops, admin, bookerA, colleagueA, bookerB, pendingUser, loner] = await Promise.all([
      confirmedUser('ops2'), confirmedUser('admin2'), confirmedUser('booker-a'), confirmedUser('colleague-a'),
      confirmedUser('booker-b'), confirmedUser('pending'), confirmedUser('loner'),
    ]);
    grantPlatformRole(ops.id, 'operations');
    grantPlatformRole(admin.id, 'super_admin');
    orgA = (await registerCompany(bookerA, 'IT Booking Co A')).id;
    orgB = (await registerCompany(bookerB, 'IT Booking Co B')).id;
    orgPending = (await registerCompany(pendingUser, 'IT Still Pending Co')).id;
    for (const id of [orgA, orgB]) {
      const r = await admin.client.rpc('review_company', { p_organization_id: id, p_decision: 'approve' });
      if (r.error) throw new Error(r.error.message);
    }
    const addColleague = await bookerA.client.from('organization_memberships')
      .insert({ organization_id: orgA, user_id: colleagueA.id, membership_role: 'company_booker', status: 'active', invited_by: bookerA.id });
    if (addColleague.error) throw new Error(`add booker: ${addColleague.error.message}`);

    const v = await ops.client.from('vessels').insert({ name: `IT Vessel ${Math.random().toString(36).slice(2, 8)}`, passenger_capacity: 12 }).select('id').single();
    if (v.error) throw new Error(v.error.message);
    vessel = v.data.id;
    const tag = Math.random().toString(36).slice(2, 7);
    const r1 = await ops.client.from('routes').insert({ origin: `IT Pier ${tag}`, destination: `IT Anchorage ${tag}` }).select('id').single();
    const r2 = await ops.client.from('routes').insert({ origin: `IT Anchorage ${tag}`, destination: `IT Pier ${tag}` }).select('id').single();
    if (r1.error || r2.error) throw new Error('route insert failed');
    outRoute = r1.data.id; backRoute = r2.data.id;
  });

  it('only operations/super_admin staff can create or change vessels, routes and sailings; seats_booked is never writable', async () => {
    for (const user of [bookerA, loner]) {
      expect((await user.client.from('vessels').insert({ name: 'Rogue vessel' }).select()).error?.code).toBe('42501');
      expect((await user.client.from('routes').insert({ origin: 'X', destination: 'Y' }).select()).error?.code).toBe('42501');
      expect((await user.client.from('sailings').insert({ route_id: outRoute, vessel_id: vessel, departs_at: futureIso(5), seat_capacity: 5 }).select()).error?.code).toBe('42501');
      const upd = await user.client.from('vessels').update({ name: 'Renamed' }).eq('id', vessel).select();
      expect(upd.data ?? []).toEqual([]); // RLS filters the row out: nothing updated
    }
    const sailing = await newSailing(outRoute, 30, 4);
    const forge = await ops.client.from('sailings').update({ seats_booked: 0, seat_capacity: 4 } as never).eq('id', sailing).select();
    expect(forge.error?.code).toBe('42501'); // no column privilege on seats_booked
    const tooBig = await ops.client.from('sailings').insert({ route_id: outRoute, vessel_id: vessel, departs_at: futureIso(31), seat_capacity: 13 }).select();
    expect(tooBig.error?.message).toMatch(/exceeds the vessel/);
    const past = await ops.client.from('sailings').insert({ route_id: outRoute, vessel_id: vessel, departs_at: futureIso(-1), seat_capacity: 3 }).select();
    expect(past.error?.message).toMatch(/must be in the future/);
    expect(sql(`select created_by = ${quote(ops.id)} from public.sailings where id = ${quote(sailing)}`)).toBe('t');
    // Everyone signed in can read the schedule.
    expect((await loner.client.from('sailings').select('id').eq('id', sailing)).data).toHaveLength(1);
  });

  it('an approved-company member books a sailing; the server returns a reference and the record persists', async () => {
    const sailing = await newSailing(outRoute, 40, 6);
    const args = bookingArgs(orgA, sailing, { p_passenger_count: 2, p_passenger_names: ['Second Traveller'], p_po_reference: 'PO-IT-1' });
    const res = await book(bookerA, args);
    expect(res.error).toBeNull();
    const row = firstRow<{ booking_id: string; reference: string; status: string; outcome: string }>(res.data);
    expect(row.reference).toMatch(/^GM-[0-9A-F]{8}$/);
    expect(row).toMatchObject({ status: 'reserved', outcome: 'created' });
    const saved = await bookerA.client.from('bookings')
      .select('reference, status, passenger_count, passenger_names, booking_legs(leg, passengers, sailing_id)').eq('id', row.booking_id).single();
    expect(saved.data).toMatchObject({ reference: row.reference, status: 'reserved', passenger_count: 2, passenger_names: ['IT Lead Passenger', 'Second Traveller'] });
    expect(saved.data?.booking_legs).toEqual([{ leg: 'outbound', passengers: 2, sailing_id: sailing }]);
    expect(sql(`select seats_booked from public.sailings where id = ${quote(sailing)}`)).toBe('2');
    // No payment/paid column exists at all.
    expect(sql(`select count(*) from information_schema.columns where table_name = 'bookings' and column_name ilike '%pa%id%'`)).toBe('0');
  });

  it('outbound + return reserve both sailings atomically; an invalid return reserves nothing', async () => {
    const out = await newSailing(outRoute, 50, 5);
    const back = await newSailing(backRoute, 54, 5);
    const ok = await book(bookerA, bookingArgs(orgA, out, { p_return_sailing_id: back, p_passenger_count: 3 }));
    expect(ok.error).toBeNull();
    expect(sql(`select string_agg(seats_booked::text, ',' order by departs_at) from public.sailings where id in (${quote(out)}, ${quote(back)})`)).toBe('3,3');
    const wrongDirection = await newSailing(outRoute, 58, 5);
    const bad = await book(bookerA, bookingArgs(orgA, out, { p_return_sailing_id: wrongDirection }));
    expect(bad.error?.message).toMatch(/reverse route/);
    const full = await newSailing(backRoute, 60, 1);
    const partial = await book(bookerA, bookingArgs(orgA, out, { p_return_sailing_id: full, p_passenger_count: 2 }));
    expect(partial.error?.message).toMatch(/^sailing_full/);
    expect(sql(`select seats_booked from public.sailings where id = ${quote(out)}`)).toBe('3'); // outbound untouched
  });

  it('retries are idempotent: same key → same booking; same key with different details → payload_mismatch', async () => {
    const sailing = await newSailing(outRoute, 70, 5);
    const args = bookingArgs(orgA, sailing);
    const [a, b] = [await book(bookerA, args), await book(bookerA, args)];
    expect(firstRow<{ outcome: string }>(a.data).outcome).toBe('created');
    expect(firstRow<{ outcome: string; reference: string }>(b.data)).toMatchObject({ outcome: 'replayed', reference: firstRow<{ reference: string }>(a.data).reference });
    const changed = await book(bookerA, { ...args, p_passenger_count: 2 });
    expect(changed.error?.message).toMatch(/^payload_mismatch/);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => book(bookerA, { ...args })));
    expect(concurrent.every(r => firstRow<{ outcome: string }>(r.data).outcome === 'replayed')).toBe(true);
    expect(sql(`select seats_booked from public.sailings where id = ${quote(sailing)}`)).toBe('1');
    expect(sql(`select count(*) from public.bookings where request_key = ${quote(args.p_request_key)}`)).toBe('1');
  });

  it('concurrent bookings cannot oversell: capacity 5, ten parallel one-seat requests → exactly five succeed', async () => {
    const sailing = await newSailing(outRoute, 80, 5);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      book(i % 2 === 0 ? bookerA : bookerB, bookingArgs(i % 2 === 0 ? orgA : orgB, sailing))));
    const ok = results.filter(r => !r.error).length;
    const full = results.filter(r => r.error?.message.startsWith('sailing_full')).length;
    expect(ok).toBe(5);
    expect(full).toBe(5);
    expect(sql(`select seats_booked || '/' || seat_capacity from public.sailings where id = ${quote(sailing)}`)).toBe('5/5');
    expect((await book(bookerB, bookingArgs(orgB, sailing))).error?.message).toMatch(/^sailing_full/);
  });

  it('pending orgs, non-members, other companies\' bookers and anonymous callers cannot book', async () => {
    const sailing = await newSailing(outRoute, 90, 5);
    expect((await book(pendingUser, bookingArgs(orgPending, sailing))).error?.message).toMatch(/^organization_not_approved/);
    expect((await book(loner, bookingArgs(orgA, sailing))).error?.message).toMatch(/^not_a_member/);
    expect((await book(bookerB, bookingArgs(orgA, sailing))).error?.message).toMatch(/^not_a_member/);
    expect((await anonClient().rpc('create_booking', bookingArgs(orgA, sailing))).error).not.toBeNull();
    expect(sql(`select seats_booked from public.sailings where id = ${quote(sailing)}`)).toBe('0');
  });

  it('server-side validation rejects bad input and closed/cancelled sailings', async () => {
    const sailing = await newSailing(outRoute, 100, 5);
    expect((await book(bookerA, bookingArgs(orgA, sailing, { p_contact_email: 'not-an-email' }))).error?.code).toBe('22023');
    expect((await book(bookerA, bookingArgs(orgA, sailing, { p_passenger_count: 0 }))).error?.code).toBe('22023');
    expect((await book(bookerA, bookingArgs(orgA, sailing, { p_passenger_names: ['a', 'b'] }))).error?.message).toMatch(/more names than passengers/);
    await ops.client.from('sailings').update({ status: 'closed' }).eq('id', sailing);
    expect((await book(bookerA, bookingArgs(orgA, sailing))).error?.message).toMatch(/^sailing_unavailable/);
    const cancel = await ops.client.from('sailings').update({ status: 'cancelled' }).eq('id', sailing).select();
    expect(cancel.error).toBeNull();
    const reopen = await ops.client.from('sailings').update({ status: 'open' }).eq('id', sailing).select();
    expect(reopen.error?.message).toMatch(/cannot be reopened/);
  });

  it('booking visibility: creator, own company admin and ATCO ops only; bookers see only their own', async () => {
    const sailing = await newSailing(outRoute, 110, 8);
    const byColleague = firstRow<{ booking_id: string }>((await book(colleagueA, bookingArgs(orgA, sailing))).data).booking_id;
    const byAdminA = firstRow<{ booking_id: string }>((await book(bookerA, bookingArgs(orgA, sailing))).data).booking_id;
    const byB = firstRow<{ booking_id: string }>((await book(bookerB, bookingArgs(orgB, sailing))).data).booking_id;
    const visible = async (client: SupabaseClient, id: string) => ((await client.from('bookings').select('id').eq('id', id)).data ?? []).length === 1;

    expect(await visible(colleagueA.client, byColleague)).toBe(true);
    expect(await visible(colleagueA.client, byAdminA)).toBe(false); // booker: own only
    expect(await visible(bookerA.client, byColleague)).toBe(true);  // company admin: whole org
    expect(await visible(bookerA.client, byB)).toBe(false);         // other company: never
    expect(await visible(bookerB.client, byAdminA)).toBe(false);
    expect(await visible(loner.client, byB)).toBe(false);
    expect(await visible(ops.client, byB)).toBe(true);              // ATCO operations: manifest
    // Legs follow their booking.
    expect(((await bookerB.client.from('booking_legs').select('id').eq('booking_id', byAdminA)).data ?? [])).toEqual([]);
    // Manifest for a departure, one query with embedded bookings.
    const manifest = await ops.client.from('booking_legs').select('leg, passengers, bookings(reference, organization_id)').eq('sailing_id', sailing);
    expect(manifest.data).toHaveLength(3);
    // Nobody can edit or delete bookings directly.
    expect((await bookerA.client.from('bookings').update({ passenger_count: 9 }).eq('id', byAdminA).select()).error?.code).toBe('42501');
    expect((await ops.client.from('bookings').delete().eq('id', byB).select()).error?.code).toBe('42501');
  });
});
