#!/usr/bin/env node
// Phase 11 — signed-in role-isolation browser journeys against a stubbed backend.
//
// What this proves (isolated UI behaviour in real Chromium):
// - a company booker sees their own bookings but never another company's reference;
// - a company admin sees the company account report; a booker sees the admin-only notice;
// - a customer with no company gets registration guidance (never a blank page);
// - pending / staff states render truthful guidance;
// - staff-only pages refuse customers, and serve staff the real screens;
// - consequential staff actions travel through the server API (recorded REST write),
//   not local-only state;
// - EN/AR rendering incl. RTL, no raw translation keys, clean console, responsive.
//
// What this does NOT prove: real database authorization. All /rest, /auth and
// /storage traffic is answered by canned fixtures below (fictional data), with
// per-persona filtering that *simulates* RLS. Real authorization evidence comes
// from src/tests/db/** (real PostgreSQL, incl. the Phase 10.3 catalog proof) and
// the MemoryRouter + fake-Supabase component tests. Labelled accordingly.
//
//   VITE_APP_MODE=production VITE_SUPABASE_URL=http://127.0.0.1:54399 \
//   VITE_SUPABASE_ANON_KEY=phase11-fictional-publishable-key \
//   VITE_AUTH_RESET_REDIRECT_URL=http://127.0.0.1:4319/auth/reset-callback \
//   npm run build && npx vite preview --port 4319 --host 127.0.0.1 &
//   GM_E2E_APP_URL=http://127.0.0.1:4319 node scripts/e2e/phase11-signed-in-routes.mjs
import { chromium } from 'playwright';

const APP = process.env.GM_E2E_APP_URL ?? 'http://127.0.0.1:4319';
const API = 'http://127.0.0.1:54399';

const now = Date.now();
const iso = h => new Date(now + h * 3_600_000).toISOString();

const ORG_A = { id: 'org-a', legal: 'Fictional Agency LLC', display: 'Fictional Agency', status: 'approved' };
const ORG_B = { id: 'org-b', legal: 'Second Fictional Co', display: 'Second Fictional', status: 'approved' };
const ORG_C = { id: 'org-c', legal: 'Pending Fictional Ltd', display: 'Pending Fictional', status: 'pending' };

const membership = (org, role, mstatus = 'active') => ({
  organization_id: org.id, membership_role: role, membership_status: mstatus,
  legal_name: org.legal, display_name: org.display, organization_status: org.status,
});
const booking = (id, ref, orgId) => ({
  id, reference: ref, status: 'reserved', payment_status: 'unpaid', passenger_count: 2,
  contact_name: 'Fictional Traveller', contact_email: 'traveller@example.test',
  contact_phone: '+966500000000', passenger_names: ['Fictional Traveller'], po_reference: null,
  organization_id: orgId, created_at: iso(-5), booking_legs: [],
});
const user = (id, email) => ({
  id, aud: 'authenticated', role: 'authenticated', email,
  user_metadata: { display_name: email }, app_metadata: {}, created_at: '2026-01-01T00:00:00Z', factors: [],
});

const VESSEL = { id: 'v1', name: 'Provisional Taxi Vessel - pending ATCO confirmation', passenger_capacity: null, status: 'active' };
const ROUTE = { id: 'r1', origin: 'Ras Tanura Service Pier', destination: 'Approved Anchorage - pending ATCO confirmation', status: 'active' };
const sailing = (id, h) => ({
  id, departs_at: iso(h), status: 'open', seat_capacity: 12, seats_booked: 3,
  readiness_status: 'pending', master_decision: 'pending', port_clearance_status: 'pending',
  commercial_decision: 'none', payload_capacity_kg: 800, payload_booked_kg: 120,
  // Embedded route needs id/status: toRoute() throws without an id (real PostgREST embeds carry them).
  route: { id: ROUTE.id, origin: ROUTE.origin, destination: ROUTE.destination, status: ROUTE.status },
  vessel: { id: VESSEL.id, name: VESSEL.name },
});
const TEMPLATE = {
  id: 'st1', departure_local: '07:00:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], seat_capacity: 12,
  active: true, notes: 'ATCO-specified outbound time',
  route: { origin: ROUTE.origin, destination: ROUTE.destination }, vessel: { name: VESSEL.name },
};

