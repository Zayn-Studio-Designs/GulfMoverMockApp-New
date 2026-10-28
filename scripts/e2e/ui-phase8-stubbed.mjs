#!/usr/bin/env node
// Phase 8 UI rendering check with STUBBED network responses.
//
// What this proves: the new production pages render in Chromium at phone/tablet/desktop
// widths, in English and Arabic (dir=rtl), without horizontal page overflow or console
// errors, and every form control has an accessible name.
// What it does NOT prove: anything about the backend. All /rest, /auth and /storage
// requests are answered by canned fixtures below (fictional data). Security and business
// rules are proven by the real-database suites (src/tests/db).
//
//   npm run build (with VITE_APP_MODE=production VITE_SUPABASE_URL=http://127.0.0.1:54399 ...)
//   npx vite preview --port 4399 &   then:   node scripts/e2e/ui-phase8-stubbed.mjs
import { chromium } from 'playwright';

const APP = process.env.GM_UI_APP ?? 'http://127.0.0.1:4399';
const API = 'http://127.0.0.1:54399';
const USER = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'fictional.admin@example.test',
  user_metadata: { display_name: 'Fictional Admin' }, app_metadata: {}, created_at: '2026-01-01T00:00:00Z', factors: [] };
const now = Date.now();
const iso = h => new Date(now + h * 3_600_000).toISOString();
const ROUTE_OUT = { id: 'r1', origin: 'Ras Tanura Service Pier', destination: 'Approved Anchorage - pending ATCO confirmation', status: 'active' };
const ROUTE_BACK = { id: 'r2', origin: ROUTE_OUT.destination, destination: ROUTE_OUT.origin, status: 'active' };
const sailing = (id, r, h) => ({ id, departs_at: iso(h), seat_capacity: 12, seats_booked: 3, status: 'open', readiness_status: 'pending', master_decision: 'pending',
  port_clearance_status: 'pending', commercial_decision: 'none', payload_capacity_kg: 800, payload_booked_kg: 120, route: r, vessel: { id: 'v1', name: 'Provisional Taxi Vessel - pending ATCO confirmation' } });
const BOOKING = { id: 'b1', reference: 'GM-0A1B2C3D', status: 'reserved', payment_status: 'unpaid', passenger_count: 2, contact_name: 'Fictional Traveller',
  contact_email: 'traveller@example.test', contact_phone: '+966500000000', passenger_names: ['Fictional Traveller', 'Second Fictional'], po_reference: null,
  organization_id: null, created_at: iso(-1), settlement_mode: 'pay_now', account_type: 'individual', net_halala: 200000, vat_halala: 0, total_halala: 200000,
  vat_mode: 'not_configured', tariff_status: 'provisional', hold_expires_at: iso(0.4), client_name: null, terms_version: 'v1-provisional', cancel_reason: null,
  booking_legs: [{ leg: 'outbound', passengers: 2, sailing: { id: 's1', departs_at: iso(30), status: 'open', route: ROUTE_OUT, vessel: { name: 'Provisional Taxi Vessel' } } },
    { leg: 'return', passengers: 2, sailing: { id: 's2', departs_at: iso(34), status: 'open', route: ROUTE_BACK, vessel: { name: 'Provisional Taxi Vessel' } } }] };
const INVOICE = { id: 'i1', invoice_number: 'GM-INV-2026-000001', document_type: 'commercial_invoice', status: 'paid', settlement_mode: 'pay_now', issue_date: '2026-10-28',
  due_date: null, net_halala: 200000, vat_halala: 0, total_halala: 200000, amount_paid_halala: 200000, sandbox: true, buyer: { name: 'Fictional Traveller' },
  seller: { legal_name: null, vat_number: null }, qr_tlv: null, icv: 1, invoice_hash: 'abc=', booking: { reference: 'GM-0A1B2C3D' },
  invoice_lines: [{ line_no: 1, description: 'Passenger fare (outbound) Ras Tanura Service Pier -> Approved Anchorage', quantity: 2, unit_halala: 50000, net_halala: 100000, vat_rate_bp: 0, vat_halala: 0, total_halala: 100000 },
    { line_no: 2, description: 'Passenger fare (return) Approved Anchorage -> Ras Tanura Service Pier', quantity: 2, unit_halala: 50000, net_halala: 100000, vat_rate_bp: 0, vat_halala: 0, total_halala: 100000 }] };

