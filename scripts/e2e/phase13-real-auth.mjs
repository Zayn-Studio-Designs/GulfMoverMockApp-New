#!/usr/bin/env node
// Phase 13 — real Supabase Auth + PostgREST integration (isolated disposable stack).
//
// Uses genuine GoTrue (signup/signin/refresh/signout/recovery/invite) and real
// PostgREST (tables + RPCs with RLS enforced) against a disposable local stack.
// Fictional users/data only. Exits non-zero on any failure.
//
// Required env (never printed): GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY.
// Safety: the URL MUST be loopback; anything else (including *.supabase.co,
// notably the hosted GulfMover-Demo project) is refused.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';

const host = (() => { try { return new URL(URL).hostname; } catch { return ''; } })();
if (!['127.0.0.1', 'localhost'].includes(host) || /supabase\.co$/i.test(URL)) {
  console.error('REFUSAL: GM_E2E_SUPABASE_URL is not an isolated loopback stack; aborting.');
  process.exit(2);
}
if (!ANON || !SERVICE) { console.error('Missing GM_E2E_ANON_KEY / GM_E2E_SERVICE_KEY'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const errText = e => `${e?.message ?? e ?? ''} ${e?.code ?? ''}`;
const tag = `p13-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;

const anonClient = () => createClient(URL, ANON);
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function main() {
  // ---- stack sanity (real services, not stubs) ----
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));

  // ---- 1. signup creates a user; duplicate is rejected ----
  const signup = await anonClient().auth.signUp({ email: email('alice'), password: PASSWORD });
  check('signup succeeds (user created)', !signup.error && !!signup.data.user, errText(signup.error));
  const aliceId = signup.data.user?.id;
  const dup = await anonClient().auth.signUp({ email: email('alice'), password: PASSWORD });
  check('duplicate signup does not issue a new session', !dup.error || !dup.data.session, errText(dup.error));

  // ---- 2. invalid credentials rejected ----
  const bad = await anonClient().auth.signInWithPassword({ email: email('alice'), password: 'wrong-password-1' });
  check('wrong password rejected', !!bad.error && /invalid login credentials/i.test(bad.error.message), errText(bad.error));

  // ---- 3. confirm via admin, then sign in ----
  if (aliceId && !signup.data.session) {
    const conf = await admin.auth.admin.updateUserById(aliceId, { email_confirm: true });
    check('admin can confirm email (test-only confirmation path)', !conf.error, errText(conf.error));
  }
  const alice = anonClient();
  const si = await alice.auth.signInWithPassword({ email: email('alice'), password: PASSWORD });
  check('signin with valid credentials returns a session', !si.error && !!si.data.session?.access_token, errText(si.error));
  const me = await alice.auth.getUser();
  check('getUser matches signed-in identity', !me.error && me.data.user?.id === aliceId, errText(me.error));

  // ---- 4. session refresh ----
  const ref = await alice.auth.refreshSession();
  check('access token refreshes', !ref.error && !!ref.data.session?.access_token, errText(ref.error));

  // ---- 5. recovery + invitation are accepted (emails go to the stack mail catcher) ----
  const rec = await anonClient().auth.resetPasswordForEmail(email('alice'), { redirectTo: 'http://127.0.0.1:3000/auth/reset-callback' });
  check('password recovery request accepted', !rec.error, errText(rec.error));
  const inv = await admin.auth.admin.inviteUserByEmail(email('invited'));
  check('staff invitation accepted', !inv.error && !!inv.data.user, errText(inv.error));

  // ---- fixtures (service_role; users confirmed, RLS bypassed for setup only) ----
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error) throw new Error(`fixture user ${n}: ${r.error.message}`);
    await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
    return r.data.user.id;
  };
  const bookerA = await mkUser('booker-a'), adminA = await mkUser('admin-a'), bookerB = await mkUser('booker-b');
  const customer = await mkUser('customer'), opsU = await mkUser('ops'), boarder = await mkUser('boarder');
  await admin.from('role_assignments').insert([
    { user_id: opsU, organization_id: null, role: 'operations', status: 'active' },
    { user_id: boarder, organization_id: null, role: 'boarding_staff', status: 'active' },
  ]);
  const mkOrg = async (label, adminId) => (await admin.from('organizations').insert({
    legal_name: `Fictional ${label} LLC`, display_name: label, status: 'approved',
    account_type: 'corporate', contact_email: `${label}@example.test`, created_by: adminId,
  }).select('id').single()).data.id;
  const orgA = await mkOrg('OrgA', adminA), orgB = await mkOrg('OrgB', bookerB);
  await admin.from('organization_memberships').insert([
    { organization_id: orgA, user_id: adminA, membership_role: 'company_admin', status: 'active' },
    { organization_id: orgA, user_id: bookerA, membership_role: 'company_booker', status: 'active' },
    { organization_id: orgB, user_id: bookerB, membership_role: 'company_admin', status: 'active' },
  ]);
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const backRoute = routes.find(r => r.id !== outRoute.id) ?? routes[0];
  const vessel = (await admin.from('vessels').insert({ name: `Fixture vessel ${tag}`, passenger_capacity: 12, status: 'active' }).select('id').single()).data.id;
  const t0 = Date.now() + 30 * 86400_000;
  const outS = (await admin.from('sailings').insert({ route_id: outRoute.id, vessel_id: vessel, departs_at: new Date(t0).toISOString(), seat_capacity: 12, status: 'open' }).select('id').single()).data.id;
  const backS = (await admin.from('sailings').insert({ route_id: backRoute.id, vessel_id: vessel, departs_at: new Date(t0 + 6 * 3600_000).toISOString(), seat_capacity: 12, status: 'open' }).select('id').single()).data.id;
  const terms = (await admin.from('service_policies').select('version, status').eq('policy_type', 'booking_terms').order('status', { ascending: false }).limit(1)).data?.[0]?.version;
  check('fixtures created (orgs, memberships, staff, sailings, terms)', !!(orgA && orgB && outS && terms), '');

  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cBookerA = await signIn('booker-a'), cAdminA = await signIn('admin-a'), cBookerB = await signIn('booker-b');
  const cCustomer = await signIn('customer'), cOps = await signIn('ops'), cBoarder = await signIn('boarder');

  // ---- 6. real registration: customer registers a company (pending, not approved) ----
  const reg = await cCustomer.rpc('register_company', {
    p_registration_key: randomUUID(), p_legal_name: `Fictional NewCo ${tag} LLC`,
    p_profile_display_name: 'Fictional Customer', p_display_name: 'NewCo',
    p_registration_number: null, p_billing_contact: null,
    p_contact_email: email('customer'), p_contact_phone: '+966500000001', p_language: 'en',
  });
  check('real company registration accepted', !reg.error, errText(reg.error));
  const snap = await cCustomer.rpc('my_company_memberships');
  check('new registration is visible but NOT approved', !snap.error && Array.isArray(snap.data)
    && snap.data.length >= 1 && snap.data.every(m => m.organization_status !== 'approved'), JSON.stringify(snap.data)?.slice(0, 200));

  // ---- 7. Company-A/B isolation over real HTTP ----
  const orgBook = (c, org, sailing) => c.rpc('create_organization_booking', {
    p_request_key: randomUUID(), p_organization_id: org, p_outbound_sailing_id: sailing, p_passenger_count: 1,
    p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: 'PO-13-1', p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  const bA = await orgBook(cAdminA, orgA, outS);
  check('admin-A books for company A over HTTP', !bA.error && !!bA.data?.[0]?.booking_id, errText(bA.error));
  const bB = await orgBook(cBookerB, orgB, outS);
  check('admin-B books for company B over HTTP', !bB.error && !!bB.data?.[0]?.booking_id, errText(bB.error));
  const idA = bA.data[0].booking_id, idB = bB.data[0].booking_id;
  const seen = async (c, id) => (await c.from('bookings').select('id').eq('id', id)).data?.length ?? -1;
  check('admin-A sees own booking via REST', (await seen(cAdminA, idA)) === 1);
  check('admin-A sees ZERO of company-B booking via REST', (await seen(cAdminA, idB)) === 0);
  check('admin-B sees ZERO of company-A booking via REST', (await seen(cBookerB, idA)) === 0);
  check('booker-A sees none of company-B booking', (await seen(cBookerA, idB)) === 0);
  const cross = await orgBook(cAdminA, orgB, outS);
  check('cross-company booking rejected (not_a_member)', !!cross.error && /not_a_member/.test(errText(cross.error)), errText(cross.error));
  const seats = await admin.from('sailings').select('seats_booked').eq('id', outS).single();
  check('seats_booked incremented in the database (2 bookings)', !seats.error && seats.data.seats_booked === 2, JSON.stringify(seats.data));

  // ---- 8. anon denied; signout revokes ----
  const anonBook = await anonClient().rpc('create_individual_booking', {
    p_request_key: randomUUID(), p_outbound_sailing_id: outS, p_passenger_count: 1,
    p_contact_name: 'Anon', p_contact_email: 'a@example.test', p_contact_phone: '+966500000001',
    p_passenger_names: null, p_return_sailing_id: null, p_destination_vessel: null,
    p_destination_imo: null, p_terms_version: terms,
  });
  check('anonymous booking attempt denied', !!anonBook.error, 'anon booking unexpectedly succeeded');
  await alice.auth.signOut();
  const afterLogout = await alice.rpc('my_company_memberships');
  check('signed-out caller gets no membership data', !!afterLogout.error || (afterLogout.data ?? []).length === 0, errText(afterLogout.error));

  // ---- 9. customer vs staff writes; pricing; manifest; suspension ----
  const custWrite = await cCustomer.rpc('set_sailing_readiness', { p_sailing_id: outS, p_status: 'ready', p_reason: 'x' });
  check('customer denied sailing-readiness write', !!custWrite.error && /42501|not authorized|permission/i.test(errText(custWrite.error)), errText(custWrite.error));
  const custTariff = await cCustomer.rpc('publish_tariff', { p_code: 'X', p_per_person_halala: 1, p_vat_mode: 'not_configured', p_vat_rate_bp: null, p_effective_from: new Date().toISOString(), p_route_id: null, p_notes: null, p_reason: null });
  check('customer denied tariff publish', !!custTariff.error, 'customer tariff publish unexpectedly succeeded');
  const opsWrite = await cOps.rpc('set_sailing_readiness', { p_sailing_id: backS, p_status: 'ready', p_reason: 'Phase 13 ops control' });
  check('operations staff write succeeds (recorded)', !opsWrite.error, errText(opsWrite.error));
  const quote = await cCustomer.rpc('quote_passenger_fare', { p_outbound_sailing_id: outS, p_return_sailing_id: backS, p_passenger_count: 3 });
  check('server pricing SAR 500/leg over HTTP', !quote.error && quote.data?.[0]?.unit_halala === 50000 && quote.data?.[0]?.vat_mode === 'not_configured', JSON.stringify(quote.data?.[0]));
  const manif = await cBoarder.rpc('ticket_manifest', { p_sailing_id: backS });
  check('fresh sailing manifest is honestly empty', !manif.error && Array.isArray(manif.data) && manif.data.length === 0, errText(manif.error));
  await admin.from('profiles').update({ status: 'suspended' }).eq('id', (await cCustomer.auth.getUser()).data.user.id);
  const suspBook = await cCustomer.rpc('create_individual_booking', {
    p_request_key: randomUUID(), p_outbound_sailing_id: outS, p_passenger_count: 1,
    p_contact_name: 'S', p_contact_email: 's@example.test', p_contact_phone: '+966500000001',
    p_passenger_names: null, p_return_sailing_id: null, p_destination_vessel: null,
    p_destination_imo: null, p_terms_version: terms,
  });
  check('suspended account cannot book (profile_suspended)', !!suspBook.error && /profile_suspended|suspended/.test(errText(suspBook.error)), errText(suspBook.error));

  // ---- 10. charter conflict over HTTP ----
  const chReq = await cAdminA.rpc('submit_transfer_request', { p_org: orgA, p_kind: 'charter', p_key: randomUUID(), p_details: { description: 'Crew change charter (fictional)', passengers: '6' } });
  check('charter request submitted', !chReq.error, errText(chReq.error));
  const rev = (await admin.from('transfer_requests').select('revision').eq('id', chReq.data).single()).data?.revision;
  const review = await cOps.rpc('review_transfer_request', { p_id: chReq.data, p_revision: rev, p_status: 'approved', p_reason: 'Feasible (fictional)' });
  check('charter approved by ops', !review.error, errText(review.error));
  const busyAt = (await admin.from('sailings').select('departs_at').eq('vessel_id', vessel).eq('status', 'open').gt('departs_at', new Date(Date.now() + 2 * 86400_000).toISOString()).order('departs_at').limit(1)).data?.[0]?.departs_at;
  const clash = await cOps.rpc('allocate_charter', { p_request_id: chReq.data, p_vessel_id: vessel, p_starts_at: new Date(new Date(busyAt).getTime() - 30 * 60000).toISOString(), p_ends_at: new Date(new Date(busyAt).getTime() + 2 * 3600_000).toISOString(), p_quoted_total_halala: 300000, p_reason: 'x' });
  check('conflicting vessel allocation rejected (vessel_conflict)', !!clash.error && /vessel_conflict/.test(errText(clash.error)), errText(clash.error));

  console.log(`\nPHASE13-API: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 300)); process.exit(1); });