// Per-persona fixtures. The bookings/table rows returned are already filtered
// to what RLS would allow that caller to see — the test asserts the UI never
// shows the other company's data.
const PERSONAS = {
  bookerA: {
    user: user('u-booker-a', 'booker-a@example.test'),
    memberships: [membership(ORG_A, 'company_booker')],
    roles: [],
    bookings: [booking('b-a1', 'GM-A1B2C3D4', ORG_A.id)],
    report: [],
  },
  adminA: {
    user: user('u-admin-a', 'admin-a@example.test'),
    memberships: [membership(ORG_A, 'company_admin'), membership(ORG_B, 'company_booker')],
    roles: [],
    bookings: [booking('b-a9', 'GM-A9Z8Y7X6', ORG_A.id)],
    report: [{ period: '2026-10-29', sailings: 2, seat_capacity: 24, tickets_issued: 4, passengers_boarded: 0,
      no_shows: 0, bookings_created: 1, bookings_cancelled: 0, gross_collected_halala: 200000, refunded_halala: 0,
      on_account_invoiced_halala: 0, materials_delivered_kg: 0 }],
  },
  bookerB: {
    user: user('u-booker-b', 'booker-b@example.test'),
    memberships: [membership(ORG_B, 'company_booker')],
    roles: [],
    bookings: [booking('b-b1', 'GM-B4D3C2B1', ORG_B.id)],
    report: [],
  },
  customer: {
    user: user('u-cust', 'customer@example.test'),
    memberships: [],
    roles: [],
    bookings: [],
    report: [],
  },
  pending: {
    user: user('u-pend', 'pending@example.test'),
    memberships: [membership(ORG_C, 'company_admin', 'active')],
    roles: [],
    bookings: [],
    report: [],
  },
  ops: {
    user: user('u-ops', 'ops@example.test'),
    memberships: [],
    roles: [{ role: 'operations', status: 'active' }],
    bookings: [],
    report: [],
  },
};

