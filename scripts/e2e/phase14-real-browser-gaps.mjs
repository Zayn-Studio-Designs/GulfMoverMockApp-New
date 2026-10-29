#!/usr/bin/env node
// Phase 14 — browser gap journeys against the REAL isolated Supabase stack.
//
// No route interception: every /rest/v1 and /auth/v1 request reaches the
// disposable stack. Fictional users/data only. Exits non-zero on any failure.
//
//  1. Pending member: registers a company via API (pending, unapproved), then
//     signs in through the real UI — corporate must show the "Awaiting ATCO
//     approval" state and expose no booking data.
//  2. Second booker: two active bookers in the same company each hold a
//     booking; the second booker signs in through the real UI and must see
//     ONLY their own reference (not the first booker's, not the other
//     company's), including after reload; sign-out clears all booking data.
//
// Env: GM_E2E_APP_URL (built preview), GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY,
// GM_E2E_SERVICE_KEY. Refuses non-loopback Supabase URLs.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const APP = process.env.GM_E2E_APP_URL ?? 'http://127.0.0.1:4319';
const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';

const host = (() => { try { return new globalThis.URL(SUPABASE_URL).hostname; } catch { return ''; } })();
if (!['127.0.0.1', 'localhost'].includes(host) || /supabase\.co$/i.test(SUPABASE_URL)) {
  console.error('REFUSAL: not an isolated loopback stack; aborting.');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};

const tag = `p14b-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

// Fixture inserts must fail loudly with the database error, never with a
// bare TypeError on a null row.
async function mustSingle(promise, what) {
  const r = await promise;
  const msg = `${r?.error?.message ?? r?.error ?? ''} ${r?.error?.code ?? ''}`.trim();
  if (r.error || !r.data) throw new Error(`fixture ${what}: ${msg || 'no row returned'}`);
  return r.data;
}

async function fixtureUser(n) {
  const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
  if (r.error) throw new Error(`user ${n}: ${r.error.message}`);
  await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
  return r.data.user.id;
}

async function setup() {
  const a1 = await fixtureUser('booker-a1'), a2 = await fixtureUser('booker-a2');
  const adminB = await fixtureUser('admin-b'), pendU = await fixtureUser('pending-u');
  const mkOrg = async (label, by) => (await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional ${label} ${tag} LLC`, display_name: label, status: 'approved',
    account_type: 'corporate', contact_email: `${label}-${tag}@example.test`, created_by: by,
  }).select('id').single(), `organization insert (${label})`)).id;
  const orgA = await mkOrg('OrgA', a1), orgB = await mkOrg('OrgB', adminB);
  await admin.from('organization_memberships').insert([
    { organization_id: orgA, user_id: a1, membership_role: 'company_booker', status: 'active' },
    { organization_id: orgA, user_id: a2, membership_role: 'company_booker', status: 'active' },
    { organization_id: orgB, user_id: adminB, membership_role: 'company_admin', status: 'active' },
  ]);
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const vessel = (await mustSingle(admin.from('vessels').insert({ name: `Gap browser vessel ${tag}`, passenger_capacity: 12, status: 'active' }).select('id').single(), 'vessel insert')).id;
  const outS = (await mustSingle(admin.from('sailings').insert({ route_id: outRoute.id, vessel_id: vessel, departs_at: new Date(Date.now() + 30 * 86400_000).toISOString(), seat_capacity: 12, status: 'open' }).select('id').single(), 'sailing insert')).id;
  const termsClient = createClient(SUPABASE_URL, ANON);
  await termsClient.auth.signInWithPassword({ email: email('booker-a1'), password: PASSWORD });
  // service_role is revoked on service_policies; the app reads terms as the user.
  const terms = (await termsClient.from('service_policies').select('version').eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional']).order('effective_from', { ascending: false }).limit(1)).data?.[0]?.version;
  if (!terms) throw new Error('terms version unavailable, aborting fixtures');
  const bookAs = async (n, org, ref) => {
    const c = createClient(SUPABASE_URL, ANON);
    await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    const r = await c.rpc('create_organization_booking', {
      p_request_key: randomUUID(), p_organization_id: org, p_outbound_sailing_id: outS, p_passenger_count: 1,
      p_contact_name: 'Fictional Crew', p_contact_email: 'crew@example.test', p_contact_phone: '+966500000003',
      p_terms_version: terms, p_settlement_mode: 'pay_now', p_passenger_names: null, p_return_sailing_id: null,
      p_po_reference: ref, p_client_name: null, p_client_reference: null,
      p_destination_vessel: null, p_destination_imo: null, p_permit_status: null,
    });
    if (r.error) throw new Error(`booking ${n}: ${r.error.message}`);
    return r.data[0].reference;
  };
  const refA1 = await bookAs('booker-a1', orgA, 'PO-A1');
  const refA2 = await bookAs('booker-a2', orgA, 'PO-A2');
  const refB = await bookAs('admin-b', orgB, 'PO-B');
  // Pending member: registers their own company (stays pending, never approved here).
  const cPend = createClient(SUPABASE_URL, ANON);
  await cPend.auth.signInWithPassword({ email: email('pending-u'), password: PASSWORD });
  const reg = await cPend.rpc('register_company', {
    p_registration_key: randomUUID(), p_legal_name: `Fictional PendCo ${tag} LLC`,
    p_profile_display_name: 'Fictional Pending', p_display_name: 'PendCo',
    p_registration_number: null, p_billing_contact: null,
    p_contact_email: email('pending-u'), p_contact_phone: '+966500000005', p_language: 'en',
  });
  if (reg.error) throw new Error(`pending registration: ${reg.error.message}`);
  return { refA1, refA2, refB };
}

