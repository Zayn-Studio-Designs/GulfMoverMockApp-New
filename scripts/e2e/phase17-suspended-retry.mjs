#!/usr/bin/env node
// Phase 17a - suspended-sailing gate + remaining retry/error edges on the real
// disposable stack (default 3600s OTP config; no restarts, no mocks).
//
// A. sailing_suspended is REACHABLE (corrects the stale Phase 16 note that
//    called it unreachable): migration 20261101100001 added 'suspended' to
//    sailings_status_check, suspend_sailing() sets it, sailing_boarding_gate()
//    returns 'sailing_suspended', and board_ticket() fails closed on it.
// B. Retry/error edges not asserted by Phases 13-16: truncated confirmation
//    tokens, signup/recovery type confusion, sign-in-before-confirmation with
//    later recovery, resume on an open sailing, garbage recovery tokens.
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY,
//      GM_E2E_MAIL_URL (loopback mail catcher, same as Phase 15).
// Safety: loopback-only; anything else aborts (exit 2).
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';
const MAIL_URL = (process.env.GM_E2E_MAIL_URL ?? process.env.GM_E2E_INBUCKET_URL ?? '').replace(/\/+$/, '');

const loopback = (u) => { try { const h = new globalThis.URL(u).hostname; return h === '127.0.0.1' || h === 'localhost'; } catch { return false; } };
if (!loopback(SUPABASE_URL) || /supabase\.co$/i.test(SUPABASE_URL)) {
  console.error('REFUSAL: GM_E2E_SUPABASE_URL is not an isolated loopback stack; aborting.');
  process.exit(2);
}
if (!loopback(MAIL_URL)) {
  console.error('REFUSAL: GM_E2E_MAIL_URL is not a loopback mail catcher; aborting.');
  process.exit(2);
}
if (!ANON || !SERVICE) { console.error('Missing GM_E2E_ANON_KEY / GM_E2E_SERVICE_KEY'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const errText = e => `${e?.message ?? e ?? ''} ${e?.code ?? ''}`;
const tag = `p17a-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;
const REASON = `Phase 17 suspended-gate drill (fictional ${tag})`;

const anonClient = () => createClient(SUPABASE_URL, ANON);
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
async function mustSingle(promise, what) {
  const r = await promise;
  if (r.error || !r.data) throw new Error(`fixture ${what}: ${errText(r.error) || 'no row returned'}`);
  return r.data;
}

// ---- mail-catcher helpers (same disposable probe as Phase 15) ----
let MAIL_KIND = '';
async function detectMailKind() {
  try { const r = await fetch(`${MAIL_URL}/api/v1/mailboxes`); if (r.ok) return 'inbucket'; } catch { /* not inbucket */ }
  try { const r = await fetch(`${MAIL_URL}/api/v1/messages?limit=1`); if (r.ok) return 'mailpit'; } catch { /* not mailpit */ }
  return '';
}
async function mailboxMessages(mailbox) {
  if (MAIL_KIND === 'mailpit') {
    try {
      const r = await fetch(`${MAIL_URL}/api/v1/messages?limit=50`);
      if (!r.ok) return [];
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.messages ?? []);
      const want = mailbox.toLowerCase();
      return list
        .filter(m => (m.To ?? []).some(t => (t.Address ?? '').toLowerCase() === want))
        .sort((a, b) => String(b.Created ?? '').localeCompare(String(a.Created ?? '')))
        .map(m => ({ ID: m.ID }));
    } catch { return []; }
  }
  for (const name of [mailbox, mailbox.split('@')[0]]) {
    try {
      const r = await fetch(`${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(name)}`);
      if (!r.ok) continue;
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.messages ?? j.data ?? j.mail ?? []);
      if (Array.isArray(list) && list.length) return list.slice().reverse().map(m => ({ _name: name, _id: m.id ?? m.ID ?? m.messageId }));
    } catch { /* try next form */ }
  }
  return [];
}
async function messageBody(entry) {
  if (MAIL_KIND === 'mailpit') {
    const r = await fetch(`${MAIL_URL}/api/v1/message/${entry.ID}`);
    if (!r.ok) return '';
    const m = await r.json();
    return m.HTML ?? m.Text ?? '';
  }
  const r = await fetch(`${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(entry._name)}/${entry._id}`);
  if (!r.ok) return '';
  const m = await r.json();
  return m.body?.html ?? m.body?.text ?? '';
}
function extractVerifyToken(html) {
  const m = html.match(/https?:\/\/[^\s"'<>]*\/auth\/v1\/verify\?[^\s"'<>]*/);
  if (!m) return null;
  try {
    const u = new globalThis.URL(m[0].replace(/&amp;/g, '&'));
    const token = u.searchParams.get('token');
    const type = u.searchParams.get('type');
    if (token && type) return { token, type };
  } catch { /* fall through */ }
  return null;
}
async function latestEmailBody(mailbox, type) {
  for (let i = 0; i < 25; i++) {
    const list = await mailboxMessages(mailbox);
    for (const entry of list) {
      const body = await messageBody(entry);
      if (body && extractVerifyToken(body)?.type === type) return body;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`no '${type}' email arrived for ${mailbox}`);
}

async function main() {
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));
  MAIL_KIND = await detectMailKind();
  check('disposable mail catcher reachable', MAIL_KIND === 'inbucket' || MAIL_KIND === 'mailpit', `got '${MAIL_KIND}'`);
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error) throw new Error(`fixture user ${n}: ${r.error.message}`);
    await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
    return r.data.user.id;
  };
  const opsUid = await mkUser('ops'), boardUid = await mkUser('boarder'), bookerUid = await mkUser('booker');
  await admin.from('role_assignments').insert([
    { user_id: opsUid, organization_id: null, role: 'operations', status: 'active' },
    { user_id: boardUid, organization_id: null, role: 'boarding_staff', status: 'active' },
  ]);
  const orgA = (await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional OrgA ${tag} LLC`, display_name: 'OrgA', status: 'approved',
    account_type: 'corporate', contact_email: `orga-${tag}@example.test`, created_by: opsUid,
  }).select('id').single(), 'orgA insert')).id;
  await admin.from('organization_memberships').insert(
    { organization_id: orgA, user_id: bookerUid, membership_role: 'company_booker', status: 'active' });
  const vessel = (await mustSingle(admin.from('vessels').insert({ name: `Suspend vessel ${tag}`, passenger_capacity: 60, status: 'active' }).select('id').single(), 'vessel insert')).id;
  const routes = (await admin.from('routes').select('id').limit(5)).data ?? [];
  const routeId = routes[0]?.id;
  if (!routeId) throw new Error('no routes seeded');
  const sailId = (await mustSingle(admin.from('sailings').insert({
    route_id: routeId, vessel_id: vessel,
    departs_at: new Date(Date.now() + 30 * 86400_000).toISOString(), seat_capacity: 10, status: 'open',
  }).select('id').single(), 'sailing insert')).id;
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cOps = await signIn('ops'), cBoard = await signIn('boarder'), cBooker = await signIn('booker');
  const terms = (await cOps.from('service_policies').select('version').eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional']).order('effective_from', { ascending: false }).limit(1)).data?.[0]?.version;
  check('suspended-gate fixtures ready', !!terms, 'terms missing');
  const bookRes = await cBooker.rpc('create_organization_booking', {
    p_request_key: `sus-${tag}`, p_organization_id: orgA, p_outbound_sailing_id: sailId, p_passenger_count: 1,
    p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: `PO-SUS-${tag.slice(0, 8)}`, p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });
  check('gate-test booking created', !bookRes.error && !!bookRes.data?.[0]?.booking_id, errText(bookRes.error));
  const bookId = bookRes.data?.[0]?.booking_id;
  const payInit = await cBooker.rpc('initiate_payment', { p_booking_id: bookId, p_method: 'mada' });
  const paySim = await cBooker.rpc('sandbox_simulate_payment', { p_payment_id: payInit.data, p_outcome: 'paid' });
  check('gate-test booking settled via sandbox (no real money)', !payInit.error && !paySim.error, `${errText(payInit.error)} ${errText(paySim.error)}`);
  const ticket = ((await admin.from('tickets').select('id,reference,status').eq('booking_id', bookId)).data ?? [])[0];
  check('gate-test ticket exists and is valid', !!ticket && ticket.status === 'valid', JSON.stringify(ticket));
  const gateBefore = await cOps.rpc('sailing_boarding_gate', { p_sailing_id: sailId });
  check('gate answers on the open sailing (control, not suspended)', !gateBefore.error && typeof gateBefore.data === 'string' && gateBefore.data !== 'sailing_suspended', `${errText(gateBefore.error)} got=${gateBefore.data}`);
  const susp = await cOps.rpc('suspend_sailing', { p_sailing_id: sailId, p_reason: REASON });
  check('operations suspends the sailing (suspended, not unreachable)', !susp.error && susp.data === 'suspended', `${errText(susp.error)} got=${susp.data}`);
  const suspRow = (await admin.from('sailings').select('status').eq('id', sailId).single()).data;
  check('suspension persists in the database', suspRow?.status === 'suspended', JSON.stringify(suspRow));
  const ckpt = await admin.from('sailing_checkpoint_events').select('checkpoint,status').eq('sailing_id', sailId).eq('checkpoint', 'suspension');
  check('suspension writes a checkpoint event', !ckpt.error && (ckpt.data ?? []).some(e => e.status === 'suspended'), errText(ckpt.error));
  const gateSusp = await cOps.rpc('sailing_boarding_gate', { p_sailing_id: sailId });
  check('gate returns sailing_suspended on a suspended sailing', !gateSusp.error && gateSusp.data === 'sailing_suspended', `${errText(gateSusp.error)} got=${gateSusp.data}`);
  const boardSusp = await cBoard.rpc('board_ticket', { p_code: ticket.reference, p_sailing_id: sailId });
  check('boarding fails closed on a suspended sailing', !boardSusp.error && boardSusp.data === 'sailing_suspended', `${errText(boardSusp.error)} got=${boardSusp.data}`);
  const ticketAfter = (await admin.from('tickets').select('status').eq('id', ticket.id).single()).data;
  check('denied boarding boards nothing (ticket still valid)', ticketAfter?.status === 'valid', JSON.stringify(ticketAfter));
  const boardEv = await admin.from('boarding_events').select('id').eq('ticket_id', ticket.id);
  check('denied boarding writes no boarding event', !boardEv.error && (boardEv.data ?? []).length === 0, errText(boardEv.error));
  const custSusp = await cBooker.rpc('suspend_sailing', { p_sailing_id: sailId, p_reason: REASON });
  check('customer cannot suspend a sailing', !!custSusp.error && /not authorized|42501/.test(errText(custSusp.error)), errText(custSusp.error));
  const suspAgain = await cOps.rpc('suspend_sailing', { p_sailing_id: sailId, p_reason: REASON });
  check('repeat suspend is idempotent (unchanged)', !suspAgain.error && suspAgain.data === 'unchanged', `${errText(suspAgain.error)} got=${suspAgain.data}`);
  const resumed = await cOps.rpc('resume_sailing', { p_sailing_id: sailId, p_reason: REASON });
  check('operations resumes the sailing', !resumed.error && resumed.data === 'resumed', `${errText(resumed.error)} got=${resumed.data}`);
  const gateAfter = await cOps.rpc('sailing_boarding_gate', { p_sailing_id: sailId });
  check('gate leaves the suspended state after resume', !gateAfter.error && gateAfter.data !== 'sailing_suspended' && gateAfter.data !== 'sailing_cancelled', `${errText(gateAfter.error)} got=${gateAfter.data}`);
  const fresh = anonClient();
  const signup = await fresh.auth.signUp({ email: email('interrupt'), password: PASSWORD });
  check('signup creates an unconfirmed user (control)', !signup.error && !!signup.data.user && !signup.data.session, errText(signup.error));
  const earlySignin = await anonClient().auth.signInWithPassword({ email: email('interrupt'), password: PASSWORD });
  check('sign-in before confirmation is rejected (no fake session)', !!earlySignin.error && !earlySignin.data.session, 'pre-confirmation sign-in unexpectedly succeeded');
  const confBody = await latestEmailBody(email('interrupt'), 'signup');
  const confLink = extractVerifyToken(confBody);
  const confRes = await fresh.auth.verifyOtp({ token_hash: confLink.token, type: 'signup' });
  check('interrupted confirmation recovers via the emailed link', !confRes.error && !!confRes.data.session, errText(confRes.error));
  const lateSignin = await anonClient().auth.signInWithPassword({ email: email('interrupt'), password: PASSWORD });
  check('sign-in works after the late confirmation', !lateSignin.error && !!lateSignin.data.session, errText(lateSignin.error));
  const truncClient = anonClient();
  await truncClient.auth.signUp({ email: email('truncated'), password: PASSWORD });
  const truncBody = await latestEmailBody(email('truncated'), 'signup');
  const truncLink = extractVerifyToken(truncBody);
  const truncRes = await truncClient.auth.verifyOtp({ token_hash: truncLink.token.slice(0, 12), type: 'signup' });
  check('truncated confirmation token is rejected', !!truncRes.error, 'truncated token unexpectedly accepted');
  const truncUser = await truncClient.auth.getUser();
  check('failed confirmation creates no usable identity', !!truncUser.error || !truncUser.data.user, 'truncated verify unexpectedly yielded a user');
  const confClient = anonClient();
  await confClient.auth.signUp({ email: email('typeconf'), password: PASSWORD });
  const confBody2 = await latestEmailBody(email('typeconf'), 'signup');
  const confLink2 = extractVerifyToken(confBody2);
  const typeConf = await anonClient().auth.verifyOtp({ token_hash: confLink2.token, type: 'recovery' });
  check('signup token presented as a recovery token is rejected (type confusion)', !!typeConf.error, 'cross-type verify unexpectedly accepted');
  const recGarbage = await anonClient().auth.verifyOtp({ token_hash: 'not-a-real-token', type: 'recovery' });
  check('garbage recovery token is rejected', !!recGarbage.error, 'garbage recovery token unexpectedly accepted');
  const resumeOpen = await cOps.rpc('resume_sailing', { p_sailing_id: sailId, p_reason: REASON });
  check('resume on an open sailing fails loudly (no fake resumed)', !!resumeOpen.error && /invalid_transition/.test(errText(resumeOpen.error)), errText(resumeOpen.error));
  console.log(`\nPHASE17A-SUSPENDED-RETRY: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 400)); process.exit(1); });
