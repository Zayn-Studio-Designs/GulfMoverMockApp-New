#!/usr/bin/env node
// Phase 13 — browser journeys against the REAL isolated Supabase stack.
//
// No route interception: every /rest/v1 and /auth/v1 request reaches the
// disposable stack. Fictional users/data only. Exits non-zero on any failure.
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

const tag = `p13b-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function fixtureUser(n) {
  const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
  if (r.error) throw new Error(`user ${n}: ${r.error.message}`);
  await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
  return r.data.user.id;
}

async function setup() {
  const bookerA = await fixtureUser('booker-a'), adminB = await fixtureUser('admin-b');
  const customer = await fixtureUser('customer'), opsU = await fixtureUser('ops');
  await admin.from('role_assignments').insert({ user_id: opsU, organization_id: null, role: 'operations', status: 'active' });
  const mkOrg = async (label, by) => (await admin.from('organizations').insert({
    legal_name: `Fictional ${label} LLC`, display_name: label, status: 'approved',
    account_type: 'corporate', contact_email: `${label}@example.test`, created_by: by,
  }).select('id').single()).data.id;
  const orgA = await mkOrg('OrgA', bookerA), orgB = await mkOrg('OrgB', adminB);
  await admin.from('organization_memberships').insert([
    { organization_id: orgA, user_id: bookerA, membership_role: 'company_booker', status: 'active' },
    { organization_id: orgB, user_id: adminB, membership_role: 'company_admin', status: 'active' },
  ]);
  const routes = (await admin.from('routes').select('id, origin').limit(10)).data ?? [];
  const outRoute = routes.find(r => /Ras Tanura/i.test(r.origin)) ?? routes[0];
  const vessel = (await admin.from('vessels').insert({ name: `Browser vessel ${tag}`, passenger_capacity: 12, status: 'active' }).select('id').single()).data.id;
  const outS = (await admin.from('sailings').insert({ route_id: outRoute.id, vessel_id: vessel, departs_at: new Date(Date.now() + 30 * 86400_000).toISOString(), seat_capacity: 12, status: 'open' }).select('id').single()).data.id;
  const termsClient = createClient(SUPABASE_URL, ANON);
  await termsClient.auth.signInWithPassword({ email: email('booker-a'), password: PASSWORD });
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
  const refA = await bookAs('booker-a', orgA, 'PO-B1');
  const refB = await bookAs('admin-b', orgB, 'PO-B2');
  return { refA, refB };
}

async function signIn(page, n) {
  await page.goto(`${APP}/signin`, { waitUntil: 'networkidle' });
  await page.locator('#auth-login').fill(email(n));
  await page.locator('#auth-password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(u => !u.pathname.startsWith('/signin'), { timeout: 20000 });
}

async function main() {
  const { refA, refB } = await setup();
  console.log(`fixtures ready: A=${refA} B=${refB}`);
  const browser = await chromium.launch();

  // ---- booker-A: real UI signin, isolation, persistence, RTL ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signIn(page, 'booker-a');
    check('booker-A signs in through the real UI', true);
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const body = (await page.locator('body').innerText()).slice(0, 4000);
    check('corporate shows own booking reference', body.includes(refA), refA);
    check('corporate hides the other company reference', !body.includes(refB), refB);
    await page.reload({ waitUntil: 'networkidle' });
    const body2 = await page.locator('body').innerText();
    check('session persists across reload (reference still visible)', body2.includes(refA));
    // RTL via the account-menu language toggle.
    await page.locator('.account-btn').click();
    await page.locator('.lang-toggle button[lang="ar"]').click();
    const dir = await page.evaluate(() => document.documentElement.dir);
    check('Arabic switches layout to RTL', dir === 'rtl', dir);
    await page.locator('.account-btn').click();
    await page.locator('.lang-toggle button:not([lang])').first().click().catch(() => {});
    // Sign out through the real menu; corporate then shows the signed-out state.
    await page.locator('.account-btn').click();
    await page.locator('.account-signout').click();
    await page.waitForURL('**/signin*', { timeout: 20000 });
    check('sign-out returns to the sign-in screen', true);
    await page.goto(`${APP}/corporate`, { waitUntil: 'networkidle' });
    const signedOut = await page.locator('body').innerText();
    check('signed-out corporate shows no booking data', !signedOut.includes(refA) && !signedOut.includes(refB));
    check('booker-A journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // ---- customer: refused at staff pages over real data ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signIn(page, 'customer');
    await page.goto(`${APP}/operations`, { waitUntil: 'networkidle' });
    check('customer refused at /operations (no-access)', (await page.locator('#no-access').count()) >= 1);
    check('customer sees no vessel form', (await page.locator('#ops-vessel-name').count()) === 0);
    check('customer journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // ---- ops: authorized write through the real UI + API ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await signIn(page, 'ops');
    await page.goto(`${APP}/admin/operations`, { waitUntil: 'networkidle' });
    await page.getByRole('tab').nth(1).click();
    await page.waitForSelector('#ops-vessel-name', { timeout: 20000 });
    check('ops sees the vessel form', (await page.locator('#ops-vessel-name').count()) >= 1);
    const vesselName = `E2E Vessel ${tag}`;
    await page.locator('#ops-vessel-name').fill(vesselName);
    await page.locator('#ops-vessel-cap').fill('10');
    await page.getByRole('button', { name: /save|حفظ/i }).first().click();
    await page.waitForSelector('text=' + vesselName, { timeout: 20000 });
    check('ops creates a vessel through the real UI + API', true);
    check('ops journey has a clean console', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  }

  await browser.close();
  console.log(`\nPHASE13-BROWSER: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 400)); process.exit(1); });
