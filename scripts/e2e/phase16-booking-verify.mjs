#!/usr/bin/env node
// Phase 16 — remaining booking verification on the real disposable stack.
//
// Closes the outstanding Section 3 item:
// "Verify real booking creation and server-side price calculation,
//  seat-count changes, duplicate/idempotent handling, capacity and conflict
//  protections, honest empty-manifest responses and the fail-closed boarding
//  gate on the real stack."
//
// Already proven by Phases 13-15 (cited, not repeated): charter submit/approve
// + vessel_conflict (P13), concurrent capacity race + concurrent same-key
// replay (P14), amend/cancel/reschedule + ticket/audit checks + concurrent
// reschedule race + per-checkpoint boarding gates + manifest read roles
// (P15). This suite covers only the genuinely new assertions:
// server-calculated totals vs quote, direct-total tampering, sequential
// idempotent replay + payload_mismatch, invalid-request recovery, return-leg
// capacity, company-admin manifest denial, anonymous manifest denial, the
// cancelled-sailing gate, fresh-sailing fail-closed gate, and the full
// pay_now hold-expiry lifecycle (set, denied for customers, ops expiry,
// seat release, ticket cancellation, audit, amend-after-expiry).
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
const tag = `p16-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;

const anonClient = () => createClient(SUPABASE_URL, ANON);
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function mustSingle(promise, what) {
  const r = await promise;
  if (r.error || !r.data) throw new Error(`fixture ${what}: ${errText(r.error) || 'no row returned'}`);
  return r.data;
}

async function main() {
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));

  // ---- fixtures ----
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error) throw new Error(`fixture user ${n}: ${r.error.message}`);
    await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
    return r.data.user.id;
  };
  const adminAUid = await mkUser('admin-a'), bookerAUid = await mkUser('booker-a'), opsUid = await mkUser('ops');
  await admin.from('role_assignments').insert({ user_id: opsUid, organization_id: null, role: 'operations', status: 'active' });
  const orgA = (await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional OrgA ${tag} LLC`, display_name: 'OrgA', status: 'approved',
    account_type: 'corporate', contact_email: `orga-${tag}@example.test`, created_by: adminAUid,
  }).select('id').single(), 'orgA insert')).id;
  await admin.from('organization_memberships').insert([
    { organization_id: orgA, user_id: adminAUid, membership_role: 'company_admin', status: 'active' },
    { organization_id: orgA, user_id: bookerAUid, membership_role: 'company_booker', status: 'active' },
  ]);
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const backRoute = routes.find(r => r.id !== outRoute.id) ?? null;
  const vessel = (await mustSingle(admin.from('vessels').insert({ name: `Verify vessel ${tag}`, passenger_capacity: 60, status: 'active' }).select('id').single(), 'vessel insert')).id;
  const t0 = Date.now() + 30 * 86400_000;
  let sailN = 0;
  const mkSailing = async (routeId, cap) => (await mustSingle(admin.from('sailings').insert({
    route_id: routeId, vessel_id: vessel,
    departs_at: new Date(t0 + (sailN++) * 15 * 60000).toISOString(), seat_capacity: cap, status: 'open',
  }).select('id').single(), 'sailing insert')).id;
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cAdminA = await signIn('admin-a'), cBookerA = await signIn('booker-a'), cOps = await signIn('ops');
  const terms = (await cAdminA.from('service_policies').select('version').eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional']).order('effective_from', { ascending: false }).limit(1)).data?.[0]?.version;
  check('booking-verify fixtures ready', !!terms, 'terms missing');
  const orgBook = (c, sailing, key, pax = 2, extra = {}) => c.rpc('create_organization_booking', {
    p_request_key: key, p_organization_id: orgA, p_outbound_sailing_id: sailing, p_passenger_count: pax,
    p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: `PO-V-${key.slice(0, 8)}`, p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null, ...extra,
  });
  const seatsOf = async (id) => (await admin.from('sailings').select('seats_booked, seat_capacity').eq('id', id).single()).data;

  // ---- A. server-side pricing, tamper-proof totals ----
  const sPrice = await mkSailing(outRoute.id, 12);
  const quote = await cAdminA.rpc('quote_passenger_fare', { p_outbound_sailing_id: sPrice, p_return_sailing_id: null, p_passenger_count: 2 });
  check('server fare quote answers with fixture tariff', !quote.error && quote.data?.[0]?.unit_halala > 0, errText(quote.error));
  const q = quote.data?.[0];
  check('quote is SAR with explicit VAT mode (fixture tariff, not an ATCO price)', q?.currency === 'SAR' && typeof q?.vat_mode === 'string', JSON.stringify(q));
  const seatsBefore = await seatsOf(sPrice);
  const keyA = randomUUID();
  const bA = await orgBook(cAdminA, sPrice, keyA, 2);
  check('customer creates a valid booking through the real API', !bA.error && !!bA.data?.[0]?.booking_id, errText(bA.error));
  const bidA = bA.data?.[0]?.booking_id;
  const rowA = (await cAdminA.from('bookings').select('id,total_halala,net_halala,vat_halala,vat_mode,hold_expires_at,status,reference').eq('id', bidA).single()).data;
  check('booking totals equal the server quote (no client-supplied amount accepted)', !!rowA && rowA.total_halala === q.total_halala && rowA.net_halala === q.net_halala && rowA.vat_halala === q.vat_halala, JSON.stringify(rowA));
  check('booking VAT mode matches the server tariff (no client override)', !!rowA && rowA.vat_mode === q.vat_mode, JSON.stringify(rowA));
  const createdEv = await cAdminA.from('booking_events').select('details').eq('booking_id', bidA).eq('action', 'created');
  check('created audit event records server total + tariff', !createdEv.error && (createdEv.data ?? []).some(e => e.details?.total_halala === q.total_halala && e.details?.tariff_id === q.tariff_id), JSON.stringify(createdEv.data)?.slice(0, 200));
  // The RPC signature takes no amount/total parameter: totals come only from
  // the server tariff. A direct row write is the tamper attempt — and RLS must refuse it.
  const tamper = await cAdminA.from('bookings').update({ total_halala: 1 }).eq('id', bidA);
  check('direct total tampering is denied (no booking UPDATE policy)', !!tamper.error, 'total overwrite unexpectedly accepted');
  const rowAfterTamper = (await cAdminA.from('bookings').select('total_halala').eq('id', bidA).single()).data;
  check('stored total unchanged after tamper attempt', rowAfterTamper?.total_halala === q.total_halala, JSON.stringify(rowAfterTamper));

  // ---- B. seat counts + sequential idempotent replay ----
  const seatsAfterCreate = await seatsOf(sPrice);
  check('booking creation increments seats by passenger count', seatsAfterCreate.seats_booked - seatsBefore.seats_booked === 2, `${seatsBefore.seats_booked} -> ${seatsAfterCreate.seats_booked}`);
  const replay = await orgBook(cAdminA, sPrice, keyA, 2);
  check('sequential same-key replay returns the same booking (replayed)', !replay.error && replay.data?.[0]?.booking_id === bidA && replay.data?.[0]?.outcome === 'replayed', `${errText(replay.error)} ${JSON.stringify(replay.data)}`);
  const seatsAfterReplay = await seatsOf(sPrice);
  check('replay does not double-count seats', seatsAfterReplay.seats_booked === seatsAfterCreate.seats_booked, `${seatsAfterCreate.seats_booked} -> ${seatsAfterReplay.seats_booked}`);
  const mismatch = await cAdminA.rpc('create_organization_booking', {
    p_request_key: keyA, p_organization_id: orgA, p_outbound_sailing_id: sPrice, p_passenger_count: 2,
    p_contact_name: 'Different Name', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: 'PO-CHANGED', p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  check('same key with changed payload is rejected (payload_mismatch)', !!mismatch.error && /payload_mismatch/.test(errText(mismatch.error)), errText(mismatch.error));

  // ---- C. invalid request fails cleanly, retry recovers ----
  const badId = randomUUID();
  const seatsPreBad = await seatsOf(sPrice);
  const badBook = await orgBook(cAdminA, badId, randomUUID(), 1);
  check('booking against an unknown sailing is rejected', !!badBook.error && /sailing_unavailable|sailing not found/i.test(errText(badBook.error)), errText(badBook.error));
  const seatsPostBad = await seatsOf(sPrice);
  check('failed booking leaves seat counts untouched', seatsPostBad.seats_booked === seatsPreBad.seats_booked, `${seatsPreBad.seats_booked} -> ${seatsPostBad.seats_booked}`);
  const retry = await orgBook(cAdminA, sPrice, randomUUID(), 1);
  check('retry with a valid sailing succeeds after the failure', !retry.error && !!retry.data?.[0]?.booking_id, errText(retry.error));

  // ---- D. capacity + return-leg conflict protection ----
  const sCap = await mkSailing(outRoute.id, 2);
  const fill = await orgBook(cBookerA, sCap, randomUUID(), 2);
  check('sailing fills exactly to capacity', !fill.error, errText(fill.error));
  const capFull = await seatsOf(sCap);
  const over = await orgBook(cAdminA, sCap, randomUUID(), 1);
  check('overbooking a full sailing is rejected (sailing_full)', !!over.error && /sailing_full/.test(errText(over.error)), errText(over.error));
  check('seats never exceed capacity', capFull.seats_booked === capFull.seat_capacity && capFull.seats_booked === 2, JSON.stringify(capFull));
  const sOut2 = await mkSailing(outRoute.id, 12);
  const sRetFull = await mkSailing(backRoute ? backRoute.id : outRoute.id, 1);
  await orgBook(cBookerA, sRetFull, randomUUID(), 1);
  const retClash = await cAdminA.rpc('create_organization_booking', {
    p_request_key: randomUUID(), p_organization_id: orgA, p_outbound_sailing_id: sOut2, p_passenger_count: 1,
    p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: sRetFull,
    p_po_reference: 'PO-RET', p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  check('booking whose return leg is full is rejected', !!retClash.error && /sailing_full/.test(errText(retClash.error)), errText(retClash.error));

  // ---- E. honest empty manifest + manifest permissions ----
  const sFresh = await mkSailing(outRoute.id, 12);
  const emptyTick = await cOps.rpc('ticket_manifest', { p_sailing_id: sFresh });
  check('fresh sailing manifest is honestly empty (no fabricated rows)', !emptyTick.error && Array.isArray(emptyTick.data) && emptyTick.data.length === 0, errText(emptyTick.error));
  const emptySum = await cOps.rpc('sailing_manifest_summary', { p_sailing_id: sFresh });
  const sumRow = emptySum.data?.[0];
  check('fresh manifest summary shows zero seats/tickets and a closed gate', !emptySum.error && sumRow?.seats_booked === 0 && sumRow?.tickets_valid === 0 && sumRow?.gate !== 'open', JSON.stringify(sumRow));
  const anonManif = await anonClient().rpc('ticket_manifest', { p_sailing_id: sFresh });
  check('anonymous manifest read is denied', !!anonManif.error, 'anon manifest unexpectedly succeeded');
  const adminManif = await cAdminA.rpc('ticket_manifest', { p_sailing_id: sFresh });
  check('company admin (non-staff) manifest read is denied', !!adminManif.error && /not authorized|42501/.test(errText(adminManif.error)), errText(adminManif.error));

  // ---- F. fail-closed boarding gate: cancelled sailing + fresh sailing ----
  const sCancelT = await mkSailing(outRoute.id, 12);
  const cxSail = await cOps.rpc('cancel_sailing', { p_sailing_id: sCancelT, p_reason: `Phase 16 gate drill (fictional ${tag})` });
  check('operations cancels the gate-test sailing', !cxSail.error, errText(cxSail.error));
  const gateCancelled = await cBookerA.rpc('sailing_boarding_gate', { p_sailing_id: sCancelT });
  check('boarding gate fails closed on a cancelled sailing', !gateCancelled.error && gateCancelled.data === 'sailing_cancelled', `${errText(gateCancelled.error)} got=${gateCancelled.data}`);
  // NOTE: a 'suspended' gate cannot be exercised: the sailings_status_check
  // constraint allows only open/closed/cancelled, so no suspended sailing can
  // exist. The 'sailing_suspended' branch is unreachable until the enum changes.

  // ---- G. pay_now hold expiry lifecycle ----
  const sHold = await mkSailing(outRoute.id, 12);
  const holdSeats0 = (await seatsOf(sHold)).seats_booked;
  const holdBook = await orgBook(cBookerA, sHold, randomUUID(), 2);
  check('hold-test booking created', !holdBook.error && !!holdBook.data?.[0]?.booking_id, errText(holdBook.error));
  const holdId = holdBook.data?.[0]?.booking_id;
  const holdRow = (await admin.from('bookings').select('hold_expires_at,status,payment_status').eq('id', holdId).single()).data;
  const holdIn = new Date(holdRow?.hold_expires_at).getTime() - Date.now();
  check('pay_now booking carries a future hold (~30min provisional, not an ATCO rule)', !!holdRow?.hold_expires_at && holdIn > 20 * 60000 && holdIn < 40 * 60000, `in ${Math.round(holdIn / 60000)}min`);
  const custExpire = await cBookerA.rpc('expire_stale_holds');
  check('customer cannot run hold expiry', !!custExpire.error && /not authorized|42501/.test(errText(custExpire.error)), errText(custExpire.error));
  await admin.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60000).toISOString() }).eq('id', holdId);
  const doExpire = await cOps.rpc('expire_stale_holds');
  check('operations expires stale holds', !doExpire.error && doExpire.data >= 1, `${errText(doExpire.error)} got=${doExpire.data}`);
  const expiredRow = (await admin.from('bookings').select('status,operational_status,payment_status').eq('id', holdId).single()).data;
  check('expired hold booking leaves reserved state', expiredRow?.status === 'expired', JSON.stringify(expiredRow));
  const holdSeats1 = await seatsOf(sHold);
  check('expiry releases the held seats', holdSeats1.seats_booked === holdSeats0, `${holdSeats0 + 2} -> ${holdSeats1.seats_booked}`);
  const holdTickets = await admin.from('tickets').select('status').eq('booking_id', holdId);
  check('expiry cancels the held tickets', !holdTickets.error && (holdTickets.data ?? []).length > 0 && (holdTickets.data ?? []).every(t => t.status === 'cancelled'), JSON.stringify(holdTickets.data));
  const expiredEv = await admin.from('booking_events').select('action').eq('booking_id', holdId).eq('action', 'expired');
  check('expiry writes an audit event', !expiredEv.error && (expiredEv.data ?? []).length > 0, errText(expiredEv.error));
  const amendExpired = await cBookerA.rpc('amend_booking', { p_booking_id: holdId, p_contact_name: 'Late Change' });
  check('amend after expiry is rejected', !!amendExpired.error && /invalid_transition/.test(errText(amendExpired.error)), errText(amendExpired.error));

  console.log(`\nPHASE16-BOOKING-VERIFY: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 300)); process.exit(1); });