async function signIn(page, n) {
  await page.goto(`${APP}/signin`, { waitUntil: 'networkidle' });
  await page.locator('#auth-login').fill(email(n));
  await page.locator('#auth-password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'), { timeout: 20000 });
}

async function main() {
  const { refA1, refA2, refB } = await setup();
  console.log(`fixtures ready: A1=${refA1} A2=${refA2} B=${refB}`);
  const browser = await chromium.launch();

  // ---- pending member: real UI shows the awaiting-approval state, no bookings ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signIn(page, 'pending-u');
    check('pending member signs in through the real UI', true);
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    check('pending member sees the awaiting-approval state', /Awaiting ATCO approval/i.test(body));
    check('pending member sees no booking references', ![refA1, refA2, refB].some(r => body.includes(r)));
    check('pending member is not shown the bookings section', (await page.locator('#corp-bookings').count()) === 0);
    await page.goto(`${APP}/onboarding`, { waitUntil: 'networkidle' });
    const onb = await page.locator('body').innerText();
    check('pending member sees pending status on onboarding', /Pending ATCO review|under review|Awaiting ATCO approval/i.test(onb));
    check('pending journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // ---- second booker: sees only their own booking, reload + sign-out ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signIn(page, 'booker-a2');
    check('second booker signs in through the real UI', true);
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const body = (await page.locator('body').innerText()).slice(0, 4000);
    check('second booker sees their own booking reference', body.includes(refA2), refA2);
    check('second booker does NOT see the first booker reference', !body.includes(refA1), refA1);
    check('second booker does NOT see the other company reference', !body.includes(refB), refB);
    await page.reload({ waitUntil: 'networkidle' });
    const body2 = await page.locator('body').innerText();
    check('isolation holds after reload (own visible, others hidden)',
      body2.includes(refA2) && !body2.includes(refA1) && !body2.includes(refB));
    await page.locator('.account-btn').click();
    await page.locator('.account-signout').click();
    await page.waitForURL('**/signin*', { timeout: 20000 });
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const signedOut = await page.locator('body').innerText();
    check('signed-out corporate shows no booking data',
      ![refA1, refA2, refB].some(r => signedOut.includes(r)));
    check('second-booker journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }

  await browser.close();
  console.log(`\nPHASE14-BROWSER-GAPS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 400)); process.exit(1); });
