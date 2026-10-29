#!/usr/bin/env node
// Phase 15 — booking lifecycle, payments/refunds (bounded), boarding, and the
// administrator-role matrix over the isolated disposable Supabase stack.
//
// Real GoTrue + PostgREST + RLS. No mocks, no interception. Fictional data.
//
// A. amend_booking: owner amend + event row, validation rejections,
//    cross-company denial, booker-vs-admin boundaries, paid booking locked.
// B. cancel_booking: owner cancel releases seats/cancels tickets, idempotent
//    re-cancel, cross-company denial, amend-after-cancel rejected, 24h customer
//    window enforced with staff bypass.
// C. reschedule_booking_leg: seat/ticket rotation + event row, same-sailing,
//    wrong-route, full-sailing, concurrent-race, and window rules.
// D. Payments/refunds (sandbox only, no real money): initiate + simulate paid,
//    finance requests review, duplicate blocked, customer denied, decision
//    blocked until ATCO approves a refund policy (asserted, not bypassed).
// E. Boarding + QR secrecy: readiness gate, board/double-board, role denial,
//    boarded booking cannot cancel, owner-only QR.
// F. Role matrix: tariff publish/approve with four-eyes, readiness/manifest/
//    sailing-cancel/charter-allocate staff boundaries.
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY.
// Safety: loopback only; anything else aborts (exit 2).
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
const tag = `p15l-${Date.now().toString(36)}`;
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
  const adminAUid = await mkUser('admin-a'), bookerAUid = await mkUser('booker-a');
  const adminBUid = await mkUser('admin-b'), custUid = await mkUser('customer');
  const opsUid = await mkUser('ops'), fin1Uid = await mkUser('fin-1'), fin2Uid = await mkUser('fin-2'), boardUid = await mkUser('boarder');
  await admin.from('role_assignments').insert([
    { user_id: opsUid, organization_id: null, role: 'operations', status: 'active' },
    { user_id: fin1Uid, organization_id: null, role: 'finance', status: 'active' },
    { user_id: fin2Uid, organization_id: null, role: 'finance', status: 'active' },
    { user_id: boardUid, organization_id: null, role: 'boarding_staff', status: 'active' },
  ]);
  const orgA = await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional OrgA ${tag} LLC`, display_name: 'OrgA', status: 'approved',
    account_type: 'corporate', contact_email: `orga-${tag}@example.test`, created_by: adminAUid,
  }).select('id').single(), 'orgA insert');
  const orgB = await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional OrgB ${tag} LLC`, display_name: 'OrgB', status: 'approved',
    account_type: 'corporate', contact_email: `orgb-${tag}@example.test`, created_by: adminBUid,
  }).select('id').single(), 'orgB insert');
  await admin.from('organization_memberships').insert([
    { organization_id: orgA.id, user_id: adminAUid, membership_role: 'company_admin', status: 'active' },
    { organization_id: orgA.id, user_id: bookerAUid, membership_role: 'company_booker', status: 'active' },
    { organization_id: orgB.id, user_id: adminBUid, membership_role: 'company_admin', status: 'active' },
  ]);
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const backRoute = routes.find(r => r.id !== outRoute.id) ?? routes[0];
  const vessel = await mustSingle(admin.from('vessels').insert({ name: `Life vessel ${tag}`, passenger_capacity: 12, status: 'active' }).select('id').single(), 'vessel insert');
  const t0 = Date.now() + 30 * 86400_000;
  let sailN = 0;
  const mkSailing = async (routeId, cap, departsOffsetMs = 0, what = 'sailing insert') => await mustSingle(admin.from('sailings').insert({
    route_id: routeId, vessel_id: vessel.id,
    departs_at: new Date(t0 + (sailN++) * 15 * 60000 + departsOffsetMs).toISOString(), seat_capacity: cap, status: 'open',
  }).select('id').single(), what);
  const s1 = await mkSailing(outRoute.id, 12);
  const s2 = await mkSailing(outRoute.id, 12);
  const s3diff = await mkSailing(backRoute.id === outRoute.id ? outRoute.id : backRoute.id, 12);
  const sFull = await mkSailing(outRoute.id, 1);
  const sRace = await mkSailing(outRoute.id, 1);
  const sNear = await mustSingle(admin.from('sailings').insert({
    route_id: outRoute.id, vessel_id: vessel.id,
    departs_at: new Date(Date.now() + 12 * 3600_000).toISOString(), seat_capacity: 12, status: 'open',
  }).select('id').single(), 'near sailing insert');
  const sNear2 = await mustSingle(admin.from('sailings').insert({
    route_id: outRoute.id, vessel_id: vessel.id,
    departs_at: new Date(Date.now() + 13 * 3600_000).toISOString(), seat_capacity: 12, status: 'open',
  }).select('id').single(), 'near sailing 2 insert');
  const sCancel = await mkSailing(outRoute.id, 12, 0, 'cancel-target sailing insert');
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cAdminA = await signIn('admin-a'), cBookerA = await signIn('booker-a'), cAdminB = await signIn('admin-b');
  const cCust = await signIn('customer'), cOps = await signIn('ops');
  const cFin1 = await signIn('fin-1'), cFin2 = await signIn('fin-2'), cBoard = await signIn('boarder');
  const terms = (await cAdminA.from('service_policies').select('version').eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional']).order('effective_from', { ascending: false }).limit(1)).data?.[0]?.version;
  check('lifecycle fixtures ready', !!terms, 'terms missing');
  const orgBook = (c, org, sailing, key, pax = 1) => c.rpc('create_organization_booking', {
    p_request_key: key, p_organization_id: org, p_outbound_sailing_id: sailing, p_passenger_count: pax,
    p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: `PO-L-${key.slice(0, 8)}`, p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  const indBook = (c, sailing, key, pax = 1) => c.rpc('create_individual_booking', {
    p_request_key: key, p_outbound_sailing_id: sailing, p_passenger_count: pax,
    p_contact_name: 'Fictional Solo', p_contact_email: 'solo@example.test', p_contact_phone: '+966500000006',
    p_passenger_names: null, p_return_sailing_id: null, p_destination_vessel: null,
    p_destination_imo: null, p_terms_version: terms,
  });
  const bookId = r => r.data?.[0]?.booking_id;
  // Pre-fill the 1-seat sailing so "full" cases are genuine.
  const fillFull = await orgBook(cAdminA, orgA.id, sFull.id, randomUUID(), 1);
  check('1-seat sailing pre-filled (full fixture)', !fillFull.error && !!bookId(fillFull), errText(fillFull.error));

  // ---- A. amend ----
  const am1 = await indBook(cCust, s1.id, randomUUID(), 1);
  const amId = bookId(am1);
  check('individual booking created for amend flow', !am1.error && !!amId, errText(am1.error));
  const amOk = await cCust.rpc('amend_booking', { p_booking_id: amId, p_contact_name: 'Renamed Solo', p_po_reference: 'PO-AM1' });
  check('owner amends own booking', !amOk.error && amOk.data === 'amended', errText(amOk.error));
  const amRow = (await admin.from('bookings').select('contact_name,po_reference').eq('id', amId).single()).data;
  check('amend persists to the database', amRow?.contact_name === 'Renamed Solo' && amRow?.po_reference === 'PO-AM1', JSON.stringify(amRow));
  const amEvents = await admin.from('booking_events').select('action').eq('booking_id', amId);
  check('amend writes an audit event', (amEvents.data ?? []).some(e => e.action === 'amended'), JSON.stringify(amEvents.data));
  const amBadEmail = await cCust.rpc('amend_booking', { p_booking_id: amId, p_contact_email: 'not-an-email' });
  check('amend with invalid email rejected', !!amBadEmail.error && /invalid contact email/.test(errText(amBadEmail.error)), errText(amBadEmail.error));
  const amCross = await cAdminB.rpc('amend_booking', { p_booking_id: amId, p_contact_name: 'Hijack' });
  check('other-company amend denied', !!amCross.error && /not authorized/.test(errText(amCross.error)), errText(amCross.error));
  const orgAm = await orgBook(cBookerA, orgA.id, s1.id, randomUUID(), 1);
  const orgAmId = bookId(orgAm);
  const amByAdmin = await cAdminA.rpc('amend_booking', { p_booking_id: orgAmId, p_contact_name: 'Admin Edit' });
  check('company admin amends a booker booking', !amByAdmin.error && amByAdmin.data === 'amended', errText(amByAdmin.error));
  const amByPeer = await cAdminB.rpc('amend_booking', { p_booking_id: orgAmId, p_contact_name: 'Peer Edit' });
  check('non-member admin cannot amend another company booking', !!amByPeer.error, 'cross-company amend unexpectedly accepted');

  // ---- B. cancel ----
  const cx1 = await indBook(cCust, s1.id, randomUUID(), 2);
  const cxId = bookId(cx1);
  const seatsBefore = (await admin.from('sailings').select('seats_booked').eq('id', s1.id).single()).data.seats_booked;
  const cxOk = await cCust.rpc('cancel_booking', { p_booking_id: cxId, p_reason: 'Plans changed (fictional)' });
  check('owner cancels own booking', !cxOk.error && cxOk.data === 'cancelled', errText(cxOk.error));
  const seatsAfter = (await admin.from('sailings').select('seats_booked').eq('id', s1.id).single()).data.seats_booked;
  check('cancel releases seats', seatsAfter === seatsBefore - 2, `before=${seatsBefore} after=${seatsAfter}`);
  const cxTickets = (await admin.from('tickets').select('status').eq('booking_id', cxId)).data ?? [];
  check('cancel voids the tickets', cxTickets.length > 0 && cxTickets.every(t => t.status === 'cancelled'), JSON.stringify(cxTickets));
  const cxAgain = await cCust.rpc('cancel_booking', { p_booking_id: cxId, p_reason: 'Again (fictional)' });
  check('double cancel is idempotent (unchanged)', !cxAgain.error && cxAgain.data === 'unchanged', errText(cxAgain.error));
  const amCancelled = await cCust.rpc('amend_booking', { p_booking_id: cxId, p_contact_name: 'Late Edit' });
  check('amend after cancel rejected', !!amCancelled.error && /invalid_transition/.test(errText(amCancelled.error)), errText(amCancelled.error));
  const cxCross = await cAdminB.rpc('cancel_booking', { p_booking_id: cxId, p_reason: 'Hijack (fictional)' });
  check('other-company cancel denied', !!cxCross.error && /not authorized/.test(errText(cxCross.error)), errText(cxCross.error));
  // 24h window: near sailing.
  const nearB = await indBook(cCust, sNear.id, randomUUID(), 1);
  const nearId = bookId(nearB);
  const nearCx = await cCust.rpc('cancel_booking', { p_booking_id: nearId, p_reason: 'Too late (fictional)' });
  check('customer cancel inside 24h window rejected', !!nearCx.error && /change_window_closed/.test(errText(nearCx.error)), errText(nearCx.error));
  const opsCx = await cOps.rpc('cancel_booking', { p_booking_id: nearId, p_reason: 'Ops override (fictional)' });
  check('operations cancel bypasses the window', !opsCx.error && opsCx.data === 'cancelled', errText(opsCx.error));

  // ---- C. reschedule ----
  const rs1 = await orgBook(cBookerA, orgA.id, s1.id, randomUUID(), 1);
  const rsId = bookId(rs1);
  const oldRefs = ((await admin.from('tickets').select('reference').eq('booking_id', rsId)).data ?? []).map(t => t.reference);
  const s1Seats0 = (await admin.from('sailings').select('seats_booked').eq('id', s1.id).single()).data.seats_booked;
  const rsOk = await cBookerA.rpc('reschedule_booking_leg', { p_booking_id: rsId, p_leg: 'outbound', p_new_sailing_id: s2.id, p_reason: 'Earlier sailing suits (fictional)' });
  check('owner reschedules to another open sailing', !rsOk.error && rsOk.data === 'rescheduled', errText(rsOk.error));
  const s1Seats1 = (await admin.from('sailings').select('seats_booked').eq('id', s1.id).single()).data.seats_booked;
  const s2Seats1 = (await admin.from('sailings').select('seats_booked').eq('id', s2.id).single()).data.seats_booked;
  check('reschedule moves seats between sailings', s1Seats1 === s1Seats0 - 1 && s2Seats1 === 1, `s1 ${s1Seats0}->${s1Seats1}, s2 ->${s2Seats1}`);
  const newRefs = ((await admin.from('tickets').select('reference').eq('booking_id', rsId)).data ?? []).map(t => t.reference);
  check('reschedule rotates ticket references', newRefs.length === oldRefs.length && newRefs.every(r => !oldRefs.includes(r)), `${oldRefs.join(',')} -> ${newRefs.join(',')}`);
  const rsEvents = await admin.from('booking_events').select('action').eq('booking_id', rsId);
  check('reschedule writes an audit event', (rsEvents.data ?? []).some(e => e.action === 'rescheduled'), JSON.stringify(rsEvents.data));
  const rsSame = await cBookerA.rpc('reschedule_booking_leg', { p_booking_id: rsId, p_leg: 'outbound', p_new_sailing_id: s2.id, p_reason: 'Same (fictional)' });
  check('reschedule to the same sailing is unchanged', !rsSame.error && rsSame.data === 'unchanged', errText(rsSame.error));
  const rsWrongRoute = await cBookerA.rpc('reschedule_booking_leg', { p_booking_id: rsId, p_leg: 'outbound', p_new_sailing_id: s3diff.id, p_reason: 'Wrong route (fictional)' });
  check('reschedule to a different route rejected', !!rsWrongRoute.error && /different route/.test(errText(rsWrongRoute.error)), errText(rsWrongRoute.error));
  const rsFull = await cBookerA.rpc('reschedule_booking_leg', { p_booking_id: rsId, p_leg: 'outbound', p_new_sailing_id: sFull.id, p_reason: 'Full (fictional)' });
  check('reschedule into a full sailing rejected', !!rsFull.error && /sailing_full/.test(errText(rsFull.error)), errText(rsFull.error));
  const nearRs = await cCust.rpc('reschedule_booking_leg', { p_booking_id: (await indBook(cCust, sNear.id, randomUUID(), 1)).data?.[0]?.booking_id, p_leg: 'outbound', p_new_sailing_id: sNear2.id, p_reason: 'Late move (fictional)' });
  check('customer reschedule inside 24h window rejected', !!nearRs.error && /change_window_closed/.test(errText(nearRs.error)), errText(nearRs.error));
  // Concurrent race onto a 1-seat sailing.
  const raX = await orgBook(cAdminA, orgA.id, s1.id, randomUUID(), 1);
  const raY = await orgBook(cAdminA, orgA.id, s1.id, randomUUID(), 1);
  const [rrX, rrY] = await Promise.all([
    cAdminA.rpc('reschedule_booking_leg', { p_booking_id: bookId(raX), p_leg: 'outbound', p_new_sailing_id: sRace.id, p_reason: 'Race X (fictional)' }),
    cAdminA.rpc('reschedule_booking_leg', { p_booking_id: bookId(raY), p_leg: 'outbound', p_new_sailing_id: sRace.id, p_reason: 'Race Y (fictional)' }),
  ]);
  const raceWins = [rrX, rrY].filter(r => !r.error && r.data === 'rescheduled');
  const raceLosses = [rrX, rrY].filter(r => !!r.error);
  check('concurrent reschedule race: exactly one wins', raceWins.length === 1 && raceLosses.length === 1, `${errText(rrX.error)} / ${errText(rrY.error)}`);
  check('race loser sees sailing_full', raceLosses.length === 1 && /sailing_full/.test(errText(raceLosses[0].error)), raceLosses.map(r => errText(r.error)).join('|'));
  const raceSeats = (await admin.from('sailings').select('seats_booked').eq('id', sRace.id).single()).data.seats_booked;
  check('race target holds exactly one seat', raceSeats === 1, `seats=${raceSeats}`);

  // ---- D. payments/refunds (sandbox only) ----
  const payB = await indBook(cCust, s1.id, randomUUID(), 1);
  const payId = bookId(payB);
  const payInit = await cCust.rpc('initiate_payment', { p_booking_id: payId, p_method: 'mada' });
  check('payer initiates a sandbox payment', !payInit.error && !!payInit.data, errText(payInit.error));
  const paySim = await cCust.rpc('sandbox_simulate_payment', { p_payment_id: payInit.data, p_outcome: 'paid' });
  check('payer simulates a successful sandbox checkout', !paySim.error, errText(paySim.error));
  const payRow = (await admin.from('payments').select('status').eq('id', payInit.data).single()).data;
  check('sandbox payment recorded as succeeded (no real money)', payRow?.status === 'succeeded', JSON.stringify(payRow));
  const amendPaid = await cCust.rpc('amend_booking', { p_booking_id: payId, p_contact_name: 'Paid Edit' });
  check('paid booking cannot be amended', !!amendPaid.error && /invalid_transition/.test(errText(amendPaid.error)), errText(amendPaid.error));
  const refReq = await cFin1.rpc('request_refund', { p_payment_id: payInit.data, p_amount_halala: 50000, p_reason: 'Customer asked (fictional)' });
  check('finance opens a refund review', !refReq.error && !!refReq.data, errText(refReq.error));
  const refDup = await cFin1.rpc('request_refund', { p_payment_id: payInit.data, p_amount_halala: 50000, p_reason: 'Again (fictional)' });
  check('duplicate refund review blocked', !!refDup.error && /refund_in_progress/.test(errText(refDup.error)), errText(refDup.error));
  const refCust = await cCust.rpc('request_refund', { p_payment_id: payInit.data, p_amount_halala: 50000, p_reason: 'Mine (fictional)' });
  check('customer cannot open a refund review', !!refCust.error && /not authorized|42501/.test(errText(refCust.error)), errText(refCust.error));
  const refDecide = await cFin2.rpc('decide_refund', { p_refund_id: refReq.data, p_decision: 'approve', p_reason: 'Looks fine (fictional)' });
  check('refund decision blocked until ATCO approves a refund policy', !!refDecide.error && /refund_policy_not_approved/.test(errText(refDecide.error)), errText(refDecide.error));

  // ---- E. boarding + QR secrecy (fail-closed gate: every checkpoint proven) ----
  const bdB = await orgBook(cBookerA, orgA.id, s1.id, randomUUID(), 1);
  const bdId = bookId(bdB);
  const bdPay = await cBookerA.rpc('initiate_payment', { p_booking_id: bdId, p_method: 'mada' });
  check('boarding fixture booking paid via sandbox', !bdPay.error && !((await cBookerA.rpc('sandbox_simulate_payment', { p_payment_id: bdPay.data, p_outcome: 'paid' })).error), errText(bdPay.error));
  const bdTickets = (await admin.from('tickets').select('id,reference').eq('booking_id', bdId)).data ?? [];
  const readyOk = await cOps.rpc('set_sailing_readiness', { p_sailing_id: s1.id, p_status: 'ready', p_reason: 'Phase 15 boarding drill (fictional)' });
  check('operations marks sailing ready', !readyOk.error, errText(readyOk.error));
  const custBoard = await cCust.rpc('board_ticket', { p_code: bdTickets[0]?.reference, p_sailing_id: s1.id });
  check('customer cannot board tickets', !!custBoard.error && /not authorized|42501/.test(errText(custBoard.error)), errText(custBoard.error));
  const board1 = await cBoard.rpc('board_ticket', { p_code: 'TK-NOPE1234', p_sailing_id: s1.id });
  check('unknown ticket code returns not_found', !board1.error && board1.data === 'not_found', errText(board1.error));
  const gateClosed = await cBoard.rpc('board_ticket', { p_code: bdTickets[0]?.reference, p_sailing_id: s1.id });
  check('gate fails closed before master go + port clearance', !gateClosed.error && gateClosed.data !== 'boarded', errText(gateClosed.error));
  const masterOk = await cOps.rpc('record_master_decision', { p_sailing_id: s1.id, p_decision: 'go', p_master_name: 'Master Fictional', p_reason: 'Drill go (fictional)' });
  check('operations records master go', !masterOk.error && masterOk.data === 'recorded', errText(masterOk.error));
  const gateStillClosed = await cBoard.rpc('board_ticket', { p_code: bdTickets[0]?.reference, p_sailing_id: s1.id });
  check('gate still closed before port clearance', !gateStillClosed.error && gateStillClosed.data === 'clearance_pending', errText(gateStillClosed.error));
  const clearOk = await cOps.rpc('record_port_clearance', { p_sailing_id: s1.id, p_status: 'cleared', p_reference: 'PORT-REF-15', p_reason: 'Drill clearance (fictional)' });
  check('operations records port clearance', !clearOk.error && clearOk.data === 'recorded', errText(clearOk.error));
  const board2 = await cBoard.rpc('board_ticket', { p_code: bdTickets[0].reference, p_sailing_id: s1.id });
  check('boarding staff boards a valid ticket once the gate is open', !board2.error && board2.data === 'boarded', errText(board2.error));
  const board3 = await cBoard.rpc('board_ticket', { p_code: bdTickets[0].reference, p_sailing_id: s1.id });
  check('repeat scan reports already_boarded', !board3.error && board3.data === 'already_boarded', errText(board3.error));
  const qrOwn = await cBookerA.rpc('get_ticket_qr', { p_ticket_id: bdTickets[0].id });
  check('owner reads their own ticket QR', !qrOwn.error && /^GMT1:[0-9a-f]{64}$/.test(qrOwn.data ?? ''), errText(qrOwn.error));
  const qrOther = await cAdminB.rpc('get_ticket_qr', { p_ticket_id: bdTickets[0].id });
  check('other-company user cannot read the QR', !!qrOther.error && /ticket not found/.test(errText(qrOther.error)), errText(qrOther.error));
  const cxBoarded = await cBookerA.rpc('cancel_booking', { p_booking_id: bdId, p_reason: 'After boarding (fictional)' });
  check('booking with a boarded ticket cannot cancel', !!cxBoarded.error && /already boarded/.test(errText(cxBoarded.error)), errText(cxBoarded.error));

  // ---- F. role matrix ----
  const pubOk = await cFin1.rpc('publish_tariff', { p_code: `P15-${tag}`, p_per_person_halala: 50000, p_vat_mode: 'not_configured', p_vat_rate_bp: null, p_effective_from: new Date().toISOString(), p_route_id: null, p_notes: 'Phase 15 matrix (fictional)', p_reason: 'Matrix drill (fictional)' });
  check('finance publishes a tariff', !pubOk.error && !!pubOk.data, errText(pubOk.error));
  const pubOps = await cOps.rpc('publish_tariff', { p_code: `P15X-${tag}`, p_per_person_halala: 50000, p_vat_mode: 'not_configured', p_vat_rate_bp: null, p_effective_from: new Date().toISOString(), p_route_id: null, p_notes: null, p_reason: 'x' });
  check('operations cannot publish tariffs', !!pubOps.error && /not authorized/.test(errText(pubOps.error)), errText(pubOps.error));
  const apSelf = await cFin1.rpc('approve_tariff', { p_tariff_id: pubOk.data, p_reason: 'Self approval (fictional)' });
  check('publisher cannot approve their own tariff (four-eyes)', !!apSelf.error && /four_eyes_required/.test(errText(apSelf.error)), errText(apSelf.error));
  const apOther = await cFin2.rpc('approve_tariff', { p_tariff_id: pubOk.data, p_reason: 'Second pair of eyes (fictional)' });
  check('second finance approver approves the tariff', !apOther.error && apOther.data === 'approved', errText(apOther.error));
  const readyBoard = await cBoard.rpc('set_sailing_readiness', { p_sailing_id: s2.id, p_status: 'ready', p_reason: 'x' });
  check('boarding staff cannot set readiness', !!readyBoard.error && /not authorized/.test(errText(readyBoard.error)), errText(readyBoard.error));
  const manifBoard = await cBoard.rpc('ticket_manifest', { p_sailing_id: s1.id });
  check('boarding staff reads the manifest', !manifBoard.error && Array.isArray(manifBoard.data) && manifBoard.data.length > 0, errText(manifBoard.error));
  const manifCust = await cCust.rpc('ticket_manifest', { p_sailing_id: s1.id });
  check('customer cannot read the manifest', !!manifCust.error && /not authorized/.test(errText(manifCust.error)), errText(manifCust.error));
  const cxSailCust = await cCust.rpc('cancel_sailing', { p_sailing_id: sCancel.id, p_reason: 'x' });
  check('customer cannot cancel a sailing', !!cxSailCust.error, 'customer sailing-cancel unexpectedly accepted');
  const cxSailOps = await cOps.rpc('cancel_sailing', { p_sailing_id: sCancel.id, p_reason: 'Matrix drill sailing (fictional)' });
  check('operations cancels an empty sailing', !cxSailOps.error, errText(cxSailOps.error));
  const cxSailRow = (await admin.from('sailings').select('status').eq('id', sCancel.id).single()).data;
  check('cancelled sailing persists as cancelled', cxSailRow?.status === 'cancelled', JSON.stringify(cxSailRow));

  console.log(`\nPHASE15-LIFECYCLE-ROLES: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 400)); process.exit(1); });
