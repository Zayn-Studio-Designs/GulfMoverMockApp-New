#!/usr/bin/env node
// Phase 14 — real-auth gaps over the isolated disposable Supabase stack.
//
// Covers Phase 13 leftovers at the HTTP/API layer (no mocks, no interception):
//  A. expired/invalid session handling (tampered + garbage tokens rejected,
//     invalid refresh rejected, expired access + bad refresh unusable).
//  B. pending-organisation guards (registration stays pending; booking against
//     an unapproved org is denied).
//  C. HTTP-level concurrency (simultaneous bookings cannot overbook a sailing;
//     same-key replay stays idempotent under a concurrent race).
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY.
// Safety: the URL MUST be loopback; anything else aborts (exit 2).
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';

const host = (() => { try { return new globalThis.URL(SUPABASE_URL).hostname; } catch { return ''; } })();
if (!['127.0.0.1', 'localhost'].includes(host) || /supabase\.co$/i.test(SUPABASE_URL)) {
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
const tag = `p14-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;

const anonClient = () => createClient(SUPABASE_URL, ANON);
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function main() {
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));

  // ---- A. invalid / expired sessions ----
  const eve = anonClient();
  const signupRes = await eve.auth.signUp({ email: email('eve'), password: PASSWORD });
  check('expiry-test user signs up', !signupRes.error && !!signupRes.data.user, errText(signupRes.error));
  if (signupRes.data.user && !signupRes.data.session) {
    await admin.auth.admin.updateUserById(signupRes.data.user.id, { email_confirm: true });
  }
  const signinRes = await eve.auth.signInWithPassword({ email: email('eve'), password: PASSWORD });
  check('expiry-test user signs in (control)', !signinRes.error && !!signinRes.data.session?.access_token, errText(signinRes.error));
  if (!signinRes.data.session?.access_token) {
    console.log(`\nPHASE14-API-GAPS: ${pass} passed, ${fail} failed (control signin failed, aborting)`);
    process.exit(1);
  }
  const goodAccess = signinRes.data.session.access_token;
  const me = await eve.auth.getUser();
  check('valid token passes getUser (control)', !me.error && me.data.user?.email === email('eve'), errText(me.error));

  const tampered = goodAccess.slice(0, -1) + (goodAccess.slice(-1) === 'a' ? 'b' : 'a');
  const badClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${tampered}` } }, auth: { persistSession: false } });
  const badCall = await badClient.rpc('my_company_memberships');
  check('tampered access token is rejected', !!badCall.error, `unexpected success: ${JSON.stringify(badCall.data)?.slice(0, 120)}`);

  const garbageClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: 'Bearer not-a-token' } }, auth: { persistSession: false } });
  const garbageCall = await garbageClient.rpc('my_company_memberships');
  check('garbage token is rejected', !!garbageCall.error, `unexpected success: ${JSON.stringify(garbageCall.data)?.slice(0, 120)}`);

  const refBad = await eve.auth.refreshSession({ refresh_token: 'invalid-refresh-token' });
  check('invalid refresh token is rejected', !!refBad.error, 'refresh with a bogus token unexpectedly succeeded');

  // Expired access token + unusable refresh: the client must not yield a working session.
  const expired = anonClient();
  const setRes = await expired.auth.setSession({
    access_token: goodAccess,
    refresh_token: 'invalid-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  });
  const afterExpiry = await expired.rpc('my_company_memberships');
  const expiredNeutralised = !!setRes.error || !!afterExpiry.error || (afterExpiry.data ?? []).length === 0;
  check('expired access + bad refresh yields no usable session', expiredNeutralised,
    `setSession err=${errText(setRes.error)} rpc=${JSON.stringify(afterExpiry.data)?.slice(0, 120)}`);

  // ---- fixtures for B + C ----
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error) throw new Error(`fixture user ${n}: ${r.error.message}`);
    await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
    return r.data.user.id;
  };
  const pendUid = await mkUser('pending-u'), gapAdminUid = await mkUser('gap-admin');
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const vessel = (await admin.from('vessels').insert({ name: `Gap vessel ${tag}`, passenger_capacity: 12, status: 'active' }).select('id').single()).data.id;
  const t0 = Date.now() + 30 * 86400_000;
  const mkSailing = async (cap) => (await admin.from('sailings').insert({
    route_id: outRoute.id, vessel_id: vessel, departs_at: new Date(t0).toISOString(), seat_capacity: cap, status: 'open',
  }).select('id').single()).data.id;
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cPend = await signIn('pending-u'), cAdmin = await signIn('gap-admin');
  const terms = (await cAdmin.from('service_policies').select('version').eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional']).order('effective_from', { ascending: false }).limit(1)).data?.[0]?.version;
  check('gap fixtures ready (users, vessel, terms)', !!pendUid && !!vessel && !!terms, '');

  // ---- B. pending-organisation guards ----
  const reg = await cPend.rpc('register_company', {
    p_registration_key: randomUUID(), p_legal_name: `Fictional GapCo ${tag} LLC`,
    p_profile_display_name: 'Fictional Pending', p_display_name: 'GapCo',
    p_registration_number: null, p_billing_contact: null,
    p_contact_email: email('pending-u'), p_contact_phone: '+966500000002', p_language: 'en',
  });
  check('pending user registers a company (accepted, not approved)', !reg.error, errText(reg.error));
  const snap = await cPend.rpc('my_company_memberships');
  const pendOrg = (snap.data ?? []).find(m => m.organization_status === 'pending');
  check('new company is visible but NOT approved', !!pendOrg, JSON.stringify(snap.data)?.slice(0, 200));
  const pendSailing = await mkSailing(12);
  const pendBook = await cPend.rpc('create_organization_booking', {
    p_request_key: randomUUID(), p_organization_id: pendOrg?.organization_id ?? randomUUID(),
    p_outbound_sailing_id: pendSailing, p_passenger_count: 1,
    p_contact_name: 'Fictional Pending', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: 'PO-PEND', p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  check('booking against an unapproved org is denied', !!pendBook.error, 'pending-org booking unexpectedly succeeded');

  // ---- C. HTTP-level concurrency: capacity race ----
  const mkOrgWithAdmin = async (label, ownerUid) => (await admin.from('organizations').insert({
    legal_name: `Fictional ${label} ${tag} LLC`, display_name: label, status: 'approved',
    account_type: 'corporate', contact_email: `${label}-${tag}@example.test`, created_by: ownerUid,
  }).select('id').single()).data.id;
  const orgC = await mkOrgWithAdmin('OrgC', gapAdminUid);
  await admin.from('organization_memberships').insert({ organization_id: orgC, user_id: gapAdminUid, membership_role: 'company_admin', status: 'active' });
  const raceSailing = await mkSailing(3);
  const orgBook = (c, org, sailing, key, pax = 1) => c.rpc('create_organization_booking', {
    p_request_key: key, p_organization_id: org, p_outbound_sailing_id: sailing, p_passenger_count: pax,
    p_contact_name: 'Fictional Race', p_contact_email: 'race@example.test', p_contact_phone: '+966500000004',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: `PO-RACE-${key.slice(0, 8)}`, p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  // Six simultaneous 1-seat requests against 3 seats: exactly 3 must win.
  const raceKeys = Array.from({ length: 6 }, () => randomUUID());
  const raceResults = await Promise.all(raceKeys.map(k => orgBook(cAdmin, orgC, raceSailing, k)));
  const wins = raceResults.filter(r => !r.error);
  const losses = raceResults.filter(r => !!r.error);
  check('capacity race: exactly 3 of 6 simultaneous bookings succeed', wins.length === 3 && losses.length === 3,
    `wins=${wins.length} losses=${losses.length} (${losses.map(l => errText(l.error)).join(' | ').slice(0, 200)})`);
  check('capacity race losers are rejected with sailing_full', losses.length > 0 && losses.every(l => /sailing_full/.test(errText(l.error))),
    losses.map(l => errText(l.error)).join(' | ').slice(0, 200));
  const seats = await admin.from('sailings').select('seats_booked, seat_capacity').eq('id', raceSailing).single();
  check('seats_booked never exceeds capacity after the race', !seats.error && seats.data.seats_booked === 3 && seats.data.seats_booked <= seats.data.seat_capacity,
    JSON.stringify(seats.data));

  // Same-key concurrent replay: idempotent, seats move once.
  const replaySailing = await mkSailing(12);
  const replayKey = randomUUID();
  const beforeRow = await admin.from('sailings').select('seats_booked').eq('id', replaySailing).single();
  const beforeCount = beforeRow.data.seats_booked;
  const [r1, r2] = await Promise.all([
    orgBook(cAdmin, orgC, replaySailing, replayKey, 2),
    orgBook(cAdmin, orgC, replaySailing, replayKey, 2),
  ]);
  const sameId = !r1.error && !r2.error && r1.data?.[0]?.booking_id === r2.data?.[0]?.booking_id;
  check('concurrent same-key replay returns the same booking', sameId, `${errText(r1.error)} / ${errText(r2.error)}`);
  const afterRow = await admin.from('sailings').select('seats_booked').eq('id', replaySailing).single();
  check('concurrent same-key replay increments seats exactly once', afterRow.data.seats_booked - beforeCount === 2, `delta=${afterRow.data.seats_booked - beforeCount}`);

  console.log(`\nPHASE14-API-GAPS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 300)); process.exit(1); });
