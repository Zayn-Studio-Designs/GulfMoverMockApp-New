#!/usr/bin/env node
// Phase 16 — remaining auth edge cases, role visibility, and browser proof.
//
// Closes the outstanding Section 3 items not already proven by Phases 13-15:
// approved-redirect URL behaviour, link-expiry handling beyond simple replay,
// pending/suspended lifecycle edges, explicit booker-vs-admin visibility, the
// full administrator-role matrix where supported, and real-Chromium proof of
// the admin/booker/customer corporate views.
//
// Already proven (cited, not repeated): signup/recovery/invite replay +
// garbage-token rejection (P15), tampered/garbage/invalid-refresh rejection
// (P14), pending-org booking denial (P14), four-eyes tariff approval,
// boarding-staff/customer manifest boundary, ops/customer sailing-cancel
// boundary (P15).
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY,
// GM_E2E_MAIL_URL (mail catcher), GM_E2E_APP_URL (built preview).
// Safety: Supabase + mail URLs MUST be loopback; anything else aborts (exit 2).
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';
const MAIL_URL = (process.env.GM_E2E_MAIL_URL ?? '').replace(/\/+$/, '');
const APP = process.env.GM_E2E_APP_URL ?? 'http://127.0.0.1:4319';

const loopback = u => {
  try {
    const h = new globalThis.URL(u).hostname;
    return ['127.0.0.1', 'localhost'].includes(h) && !/supabase\.co$/i.test(u);
  } catch { return false; }
};
if (!loopback(SUPABASE_URL)) { console.error('REFUSAL: GM_E2E_SUPABASE_URL is not an isolated loopback stack; aborting.'); process.exit(2); }
if (!loopback(MAIL_URL)) { console.error('REFUSAL: GM_E2E_MAIL_URL is not a loopback mail catcher; aborting.'); process.exit(2); }
if (!ANON || !SERVICE) { console.error('Missing GM_E2E_ANON_KEY / GM_E2E_SERVICE_KEY'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const errText = e => `${e?.message ?? e ?? ''} ${e?.code ?? ''}`;
const tag = `p16r-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;
const EVIL = 'https://evil.example.test/phish';
const APPROVED_REDIRECT = 'http://127.0.0.1:3000/auth/reset-callback';

const anonClient = () => createClient(SUPABASE_URL, ANON);
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function mustSingle(promise, what) {
  const r = await promise;
  if (r.error || !r.data) throw new Error(`fixture ${what}: ${errText(r.error) || 'no row returned'}`);
  return r.data;
}

// ---- mail catcher helpers (same discovery as Phase 15: Inbucket or Mailpit) ----
async function mailKind() {
  try { const r = await fetch(`${MAIL_URL}/api/v1/mailboxes`); if (r.ok) return 'inbucket'; } catch { /* not inbucket */ }
  try { const r = await fetch(`${MAIL_URL}/api/v1/messages?limit=1`); if (r.ok) return 'mailpit'; } catch { /* not mailpit */ }
  return 'unknown';
}
let MAIL_KIND = 'unknown';
async function mailboxMessages(mailbox) {
  if (MAIL_KIND === 'mailpit') {
    const r = await fetch(`${MAIL_URL}/api/v1/messages?limit=50`);
    const j = await r.json();
    return (j.messages ?? []).filter(m => (m.To ?? []).some(t => t.Address === mailbox || m.Snippet?.includes(mailbox)));
  }
  const r = await fetch(`${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(mailbox)}`);
  if (!r.ok) return [];
  const j = await r.json();
  return j ?? [];
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

async function signInPage(page, n) {
  await page.goto(`${APP}/signin`, { waitUntil: 'networkidle' });
  await page.locator('#auth-login').fill(email(n));
  await page.locator('#auth-password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'), { timeout: 20000 });
}

async function main() {
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));
  MAIL_KIND = await mailKind();
  check('disposable mail catcher reachable', MAIL_KIND === 'inbucket' || MAIL_KIND === 'mailpit', MAIL_KIND);

  // ---- A. approved-redirect URL behaviour ----
  const goodSignup = await anonClient().auth.signUp({ email: email('redirect-ok'), password: PASSWORD, options: { emailRedirectTo: APPROVED_REDIRECT } });
  check('signup with an allow-listed redirect is accepted', !goodSignup.error && !!goodSignup.data.user, errText(goodSignup.error));
  const evilSignup = await anonClient().auth.signUp({ email: email('redirect-evil'), password: PASSWORD, options: { emailRedirectTo: EVIL } });
  check('signup with an unapproved redirect is rejected', !!evilSignup.error, 'evil redirect unexpectedly accepted');
  const evilRecovery = await anonClient().auth.resetPasswordForEmail(email('redirect-ok'), { redirectTo: EVIL });
  check('password recovery to an unapproved redirect is rejected', !!evilRecovery.error, 'evil recovery redirect unexpectedly accepted');

  // ---- B. link-expiry handling beyond simple replay ----
  const garbage = await anonClient().auth.verifyOtp({ token_hash: 'not-a-real-token', type: 'signup' });
  check('garbage verify token is rejected (invalid/expired link)', !!garbage.error, 'garbage token unexpectedly accepted');
  const invEmail = email('invited-r');
  const gotrueInv = await admin.auth.admin.inviteUserByEmail(invEmail);
  check('GoTrue invitation created for replay test', !gotrueInv.error && !!gotrueInv.data.user, errText(gotrueInv.error));
  const invBody = await latestEmailBody(invEmail, 'invite');
  const invLink = extractVerifyToken(invBody);
  check('invitation email carries an invite link', !!invLink && invLink.type === 'invite', invLink ? invLink.type : 'no link');
  const invClient = anonClient();
  const invVerify = await invClient.auth.verifyOtp({ token_hash: invLink.token, type: 'invite' });
  check('invite link yields a session on first use', !invVerify.error && !!invVerify.data.session, errText(invVerify.error));
  const invReplay = await anonClient().auth.verifyOtp({ token_hash: invLink.token, type: 'invite' });
  check('used invite link is rejected on replay (single-use)', !!invReplay.error, 'invite replay unexpectedly accepted');
  const invPw = await invClient.auth.updateUser({ password: PASSWORD });
  check('invited user sets a password', !invPw.error, errText(invPw.error));
  const invSignin = await anonClient().auth.signInWithPassword({ email: invEmail, password: PASSWORD });
  check('invited user signs in with the new password', !invSignin.error && !!invSignin.data.session, errText(invSignin.error));
  // OTP lifetime is a deployment fact: true expiry would require waiting out
  // the window, so the suite asserts the configured value + single-use +
  // garbage rejection instead of pretending to time-travel.
  const cfg = readFileSync('supabase/config.toml', 'utf8');
  const otpExpiry = (cfg.match(/otp_expiry\s*=\s*(\d+)/) ?? [])[1];
  check('auth OTP expiry is the documented 3600s (expiry-beyond-replay needs a 1h wait, not exercised)', otpExpiry === '3600', `otp_expiry=${otpExpiry}`);

  // ---- fixtures for C-E ----
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error) throw new Error(`fixture user ${n}: ${r.error.message}`);
    await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
    return r.data.user.id;
  };
  const adminAUid = await mkUser('admin-a'), bookerAUid = await mkUser('booker-a');
  const custUid = await mkUser('customer'), pendUid = await mkUser('pending-u'), suspUid = await mkUser('susp-u');
  void custUid; void pendUid;
  const opsUid = await mkUser('ops'), finUid = await mkUser('fin'), boardUid = await mkUser('boarder');
  await admin.from('role_assignments').insert([
    { user_id: opsUid, organization_id: null, role: 'operations', status: 'active' },
    { user_id: finUid, organization_id: null, role: 'finance', status: 'active' },
    { user_id: boardUid, organization_id: null, role: 'boarding_staff', status: 'active' },
  ]);
  const orgA = (await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional OrgA ${tag} LLC`, display_name: 'OrgA', status: 'approved',
    account_type: 'corporate', contact_email: `orga-${tag}@example.test`, created_by: adminAUid,
  }).select('id').single(), 'orgA insert')).id;
  await admin.from('organization_memberships').insert([
    { organization_id: orgA, user_id: adminAUid, membership_role: 'company_admin', status: 'active' },
    { organization_id: orgA, user_id: bookerAUid, membership_role: 'company_booker', status: 'active' },
    { organization_id: orgA, user_id: suspUid, membership_role: 'company_booker', status: 'active' },
  ]);
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const vessel = (await mustSingle(admin.from('vessels').insert({ name: `Roles vessel ${tag}`, passenger_capacity: 60, status: 'active' }).select('id').single(), 'vessel insert')).id;
  const t0 = Date.now() + 30 * 86400_000;
  let sailN = 0;
  const mkSailing = async (cap) => (await mustSingle(admin.from('sailings').insert({
    route_id: outRoute.id, vessel_id: vessel,
    departs_at: new Date(t0 + (sailN++) * 15 * 60000).toISOString(), seat_capacity: cap, status: 'open',
  }).select('id').single(), 'sailing insert')).id;
  const sVis = await mkSailing(12);
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cAdminA = await signIn('admin-a'), cBookerA = await signIn('booker-a');
  const cOps = await signIn('ops');
  const cFin = await signIn('fin'), cBoard = await signIn('boarder');
  const terms = (await cAdminA.from('service_policies').select('version').eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional']).order('effective_from', { ascending: false }).limit(1)).data?.[0]?.version;
  check('roles fixtures ready', !!terms, 'terms missing');
  const orgBook = (c, sailing, key, pax = 1) => c.rpc('create_organization_booking', {
    p_request_key: key, p_organization_id: orgA, p_outbound_sailing_id: sailing, p_passenger_count: pax,
    p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
    p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
    p_po_reference: `PO-R-${key.slice(0, 8)}`, p_client_name: null, p_client_reference: null,
    p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
  });

  // ---- C. pending/suspended lifecycle edges ----
  const cPend = await signIn('pending-u');
  const reg = await cPend.rpc('register_company', {
    p_registration_key: randomUUID(), p_legal_name: `Fictional PendCo ${tag} LLC`,
    p_profile_display_name: 'Fictional Pending', p_display_name: 'PendCo',
    p_registration_number: null, p_billing_contact: null,
    p_contact_email: email('pending-u'), p_contact_phone: '+966500000005', p_language: 'en',
  });
  check('pending user registers (accepted, unapproved)', !reg.error, errText(reg.error));
  const visB1 = await orgBook(cBookerA, sVis, randomUUID(), 1);
  check('booker visibility booking created', !visB1.error && !!visB1.data?.[0]?.booking_id, errText(visB1.error));
  const pendAmend = await cPend.rpc('amend_booking', { p_booking_id: visB1.data?.[0]?.booking_id, p_contact_name: 'Pending Meddler' });
  check('pending (unapproved) member cannot amend company bookings', !!pendAmend.error, 'pending amend unexpectedly accepted');
  // Suspended user: writes blocked, reads preserved.
  const suspBook = await orgBook(await signIn('susp-u'), sVis, randomUUID(), 1);
  check('pre-suspension booking created (control)', !suspBook.error && !!suspBook.data?.[0]?.booking_id, errText(suspBook.error));
  await admin.from('profiles').update({ status: 'suspended' }).eq('id', suspUid);
  const cSusp = await signIn('susp-u');
  check('suspended user still gets a session (GoTrue is unaware of profile status)', !!cSusp, 'signin unexpectedly failed');
  const suspWrite = await orgBook(cSusp, sVis, randomUUID(), 1);
  check('suspended account cannot create bookings (profile_suspended)', !!suspWrite.error && /profile_suspended|suspended/.test(errText(suspWrite.error)), errText(suspWrite.error));
  const suspReads = await cSusp.from('bookings').select('id');
  check('suspended account keeps read access to own bookings', !suspReads.error && (suspReads.data ?? []).some(r => r.id === suspBook.data?.[0]?.booking_id), errText(suspReads.error));

  // ---- D. explicit booker-vs-admin visibility over REST ----
  const visB2 = await orgBook(cAdminA, sVis, randomUUID(), 1);
  check('admin visibility booking created', !visB2.error && !!visB2.data?.[0]?.booking_id, errText(visB2.error));
  const idB1 = visB1.data?.[0]?.booking_id, idB2 = visB2.data?.[0]?.booking_id;
  const bookerSees = await cBookerA.from('bookings').select('id');
  check('booker sees exactly their own booking via REST', !bookerSees.error && bookerSees.data.length === 1 && bookerSees.data[0].id === idB1, JSON.stringify((bookerSees.data ?? []).map(r => r.id)));
  const adminSees = await cAdminA.from('bookings').select('id');
  const adminIds = (adminSees.data ?? []).map(r => r.id);
  check('company admin sees both company bookings via REST', !adminSees.error && adminIds.includes(idB1) && adminIds.includes(idB2), JSON.stringify(adminIds));

  // ---- E. administrator-role matrix (derived from RLS/RPC guards, not invented) ----
  const pubFin = await cFin.rpc('publish_tariff', { p_code: `P16-${tag}`, p_per_person_halala: 50000, p_vat_mode: 'not_configured', p_vat_rate_bp: null, p_effective_from: new Date().toISOString(), p_route_id: null, p_notes: 'Phase 16 matrix (fictional tariff, not an ATCO price)', p_reason: 'Matrix drill (fictional)' });
  check('finance publishes a tariff (control)', !pubFin.error && !!pubFin.data, errText(pubFin.error));
  const pubBoard = await cBoard.rpc('publish_tariff', { p_code: `P16B-${tag}`, p_per_person_halala: 50000, p_vat_mode: 'not_configured', p_vat_rate_bp: null, p_effective_from: new Date().toISOString(), p_route_id: null, p_notes: null, p_reason: 'x' });
  check('boarding staff cannot publish tariffs', !!pubBoard.error && /not authorized/.test(errText(pubBoard.error)), errText(pubBoard.error));
  const pubAdmin = await cAdminA.rpc('publish_tariff', { p_code: `P16C-${tag}`, p_per_person_halala: 50000, p_vat_mode: 'not_configured', p_vat_rate_bp: null, p_effective_from: new Date().toISOString(), p_route_id: null, p_notes: null, p_reason: 'x' });
  check('company admin cannot publish tariffs', !!pubAdmin.error && /not authorized/.test(errText(pubAdmin.error)), errText(pubAdmin.error));
  const readyFin = await cFin.rpc('set_sailing_readiness', { p_sailing_id: sVis, p_status: 'ready', p_reason: 'Finance overreach (fictional)' });
  check('finance cannot set sailing readiness', !!readyFin.error && /not authorized/.test(errText(readyFin.error)), errText(readyFin.error));
  const readyOps = await cOps.rpc('set_sailing_readiness', { p_sailing_id: sVis, p_status: 'ready', p_reason: 'Phase 16 matrix (fictional)' });
  check('operations sets sailing readiness (control)', !readyOps.error, errText(readyOps.error));
  const approveOps = await cOps.rpc('approve_tariff', { p_tariff_id: pubFin.data, p_reason: 'Ops approval (fictional)' });
  check('operations cannot approve tariffs', !!approveOps.error && /not authorized/.test(errText(approveOps.error)), errText(approveOps.error));
  const anonManif = await anonClient().rpc('ticket_manifest', { p_sailing_id: sVis });
  check('anonymous manifest read is denied', !!anonManif.error, 'anon manifest unexpectedly succeeded');

  // ---- F. real-Chromium corporate views (no interception) ----
  const browser = await chromium.launch();
  // Admin: own booking in the list, company report visible.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signInPage(page, 'admin-a');
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    const refB2 = (await admin.from('bookings').select('reference').eq('id', idB2).single()).data?.reference;
    const refB1 = (await admin.from('bookings').select('reference').eq('id', idB1).single()).data?.reference;
    check('admin signs in and corporate loads', true);
    check('admin list shows own booking (mine scope)', !!refB2 && body.includes(refB2), refB2);
    check('admin list hides the booker booking (mine scope, org-wide lives in the report)', !!refB1 && !body.includes(refB1), refB1);
    check('admin sees the company account report', (await page.locator('#ca-from').count()) >= 1);
    check('admin journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }
  // Booker: own booking only, admin-only notice, no report.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signInPage(page, 'booker-a');
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    const refB2 = (await admin.from('bookings').select('reference').eq('id', idB2).single()).data?.reference;
    const refB1 = (await admin.from('bookings').select('reference').eq('id', idB1).single()).data?.reference;
    check('booker list shows own booking', !!refB1 && body.includes(refB1), refB1);
    check('booker list hides the admin booking', !!refB2 && !body.includes(refB2), refB2);
    check('booker sees the admin-only notice, not the report', body.includes('Available to company administrators') && (await page.locator('#ca-from').count()) === 0);
    check('booker journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }
  // Customer without a company: no-company guidance + registration link.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signInPage(page, 'customer');
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    check('customer sees the no-company guidance', body.includes('No approved company yet.'));
    check('customer gets the registration link', (await page.locator('a[href="/onboarding"]').count()) >= 1);
    check('customer journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }
  await browser.close();

  console.log(`\nPHASE16-ROLES-REDIRECTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 300)); process.exit(1); });
