// @vitest-environment node
//
// Phase 6 independent security review. Every check here talks to the REAL local
// PostgreSQL/PostgREST stack — no mocked SDK. Catalog checks run as the local database
// owner (read-only); behavioural checks run through the API as eight different actors:
// anon · ordinary authenticated · Company A member · Company A booker · Company B member ·
// ATCO operations · ATCO super_admin · suspended staff/member.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonClient, confirmedUser, futureIso, grantPlatformRole, localStackConfigured, quote, sql, type TestUser } from './helpers';

const suite = localStackConfigured ? describe : describe.skip;

/** Tables where no application role may ever write directly (RPCs own every write). */
const WRITE_LOCKED = ['organizations', 'organization_memberships', 'role_assignments', 'approval_events',
  'platform_settings', 'bookings', 'booking_legs', 'tickets', 'boarding_events', 'sailing_readiness_events',
  'transfer_requests', 'transfer_request_events', 'company_invitations', 'membership_events', 'notifications']
  .map(t => `'${t}'`).join(',');

suite('Phase 6: independent security review against local PostgreSQL/PostgREST', () => {
  let anon: ReturnType<typeof anonClient>;
  let plain: TestUser; let ops: TestUser; let admin: TestUser; let suspended: TestUser;
  let adminA: TestUser; let bookerA: TestUser; let adminB: TestUser;
  let orgA = ''; let orgB = '';
  let sailingA = ''; let bookingA = ''; let ticketA = ''; let qrA = '';
  let bookingB = ''; let ticketB = ''; let requestB = ''; let inviteB = '';

  beforeAll(async () => {
    anon = anonClient();
    plain = await confirmedUser('p6-plain');
    sql(`insert into public.profiles (id, display_name, preferred_language, status)
         values (${quote(plain.id)}, 'P6 ordinary user', 'en', 'active') on conflict (id) do nothing`);
    ops = await confirmedUser('p6-ops'); grantPlatformRole(ops.id, 'operations');
    admin = await confirmedUser('p6-admin'); grantPlatformRole(admin.id, 'super_admin');
    suspended = await confirmedUser('p6-suspended'); grantPlatformRole(suspended.id, 'super_admin');
    sql(`update public.profiles set status='suspended' where id=${quote(suspended.id)}`);

    adminA = await confirmedUser('p6-admin-a');
    bookerA = await confirmedUser('p6-booker-a');
    adminB = await confirmedUser('p6-admin-b');

    async function company(u: TestUser, label: string) {
      const r = await u.client.rpc('register_company', {
        p_registration_key: randomUUID(), p_legal_name: `${label} ${randomUUID()}`,
        p_profile_display_name: 'Fictional Administrator',
      });
      expect(r.error).toBeNull();
      const id = r.data[0].id;
      expect((await admin.client.rpc('review_company', { p_organization_id: id, p_decision: 'approve' })).error).toBeNull();
      return id as string;
    }
    orgA = await company(adminA, 'P6 Company A');
    orgB = await company(adminB, 'P6 Company B');

    // Company A gains a booker through the audited invitation flow.
    const inviteA = await adminA.client.rpc('invite_company_member', { p_org: orgA, p_email: bookerA.email });
    expect(inviteA.error).toBeNull();
    expect((await bookerA.client.rpc('accept_company_invitation', { p_id: inviteA.data })).error).toBeNull();

    // Schedule owned by ATCO operations, then a booking + tickets in each company.
    const vessel = await ops.client.from('vessels').insert({ name: `P6 vessel ${randomUUID()}`, passenger_capacity: 8 }).select('id').single();
    expect(vessel.error).toBeNull();
    const route = await ops.client.from('routes').insert({ origin: `P6 pier ${randomUUID()}`, destination: 'Fictional anchorage' }).select('id').single();
    expect(route.error).toBeNull();
    const sailing = await ops.client.from('sailings')
      .insert({ vessel_id: vessel.data!.id, route_id: route.data!.id, departs_at: futureIso(72), seat_capacity: 8 })
      .select('id').single();
    expect(sailing.error).toBeNull();
    sailingA = sailing.data!.id;

    const bookA = await adminA.client.rpc('create_booking', {
      p_request_key: randomUUID(), p_organization_id: orgA, p_outbound_sailing_id: sailingA,
      p_passenger_count: 2, p_contact_name: 'Fictional Lead A', p_contact_email: 'fiction-a@example.test',
      p_contact_phone: '+966130000001',
    });
    expect(bookA.error).toBeNull();
    bookingA = bookA.data[0].booking_id;
    const ticketsA = await adminA.client.from('tickets').select('id').eq('booking_id', bookingA);
    expect(ticketsA.error).toBeNull();
    ticketA = ticketsA.data![0].id;
    const code = await adminA.client.rpc('get_ticket_qr', { p_ticket_id: ticketA });
    expect(code.error).toBeNull(); qrA = code.data;

    // Company B owns comparable records so cross-company reads can be attempted.
    const bookB = await adminB.client.rpc('create_booking', {
      p_request_key: randomUUID(), p_organization_id: orgB, p_outbound_sailing_id: sailingA,
      p_passenger_count: 1, p_contact_name: 'Fictional Lead B', p_contact_email: 'fiction-b@example.test',
      p_contact_phone: '+966130000002',
    });
    expect(bookB.error).toBeNull();
    bookingB = bookB.data[0].booking_id;
    const ticketsB = await adminB.client.from('tickets').select('id').eq('booking_id', bookingB);
    expect(ticketsB.error).toBeNull(); ticketB = ticketsB.data![0].id;
    const reqB = await adminB.client.rpc('submit_transfer_request', {
      p_org: orgB, p_kind: 'materials', p_key: randomUUID(), p_details: { description: 'P6 fictional material request' },
    });
    expect(reqB.error).toBeNull(); requestB = reqB.data;
    const invB = await adminB.client.rpc('invite_company_member', { p_org: orgB, p_email: `p6-outsider-${randomUUID()}@example.test` });
    expect(invB.error).toBeNull(); inviteB = invB.data;
  }, 120000);

  /* ---------------------------------------------------------------- catalog ---- */

  it('every table in the exposed schema has row level security enabled', () => {
    expect(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`)).toBe('0');
  });

  it('anon holds no table privilege anywhere in the exposed schema', () => {
    expect(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
      where n.nspname='public' and c.relkind='r' and has_table_privilege('anon', c.oid, p.priv)`)).toBe('0');
  });

  it('neither anon nor PUBLIC may execute any function in the exposed schema', () => {
    expect(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('public', p.oid, 'EXECUTE'))`)).toBe('0');
    // Trigger functions are invoked by the trigger machinery, never called directly, so no
    // application role needs EXECUTE on them either. (26 non-internal triggers reference
    // these functions and all of them must be non-executable by authenticated.)
    expect(sql(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
      and has_function_privilege('authenticated', t.tgfoid, 'EXECUTE')`)).toBe('0');
  });

  it('every SECURITY DEFINER function pins an empty search_path', () => {
    // PostgreSQL stores `SET search_path = ''` as the proconfig element `search_path=""`.
    expect(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef
        and not ('search_path=""' = any(coalesce(p.proconfig, '{}')))`)).toBe('0');
  });

  it('authenticated carries no direct write grant on any business table', () => {
    expect(sql(`select count(*) from information_schema.column_privileges
      where table_schema='public' and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')
        and table_name in (${WRITE_LOCKED})`)).toBe('0');
  });

  it('schedule writes expose no seat counter and no staff identity columns', () => {
    expect(sql(`select count(*) from information_schema.column_privileges
      where table_schema='public' and grantee='authenticated' and privilege_type in ('INSERT','UPDATE')
        and (column_name in ('created_by','updated_by','approved_by','seats_booked'))`)).toBe('0');
    // The schedule tables are writable only through the documented column allow-list.
    expect(sql(`select string_agg(column_name::text, ',' order by column_name) from information_schema.column_privileges
      where table_schema='public' and grantee='authenticated' and privilege_type='INSERT' and table_name='sailings'`))
      .toBe('departs_at,route_id,seat_capacity,status,vessel_id');
  });

  /* ------------------------------------------------------------- anon + plain ---- */

  it('an anonymous caller is refused by the database, not merely by React', async () => {
    for (const table of ['organizations', 'profiles', 'bookings', 'tickets', 'notifications', 'transfer_requests']) {
      const res = await anon.from(table).select('id').limit(1);
      expect(res.error, `anon read of ${table}`).not.toBeNull();
    }
    for (const rpc of ['register_company', 'create_booking', 'review_company', 'invite_company_member',
      'submit_transfer_request', 'review_transfer_request', 'ticket_manifest', 'board_ticket', 'mark_notification_read']) {
      const res = await anon.rpc(rpc as never, {});
      expect(res.error, `anon rpc ${rpc}`).not.toBeNull();
    }
  });

  it('an ordinary authenticated user cannot create organisations, roles or schedule records', async () => {
    expect((await plain.client.from('organizations').insert({ legal_name: `forged ${randomUUID()}` })).error).not.toBeNull();
    expect((await plain.client.from('organizations').update({ status: 'approved' }).eq('id', orgA)).error).not.toBeNull();
    expect((await plain.client.from('role_assignments').insert({ user_id: plain.id, role: 'super_admin' })).error).not.toBeNull();
    expect((await plain.client.from('approval_events').insert({ subject_type: 'organization', subject_id: orgA, decision: 'approved' })).error).not.toBeNull();
    expect((await plain.client.from('vessels').insert({ name: `forged vessel ${randomUUID()}` })).error).not.toBeNull();
    expect((await plain.client.from('sailings').insert({ vessel_id: null, route_id: null, departs_at: futureIso(24), seat_capacity: 999 })).error).not.toBeNull();
    expect((await plain.client.from('bookings').insert({ organization_id: orgA })).error).not.toBeNull();
    expect((await plain.client.from('tickets').insert({ reference: 'T-1' })).error).not.toBeNull();
    expect((await plain.client.from('notifications').insert({ user_id: plain.id, event_key: 'forged', kind: 'x', target: '/onboarding' })).error).not.toBeNull();
    expect((await plain.client.from('organization_memberships').insert({ organization_id: orgA, user_id: plain.id, membership_role: 'company_admin', status: 'active' })).error).not.toBeNull();
    expect((await plain.client.rpc('review_company', { p_organization_id: orgA, p_decision: 'approve' })).error).not.toBeNull();
    expect((await plain.client.rpc('board_ticket', { p_code: `${qrA}`, p_sailing_id: sailingA })).error).not.toBeNull();
  });

  it('an ordinary authenticated user still gets the read paths the app needs', async () => {
    // Positive control: the hardening must not over-revoke legitimate access.
    expect((await plain.client.rpc('my_company_memberships')).error).toBeNull();
    expect((await plain.client.from('sailings').select('id,seats_booked,status')).error).toBeNull();
  });

  it('a signed-in user cannot rewrite their own account status or smuggle a profile', async () => {
    expect((await plain.client.from('profiles').update({ status: 'suspended' }).eq('id', plain.id)).error).not.toBeNull();
    expect((await plain.client.from('profiles').insert({ id: randomUUID(), status: 'active' })).error).not.toBeNull();
  });

  /* ------------------------------------------------------- company isolation ---- */

  it('company A cannot read company B records across every Phase 3-5 table', async () => {
    const a = adminA.client;
    expect((await a.from('bookings').select('id').eq('id', bookingB)).data).toEqual([]);
    expect((await a.from('booking_legs').select('id').eq('booking_id', bookingB)).data).toEqual([]);
    expect((await a.from('tickets').select('id').eq('booking_id', bookingB)).data).toEqual([]);
    expect((await a.from('transfer_requests').select('id').eq('id', requestB)).data).toEqual([]);
    expect((await a.from('transfer_request_events').select('id').eq('request_id', requestB)).data).toEqual([]);
    expect((await a.from('company_invitations').select('id').eq('id', inviteB)).data).toEqual([]);
    expect((await a.from('membership_events').select('id').eq('organization_id', orgB)).data).toEqual([]);
    expect((await a.rpc('list_company_members', { p_org: orgB })).error?.code).toBe('42501');
  });

  it('a company cannot review, invite or request on behalf of another company', async () => {
    expect((await adminA.client.rpc('invite_company_member', { p_org: orgB, p_email: `p6-x-${randomUUID()}@example.test` })).error?.code).toBe('42501');
    expect((await adminA.client.rpc('list_company_members', { p_org: orgB })).error?.code).toBe('42501');
    expect((await adminA.client.rpc('submit_transfer_request', {
      p_org: orgB, p_kind: 'materials', p_key: randomUUID(), p_details: { description: 'cross company forgery' },
    })).error?.code).toBe('42501');
    expect((await adminA.client.rpc('review_company', { p_organization_id: orgB, p_decision: 'approve' })).error).not.toBeNull();
    expect((await adminA.client.rpc('review_company', { p_organization_id: orgA, p_decision: 'approve' })).error).not.toBeNull();
  });

  it('only the intended recipient may accept an invitation, and only once', async () => {
    const fresh = await confirmedUser('p6-invitee');
    const inv = await adminA.client.rpc('invite_company_member', { p_org: orgA, p_email: fresh.email });
    expect(inv.error).toBeNull();
    // A different signed-in user cannot claim it even knowing the id.
    expect((await plain.client.rpc('accept_company_invitation', { p_id: inv.data })).error?.code).toBe('42501');
    expect((await adminB.client.rpc('accept_company_invitation', { p_id: inv.data })).error?.code).toBe('42501');
    expect((await fresh.client.rpc('accept_company_invitation', { p_id: inv.data })).error).toBeNull();
    expect((await fresh.client.rpc('accept_company_invitation', { p_id: inv.data })).data).toBe('unchanged');
    // The recipient received only the booker role.
    expect(sql(`select membership_role from public.organization_memberships
      where user_id=${quote(fresh.id)} and organization_id=${quote(orgA)}`)).toBe('company_booker');
  });

  it('concurrent acceptance cannot create a second membership or a second accepted event', async () => {
    // The acceptance path takes the organisation lock and then the invitation row lock, so racing
    // retries (a double tap, or two tabs) must collapse into one membership and one audit event.
    const racer = await confirmedUser('p6-racer');
    const inv = await adminA.client.rpc('invite_company_member', { p_org: orgA, p_email: racer.email });
    expect(inv.error).toBeNull();
    const attempts = await Promise.all(Array.from({ length: 4 }, () =>
      racer.client.rpc('accept_company_invitation', { p_id: inv.data })));
    expect(attempts.every(a => a.error === null)).toBe(true);
    expect(attempts.filter(a => a.data === 'recorded')).toHaveLength(1);
    expect(attempts.filter(a => a.data === 'unchanged')).toHaveLength(3);
    expect(sql(`select count(*) from public.organization_memberships
      where organization_id=${quote(orgA)} and user_id=${quote(racer.id)}`)).toBe('1');
    expect(sql(`select count(*) from public.membership_events
      where invitation_id=${quote(inv.data)} and action='accepted'`)).toBe('1');
    expect(sql(`select membership_role from public.organization_memberships
      where user_id=${quote(racer.id)} and organization_id=${quote(orgA)}`)).toBe('company_booker');
  });

  it('membership rows cannot be written directly, so consent cannot be bypassed', async () => {
    for (const actor of [plain, adminA, admin]) {
      expect((await actor.client.from('organization_memberships')
        .insert({ organization_id: orgA, user_id: plain.id, membership_role: 'company_admin', status: 'active' })).error).not.toBeNull();
      expect((await actor.client.from('organization_memberships')
        .update({ membership_role: 'company_admin' }).eq('organization_id', orgA)).error).not.toBeNull();
      expect((await actor.client.from('organization_memberships')
        .delete().eq('organization_id', orgA)).error).not.toBeNull();
    }
  });

  /* ---------------------------------------------- tickets, QR, notifications ---- */

  it('ticket data and the QR secret stay with the booking owner', async () => {
    expect((await plain.client.from('tickets').select('id').eq('booking_id', bookingA)).data).toEqual([]);
    expect((await adminB.client.from('tickets').select('id').eq('id', ticketA)).data).toEqual([]);
    expect((await plain.client.rpc('get_ticket_qr', { p_ticket_id: ticketA })).error).not.toBeNull();
    expect((await bookerA.client.rpc('get_ticket_qr', { p_ticket_id: ticketA })).error).not.toBeNull();
    // Company A — even its administrator — cannot reach Company B's ticket or its QR secret.
    expect((await adminA.client.from('tickets').select('id').eq('id', ticketB)).data).toEqual([]);
    expect((await adminA.client.rpc('get_ticket_qr', { p_ticket_id: ticketB })).error).not.toBeNull();
    // The QR token column itself is never selectable, only retrievable through the RPC.
    expect((await adminA.client.from('tickets').select('qr_token').eq('id', ticketA)).error).not.toBeNull();
    // A non-staff user cannot list a sailing's manifest.
    expect((await plain.client.rpc('ticket_manifest', { p_sailing_id: sailingA })).error).not.toBeNull();
  });

  it('notification rows are owner-only and read state cannot be forged', async () => {
    const mine = await adminA.client.from('notifications').select('id,kind,read_at').limit(20);
    expect(mine.error).toBeNull();
    expect(mine.data!.length).toBeGreaterThan(0);
    const id = mine.data![0].id;
    expect((await adminB.client.from('notifications').select('id').eq('id', id)).data).toEqual([]);
    expect((await adminB.client.rpc('mark_notification_read', { p_id: id })).data).toBe(false);
    expect((await plain.client.rpc('mark_notification_read', { p_id: id })).data).toBe(false);
    expect((await adminA.client.rpc('mark_notification_read', { p_id: id })).data).toBe(true);
    expect((await adminA.client.from('notifications').update({ kind: 'forged' }).eq('id', id)).error).not.toBeNull();
    expect((await adminA.client.from('notifications').delete().eq('id', id)).error).not.toBeNull();
  });

  it('transfer requests are company-scoped and reviewable only by ATCO staff', async () => {
    expect((await plain.client.from('transfer_requests').select('id').eq('id', requestB)).data).toEqual([]);
    expect((await bookerA.client.rpc('review_transfer_request', {
      p_id: requestB, p_revision: 0, p_status: 'reviewed_for_planning', p_reason: 'forged review',
    })).error?.code).toBe('42501');
    expect((await adminA.client.rpc('review_transfer_request', {
      p_id: requestB, p_revision: 0, p_status: 'reviewed_for_planning', p_reason: 'forged review',
    })).error?.code).toBe('42501');
    // ATCO operations may review, and the audit row records the real actor.
    const reviewed = await ops.client.rpc('review_transfer_request', {
      p_id: requestB, p_revision: 0, p_status: 'reviewed_for_planning', p_reason: 'P6 internal planning only',
    });
    expect(reviewed.error).toBeNull();
    expect(sql(`select actor_user_id from public.transfer_request_events where request_id=${quote(requestB)}
      and status='reviewed_for_planning'`)).toBe(ops.id);
    expect(sql(`select count(*) from public.transfer_request_events where request_id=${quote(requestB)}`)).toBe('2');
  });

  /* --------------------------------------------------- suspension + staff roles ---- */

  it('a suspended staff account keeps no privilege with a still-valid JWT', async () => {
    expect((await suspended.client.rpc('has_platform_role', { p_roles: ['super_admin'] })).data).toBe(false);
    expect((await suspended.client.rpc('review_company', { p_organization_id: orgA, p_decision: 'approve' })).error).not.toBeNull();
    expect((await suspended.client.from('bookings').select('id').eq('id', bookingA)).data).toEqual([]);
    expect((await suspended.client.from('transfer_requests').select('id')).data).toEqual([]);
    expect((await suspended.client.from('vessels').insert({ name: `forged ${randomUUID()}` })).error).not.toBeNull();
    expect((await suspended.client.from('profiles').update({ status: 'active' }).eq('id', suspended.id)).error).not.toBeNull();
    expect(sql(`select status from public.profiles where id=${quote(suspended.id)}`)).toBe('suspended');
  });

  it('operations staff may run the schedule but not approve companies or edit roles', async () => {
    expect((await ops.client.rpc('review_company', { p_organization_id: orgA, p_decision: 'approve' })).error).not.toBeNull();
    expect((await ops.client.from('role_assignments').insert({ user_id: ops.id, role: 'super_admin' })).error).not.toBeNull();
    expect((await ops.client.from('role_assignments').update({ status: 'suspended' }).eq('user_id', ops.id)).error).not.toBeNull();
    expect((await ops.client.from('approval_events').delete().eq('subject_id', orgA)).error).not.toBeNull();
  });
});