const TABLES = {
  profiles: { status: 'active', display_name: 'Fictional Admin' },
  role_assignments: [{ role: 'super_admin', status: 'active' }],
  sailings: [sailing('s1', ROUTE_OUT, 30), sailing('s2', ROUTE_BACK, 34), sailing('s3', ROUTE_OUT, 54)],
  service_policies: [{ policy_type: 'booking_terms', version: 'v1-provisional', status: 'provisional', content: { title: { en: 'Gulf Mover booking terms (provisional)', ar: 'شروط حجز Gulf Mover (مؤقتة)' }, body: { en: 'Provisional demo terms.', ar: 'شروط تجريبية مؤقتة.' } } }],
  bookings: [BOOKING], invoices: [INVOICE], tariffs: [{ id: 't1', code: 'BASE-2026-ATCO-PENDING', per_person_halala: 50000, vat_mode: 'not_configured', vat_rate_bp: 0, approval_status: 'provisional', active: true, effective_from: iso(-500) }],
  platform_settings: [{ key: 'sailing.minimum_tickets', value: { value: 4 }, description: 'Minimum passenger tickets per sailing (provisional).', updated_at: iso(-5) }],
  organizations: [{ id: 'o1', legal_name: 'Fictional Shipping Agency LLC', display_name: 'Fictional Agency', account_type: 'agent', credit_status: 'none', credit_limit_halala: null, payment_terms_days: null }],
  schedule_templates: [{ id: 'st1', departure_local: '07:00:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], seat_capacity: 12, active: true, notes: 'ATCO-specified outbound time', route: ROUTE_OUT, vessel: { name: 'Provisional Taxi Vessel' } }],
};
const RPC = {
  my_company_memberships: [],
  quote_passenger_fare: [{ tariff_code: 'BASE-2026-ATCO-PENDING', tariff_status: 'provisional', unit_halala: 50000, quantity: 2, net_halala: 100000, vat_halala: 0, total_halala: 100000, vat_mode: 'not_configured', vat_rate_bp: 0, currency: 'SAR' }],
  sailing_commercial_status: [{ reserved_tickets: 3, qualifying_tickets: 1, qualifying_revenue_halala: 50000, threshold_tickets: 4, threshold_revenue_halala: 200000, threshold_met: false, confirmation_deadline: iso(6), commercial_state: 'awaiting_minimum', counting_basis: 'paid_and_on_account' }],
  sailing_boarding_gate: 'not_ready',
  my_security_posture: [{ is_staff: true, staff_roles: ['super_admin'], mfa_required: false, session_aal: 'aal1' }],
  system_diagnostics: { checked_at: iso(0), payments_mode: 'sandbox', payments_live_enabled: false, staff_mfa_required: false, outbox_failed: 0, refunds_pending_review: 1 },
  report_period_summary: [{ period: '2026-10-28', sailings: 6, seat_capacity: 72, tickets_issued: 14, passengers_boarded: 0, no_shows: 0, bookings_created: 7, bookings_cancelled: 1, gross_collected_halala: 350000, refunded_halala: 0, on_account_invoiced_halala: 100000, materials_delivered_kg: 120 }],
};

const fulfil = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function prepare(context) {
  await context.route(`${API}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/auth/v1/user')) return fulfil(route, USER);
    if (url.pathname.startsWith('/auth/v1/')) return fulfil(route, {});
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url.pathname);
    if (rpc) return fulfil(route, RPC[rpc[1]] ?? []);
    const table = /\/rest\/v1\/([a-z_]+)/.exec(url.pathname)?.[1];
    const data = TABLES[table] ?? [];
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    return fulfil(route, single ? (Array.isArray(data) ? data[0] ?? null : data) : (Array.isArray(data) ? data : [data]));
  });
  await context.addInitScript(([user]) => {
    const session = { access_token: 'header.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig', token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fictional', user };
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    localStorage.setItem('gm-demo-tour-seen', JSON.stringify([user.id]));
  }, [USER]);
}

const PAGES = ['/book', '/bookings/GM-0A1B2C3D', '/invoices/i1', '/admin/finance', '/admin/reports', '/admin/sailings', '/admin/system', '/account', '/company/account', '/onboarding'];
const VIEWPORTS = [{ name: 'phone', width: 390, height: 844 }, { name: 'tablet', width: 820, height: 1180 }, { name: 'desktop', width: 1366, height: 900 }];
const results = []; let failures = 0;
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); if (!ok) failures += 1; };

const browser = await chromium.launch(process.env.GM_CHROMIUM ? { executablePath: process.env.GM_CHROMIUM } : {});
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  await prepare(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  for (const lang of ['en', 'ar']) {
    for (const path of PAGES) {
      await page.goto(`${APP}${path}`);
      await page.waitForSelector('h1', { timeout: 15000 });
      await page.waitForTimeout(400);
      if (lang === 'ar') {
        // Switch with the real control in the account menu (language is per session).
        await page.locator('button.account-btn').click();
        await page.getByRole('button', { name: 'العربية' }).click();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      const info = await page.evaluate(() => ({
        dir: document.documentElement.dir,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        unlabeled: [...document.querySelectorAll('input:not([type=hidden]):not([style*="opacity: 0"]), select, textarea')].filter(el => {
          const id = el.id; const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          const label = id && document.querySelector(`label[for="${CSS.escape(id)}"]`); const wrapped = el.closest('label');
          return !(aria || label || wrapped);
        }).map(el => el.outerHTML.slice(0, 80)),
        h1: document.querySelector('h1')?.textContent ?? '',
        latinOnlyHeading: /^[\x00-\x7F]*$/.test(document.querySelector('h1')?.textContent ?? ''),
      }));
      const tag = `${vp.name} ${lang} ${path}`;
      check(`${tag}: no horizontal overflow`, info.overflow <= 1, `overflow ${info.overflow}px`);
      check(`${tag}: all form controls labelled`, info.unlabeled.length === 0, info.unlabeled.join(' | '));
      if (lang === 'ar') {
        check(`${tag}: RTL and Arabic heading`, info.dir === 'rtl' && !info.latinOnlyHeading, `dir=${info.dir} h1=${info.h1}`);
      }
      if (vp.name === 'desktop' && lang === 'en') await page.screenshot({ path: `docs/screenshots/phase8-${path.replace(/[/:]+/g, '_').replace(/^_/, '')}.png`, fullPage: false });
    }
  }
  check(`${vp.name}: no page or console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}
await browser.close();
console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} checks passed (stubbed network; UI rendering only)`);
process.exit(failures ? 1 : 0);