const fulfil = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// One isolated browser context per persona: fresh session, fixtures filtered
// to that persona (simulating RLS), and a write log proving UI actions reach
// the server API rather than local-only state.
async function preparePersona(browser, key, viewport) {
  const p = PERSONAS[key];
  const writes = [];
  const context = await browser.newContext({ viewport });
  await context.route(`${API}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === '/__writes') return fulfil(route, writes);
    if (path.startsWith('/auth/v1/user')) return fulfil(route, p.user);
    if (path.startsWith('/auth/v1/')) return fulfil(route, {});
    // Supabase RPCs arrive as POST: route them to their fixtures (recording
    // the call too), before the generic table-write branch below.
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(path);
    if (rpc) {
      const name = rpc[1];
      let rpcBody = null;
      try { rpcBody = req.postDataJSON(); } catch { rpcBody = null; }
      writes.push({ method: req.method(), path, body: rpcBody });
      if (name === 'my_company_memberships') return fulfil(route, p.memberships);
      if (name === 'report_my_organization') return fulfil(route, p.report);
      return fulfil(route, []);
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      let body = null;
      try { body = req.postDataJSON(); } catch { body = null; }
      writes.push({ method: req.method(), path, body });
      if (path === '/rest/v1/vessels' && req.method() === 'POST') return fulfil(route, { id: 'v-stub-1', ...(body ?? {}) }, 201);
      return fulfil(route, 'ok');
    }
    const table = /\/rest\/v1\/([a-z_]+)/.exec(path)?.[1];
    const single = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    const one = v => (single ? v : [v]);
    switch (table) {
      case 'profiles': return fulfil(route, single ? { status: 'active' } : [{ status: 'active' }]);
      case 'role_assignments': return fulfil(route, p.roles);
      case 'bookings': return fulfil(route, p.bookings);
      case 'booking_legs': return fulfil(route, []);
      case 'vessels': return fulfil(route, one(VESSEL));
      case 'routes': return fulfil(route, one(ROUTE));
      case 'sailings': return fulfil(route, single ? sailing('s1', 30) : [sailing('s1', 30), sailing('s2', 54)]);
      case 'schedule_templates': return fulfil(route, single ? TEMPLATE : [TEMPLATE]);
      case 'invoices': case 'agent_settlements': return fulfil(route, []);
      default: return fulfil(route, single ? null : []);
    }
  });
  await context.addInitScript(([personaUser]) => {
    const session = { access_token: 'header.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig', token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fictional', user: personaUser };
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    localStorage.setItem('gm-demo-tour-seen', JSON.stringify([personaUser.id]));
  }, [p.user]);
  const page = await context.newPage();
  return { context, page, writesUrl: `${API}/__writes` };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const RAW_KEY_RE = /[a-z0-9_]*(p[45][A-Z][A-Za-z0-9_]*|nav[A-Z][A-Za-z]*|pb[A-Z][A-Za-z]*|p8[A-Z][A-Za-z]*|ao[A-Z][A-Za-z]*|ops[A-Z][A-Za-z]*|onb[A-Z][A-Za-z]*|ds[A-Z][A-Za-z]*|adm[A-Z][A-Za-z]*)/;

async function bodyText(page) { return (await page.locator('body').textContent().catch(() => '')) ?? ''; }
// Static headers render before the async data chain (session -> snapshot ->
// lists) resolves. Wait for a scenario marker (expected content OR its empty
// state) so absence assertions cannot pass vacuously on a half-loaded page.
async function awaitSettled(page, markers, timeout = 15000) {
  await page.waitForFunction(ms => ms.some(m => (document.body.textContent ?? '').includes(m)), markers, { timeout }).catch(() => null);
}
async function expectClean(page, label) {
  const body = await bodyText(page);
  const raw = [...body.matchAll(new RegExp(RAW_KEY_RE, 'g'))].map(m => m[1] ?? m[0]).filter(Boolean);
  check(`${label} no raw translation keys`, raw.length === 0, raw.slice(0, 3).join(','));
  check(`${label} no demo fallback`, !body.includes('Not connected in this build'));
}

const DESKTOP = { width: 1366, height: 900 };
const PHONE = { width: 390, height: 844 };

const browser = await chromium.launch();
try {
  // 1 — Company booker sees own booking, never the other company's; admin-only notice, no admin report.
  {
    const { context, page } = await preparePersona(browser, 'bookerA', DESKTOP);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['GM-A1B2C3D4', 'You have no reservations yet.', 'could not load']);
    const body = await bodyText(page);
    check('bookerA /corporate shows own booking', body.includes('GM-A1B2C3D4'));
    check('bookerA /corporate hides other company booking', !body.includes('GM-B4D3C2B1'));
    // The staff nav also links 'Company account', so the admin report is told apart by its subtitle.
    check('bookerA /corporate admin-only notice, no admin report',
      body.includes('Available to company administrators') && !body.includes('Your organization\u2019s activity'));
    await expectClean(page, 'bookerA /corporate en');
    check('bookerA /corporate heading', ((await page.locator('h1').first().textContent().catch(() => '')) ?? '').includes('Corporate workspace'));
    check('bookerA console clean', errors.filter(e => !/favicon|404|net::/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));
    await context.close();
  }

  // 2 — Same page in Arabic: translated, RTL, still isolated.
  {
    const { context, page } = await preparePersona(browser, 'bookerA', DESKTOP);
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['GM-A1B2C3D4', 'You have no reservations yet.', 'could not load']);
    try {
      const menu = page.getByRole('button', { name: /account menu|قائمة الحساب/i });
      if (await menu.count()) await menu.first().click({ timeout: 5000 });
      await page.getByRole('button', { name: 'العربية', exact: true }).first().click({ timeout: 5000 });
    } catch { /* reported via RTL check */ }
    await page.waitForTimeout(600);
    const body = await bodyText(page);
    const dir = await page.evaluate(() => document.documentElement.dir).catch(() => '');
    check('bookerA /corporate ar shows own booking', body.includes('GM-A1B2C3D4'));
    check('bookerA /corporate ar hides other company booking', !body.includes('GM-B4D3C2B1'));
    check('bookerA /corporate ar admin notice translated', body.includes('متاح لمسؤولي الشركات المعتمدة'));
    check('bookerA /corporate ar RTL + Arabic heading', dir === 'rtl' && body.includes('مساحة عمل الشركات'), `dir=${dir}`);
    await expectClean(page, 'bookerA /corporate ar');
    await context.close();
  }

  // 3 — Booker on phone, bookings list.
  {
    const { context, page } = await preparePersona(browser, 'bookerA', PHONE);
    await page.goto(`${APP}/bookings`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['GM-A1B2C3D4', 'You have no reservations yet.', 'could not load']);
    const body = await bodyText(page);
    check('bookerA phone /bookings shows own booking', body.includes('GM-A1B2C3D4'));
    check('bookerA phone /bookings hides other company', !body.includes('GM-B4D3C2B1'));
    await expectClean(page, 'bookerA phone /bookings');
    await context.close();
  }

  // 4 — Company admin sees the account report and both companies; still never the other booker's ref.
  {
    const { context, page } = await preparePersona(browser, 'adminA', DESKTOP);
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['GM-A9Z8Y7X6', 'Company account', 'could not load']);
    const body = await bodyText(page);
    check('adminA /corporate shows account report', body.includes('Company account'));
    check('adminA /corporate lists both companies', body.includes('Fictional Agency') && body.includes('Second Fictional'));
    check('adminA /corporate shows own booking', body.includes('GM-A9Z8Y7X6'));
    check('adminA /corporate hides other company booking', !body.includes('GM-B4D3C2B1'));
    await expectClean(page, 'adminA /corporate');
    await context.close();
  }

  // 5 — Second company's booker: mirror isolation.
  {
    const { context, page } = await preparePersona(browser, 'bookerB', DESKTOP);
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['GM-B4D3C2B1', 'You have no reservations yet.', 'could not load']);
    const body = await bodyText(page);
    check('bookerB /corporate shows own booking', body.includes('GM-B4D3C2B1'));
    check('bookerB /corporate hides first company booking', !body.includes('GM-A1B2C3D4') && !body.includes('GM-A9Z8Y7X6'));
    await expectClean(page, 'bookerB /corporate');
    await context.close();
  }

  // 6 — Customer with no company: registration guidance, never blank.
  {
    const { context, page } = await preparePersona(browser, 'customer', DESKTOP);
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['No approved company yet.', 'Awaiting ATCO approval', 'ATCO staff account']);
    const body = await bodyText(page);
    check('customer /corporate no-company guidance', body.includes('No approved company yet.'));
    const reg = page.getByRole('link', { name: 'Company registration' });
    check('customer /corporate registration link', (await reg.count()) > 0 && ((await reg.first().getAttribute('href')) ?? '').includes('/onboarding'));
    await expectClean(page, 'customer /corporate');
    await context.close();
  }

  // 7 — Customer refused at staff pages (aliases land canonical, then the guard refuses).
  {
    const { context, page } = await preparePersona(browser, 'customer', DESKTOP);
    await page.goto(`${APP}/operations`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['ATCO staff access required', 'Vessels and sailings']);
    let body = await bodyText(page);
    check('customer /operations lands canonical + refused',
      page.url().includes('/admin/operations') && body.includes('ATCO staff access required'), page.url());
    await page.goto(`${APP}/fleet`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1, [role="alert"]').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['does not have access', 'Sailing control']);
    body = await bodyText(page);
    check('customer /fleet lands canonical + refused',
      page.url().includes('/admin/sailings') && body.includes('Your account does not have access to this page.'), page.url());
    check('customer /fleet no control actions', !body.includes('Schedule a sailing'));
    await expectClean(page, 'customer staff pages');
    await context.close();
  }

  // 8 — Ops staff: real operations screen + a consequential action reaches the server API.
  {
    const { context, page } = await preparePersona(browser, 'ops', DESKTOP);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    await page.goto(`${APP}/operations`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['Vessels and sailings', 'No vessels recorded yet.', 'ATCO staff access required']);
    let body = await bodyText(page);
    check('ops /operations canonical + vessels screen',
      page.url().includes('/admin/operations') && body.includes('Vessels and sailings'), page.url());
    check('ops /operations lists stubbed vessel', body.includes('Provisional Taxi Vessel'));
    // Manifest read path lives on the schedule tab: open it and prove the empty-manifest truth.
    const manifestBtn = page.getByRole('button', { name: 'View reservations' }).first();
    if (await manifestBtn.count()) {
      await manifestBtn.click({ timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(800);
      body = await bodyText(page);
    }
    check('ops manifest empty state truthful',
      body.includes('Reservations on this departure') && body.includes('No reservations on this departure yet.'));
    await page.getByRole('tab', { name: 'Vessel register' }).click({ timeout: 8000 });
    await page.getByLabel(/Vessel name/).waitFor({ timeout: 8000 });
    await page.getByLabel(/Vessel name/).fill('Fictional Test Vessel');
    await page.getByRole('button', { name: 'Save record' }).click();
    await page.getByText('Saved.', { exact: true }).waitFor({ timeout: 10000 }).catch(() => null);
    body = await bodyText(page);
    check('ops add-vessel reports saved', body.includes('Saved.'));
    const writes = await page.evaluate(async () => {
      const r = await fetch('http://127.0.0.1:54399/__writes');
      return r.json();
    }).catch(() => []);
    const vesselPost = writes.find(w => w.path === '/rest/v1/vessels' && (w.method === 'POST' || w.method === 'PUT' || w.method === 'PATCH'));
    check('ops add-vessel travelled through the server API', !!vesselPost && JSON.stringify(vesselPost.body ?? {}).includes('Fictional Test Vessel'),
      JSON.stringify(vesselPost ?? writes.slice(0, 2)));
    check('ops console clean', errors.filter(e => !/favicon|404|net::/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));
    await expectClean(page, 'ops /operations');
    await context.close();
  }

  // 9 — Ops staff sailing control: manifest read path renders the empty-manifest truth.
  {
    const { context, page } = await preparePersona(browser, 'ops', DESKTOP);
    await page.goto(`${APP}/fleet`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['Sailing control', 'No sailings scheduled.', 'does not have access']);
    let body = await bodyText(page);
    check('ops /fleet canonical + sailing control',
      page.url().includes('/admin/sailings') && body.includes('Sailing control'), page.url());
    check('ops /fleet lists scheduled sailing', body.includes('Provisional Taxi Vessel'));
    await expectClean(page, 'ops /fleet');
    await context.close();
  }

  // 10 — Pending company: truthful status, no registration invitation.
  {
    const { context, page } = await preparePersona(browser, 'pending', DESKTOP);
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['under review', 'No approved company yet.', 'ATCO staff account']);
    const body = await bodyText(page);
    check('pending /corporate under-review guidance', body.includes('under review'));
    // The workspace card itself must not invite a new registration (the global nav link is out of scope).
    check('pending /corporate no registration link', (await page.locator('main').getByRole('link', { name: 'Company registration' }).count()) === 0);
    await expectClean(page, 'pending /corporate');
    await context.close();
  }

  // 11 — Staff account on corporate: directed to ATCO tooling, not company booking.
  {
    const { context, page } = await preparePersona(browser, 'ops', DESKTOP);
    await page.goto(`${APP}/corporate`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['ATCO staff account', 'No approved company yet.', 'under review']);
    const body = await bodyText(page);
    check('staff /corporate staff banner', body.includes('Your account holds an ATCO staff role'));
    check('staff /corporate no bookings section', !body.includes('Your bookings'));
    await expectClean(page, 'staff /corporate');
    await context.close();
  }

  // 12 — Ops staff in Arabic on phone: translated staff screen, RTL.
  {
    const { context, page } = await preparePersona(browser, 'ops', PHONE);
    await page.goto(`${APP}/operations`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('h1').first().waitFor({ timeout: 15000 });
    await awaitSettled(page, ['Vessels and sailings', 'No vessels recorded yet.', 'ATCO staff access required']);
    try {
      const menu = page.getByRole('button', { name: /account menu|قائمة الحساب/i });
      if (await menu.count()) await menu.first().click({ timeout: 5000 });
      await page.getByRole('button', { name: 'العربية', exact: true }).first().click({ timeout: 5000 });
    } catch { /* reported via RTL check */ }
    await page.waitForTimeout(600);
    const body = await bodyText(page);
    const dir = await page.evaluate(() => document.documentElement.dir).catch(() => '');
    check('ops phone ar staff screen translated', body.includes('السفن والرحلات'), `dir=${dir}`);
    check('ops phone ar RTL', dir === 'rtl', `dir=${dir}`);
    await expectClean(page, 'ops phone ar');
    await context.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter(r => !r);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (stubbed backend; isolated UI behaviour only — not DB authorization proof)`);
process.exit(failed.length ? 1 : 0);
