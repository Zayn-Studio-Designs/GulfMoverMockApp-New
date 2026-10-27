// Browser journeys against the LOCAL Supabase stack (Chromium via Playwright).
//
//   Prerequisites (see docs/backend/phase3-approval-bookings.md, "Local testing"):
//   1. `supabase start` (local only) and the GM_IT_* variables from `supabase status`.
//   2. The app running in production mode against that stack, e.g. on http://localhost:4317 with
//      VITE_AUTH_RESET_REDIRECT_URL=http://localhost:4317/auth/reset-callback.
//   Run: GM_E2E_APP_URL=http://localhost:4317 npm run test:e2e:local
//
// Nothing here talks to a remote project: every URL must be a loopback address.
// The ATCO administrator is provisioned with the documented out-of-band SQL (psql as the
// local owner) — the app itself has no way to grant that role.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const APP = process.env.GM_E2E_APP_URL ?? 'http://localhost:4317';
const DB = process.env.GM_IT_DB_URL ?? '';
const MAIL = process.env.GM_IT_MAILPIT_URL ?? '';
const SHOTS = process.env.GM_E2E_SCREENSHOTS ?? 'docs/screenshots/phase3';
const loopback = u => { try { return ['127.0.0.1', 'localhost'].includes(new URL(u.replace(/^postgres(ql)?:/, 'http:')).hostname); } catch { return false; } };
if (![APP, DB, MAIL].every(loopback)) { console.error('Refusing to run: every URL must be a local loopback address.'); process.exit(2); }

const RUN = randomUUID().slice(0, 6);
const PASSWORD = 'e2e-Passw0rd-local';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sql = q => execFileSync('psql', [DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const quote = v => `'${String(v).replace(/'/g, "''")}'`;
mkdirSync(SHOTS, { recursive: true });

async function mailLink(address) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const first = (await res.json()).messages?.[0];
    if (first) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${first.ID}`)).json();
      const m = `${msg.Text}${msg.HTML}`.match(/https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify\?[^\s"'<>)]+/);
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`no email for ${address}`);
}

async function signUpAndConfirm(page, address) {
  await page.goto(`${APP}/signup`);
  await page.getByLabel('Email', { exact: true }).fill(address);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Check your email').waitFor();
  // The emailed link is opened over HTTP (it redirects to the dashboard site URL, not this app).
  const res = await fetch(await mailLink(address), { redirect: 'manual' });
  return res.status >= 300 && res.status < 400;
}

async function signIn(page, address, password = PASSWORD) {
  await page.goto(`${APP}/signin`);
  await page.getByLabel('Email', { exact: true }).fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Company registration' }).waitFor();
}

async function signOut(page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
}

/** Waits (up to 10 s) for an element instead of sampling it once while the page may still be loading. */
const visible = async locator => { try { await locator.waitFor({ timeout: 10_000 }); return true; } catch { return false; } };
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const browser = await chromium.launch(process.env.GM_E2E_CHROMIUM ? { executablePath: process.env.GM_E2E_CHROMIUM } : {});
const pageErrors = [];
const newPage = async viewport => {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(e.message));
  return page;
};

try {
  const customerEmail = `e2e-${RUN}-customer@example.test`;
  const adminEmail = `e2e-${RUN}-admin@example.test`;
  const company = `E2E Marine Services ${RUN}`;

  /* ---------------- customer: register, confirm, sign in, register company ---------------- */
  const customer = await newPage({ width: 1366, height: 900 });
  check('customer: sign-up asks to confirm e-mail, confirmation link works', await signUpAndConfirm(customer, customerEmail));
  await signIn(customer, customerEmail);
  await customer.getByLabel('Company legal name *').fill(company);
  await customer.getByLabel('Your full name *').fill('E2E Customer');
  await customer.getByLabel('Company contact email (optional)').fill(`ops-${RUN}@example.test`);
  await customer.getByRole('button', { name: 'Submit company registration' }).click();
  await customer.getByRole('heading', { name: 'Awaiting ATCO approval' }).waitFor();
  check('customer: registration submitted and shown as pending (not approved)', await customer.getByText('Pending ATCO review', { exact: true }).isVisible());
  await customer.goto(`${APP}/book`);
  check('customer: booking refused while pending', await visible(customer.getByRole('heading', { name: 'Booking needs an approved company' })));
  await customer.goto(`${APP}/admin/companies`);
  check('customer: ATCO review screen refused', await visible(customer.getByRole('heading', { name: 'ATCO staff access required' })));
  await customer.screenshot({ path: `${SHOTS}/customer-pending-desktop.png`, fullPage: true });

  /* ---------------- ATCO admin: provisioned out-of-band, reviews and schedules ---------------- */
  const admin = await newPage({ width: 1366, height: 900 });
  await signUpAndConfirm(admin, adminEmail);
  const adminId = sql(`select id from auth.users where email = ${quote(adminEmail)}`);
  sql(`insert into public.profiles (id, display_name, preferred_language, status) values (${quote(adminId)}, 'E2E ATCO admin', 'en', 'active')`);
  sql(`insert into public.role_assignments (user_id, role) values (${quote(adminId)}, 'super_admin')`);
  await signIn(admin, adminEmail);
  await admin.getByRole('link', { name: /Company review/ }).first().click();
  await admin.getByLabel('Search by legal name').fill(company);
  await admin.getByRole('button', { name: 'Search companies' }).click();
  await admin.getByRole('button', { name: 'Open record' }).first().click();
  await admin.getByText('Registration submitted').waitFor();
  await admin.screenshot({ path: `${SHOTS}/admin-review-desktop.png`, fullPage: true });
  await admin.getByRole('button', { name: 'Approve company' }).click();
  await admin.getByText('Company approved. The decision is recorded in the audit history.').waitFor();
  const orgId = sql(`select id from public.organizations where legal_name = ${quote(company)}`);
  check('admin: approval stored with the reviewer as actor',
    sql(`select status || ':' || (approved_by = ${quote(adminId)}) from public.organizations where id = ${quote(orgId)}`) === 'approved:true');
  check('admin: exactly submitted + approved audit events',
    sql(`select string_agg(decision, ',' order by occurred_at) from public.approval_events where subject_id = ${quote(orgId)}`) === 'submitted,approved');

  // Vessel, two routes, outbound + return sailings (tomorrow, Saudi time).
  await admin.getByRole('link', { name: /Vessels and sailings/ }).first().click();
  await admin.getByRole('tab', { name: 'Vessel register' }).click();
  await admin.getByLabel('Vessel name *').fill(`E2E Vessel ${RUN}`);
  await admin.getByLabel('Passenger capacity (optional)').fill('12');
  await admin.getByRole('button', { name: 'Save record' }).click();
  await admin.getByText('Saved.').waitFor();
  await admin.getByRole('tab', { name: 'Route list' }).click();
  for (const [from, to] of [[`E2E Pier ${RUN}`, `E2E Anchorage ${RUN}`], [`E2E Anchorage ${RUN}`, `E2E Pier ${RUN}`]]) {
    await admin.getByLabel('Departure point *').fill(from);
    await admin.getByLabel('Arrival point *').fill(to);
    await admin.getByRole('button', { name: 'Save record' }).click();
    await admin.getByText('Saved.').waitFor();
  }
  const tomorrow = new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10);
  await admin.getByRole('tab', { name: 'Sailing schedule' }).click();
  for (const [routeLabel, time] of [[`E2E Pier ${RUN} → E2E Anchorage ${RUN}`, '07:00'], [`E2E Anchorage ${RUN} → E2E Pier ${RUN}`, '13:00']]) {
    await admin.getByLabel('Route (from → to) *').selectOption({ label: routeLabel });
    await admin.getByLabel('Assigned vessel *').selectOption({ label: `E2E Vessel ${RUN}` });
    await admin.getByLabel('Departure date (Saudi time) *').fill(tomorrow);
    await admin.getByLabel('Departure time (Saudi time) *').fill(time);
    await admin.getByLabel('Seats offered *').fill('6');
    await admin.getByRole('button', { name: 'Save record' }).click();
    await admin.getByText('Saved.').waitFor();
  }
  check('admin: two sailings persisted with the entered capacity',
    sql(`select count(*) from public.sailings s join public.vessels v on v.id = s.vessel_id where v.name = ${quote(`E2E Vessel ${RUN}`)} and s.seat_capacity = 6`) === '2');
  check('admin: 07:00 Saudi time stored as 04:00 UTC',
    sql(`select to_char(min(departs_at) at time zone 'UTC', 'HH24:MI') from public.sailings s join public.vessels v on v.id = s.vessel_id where v.name = ${quote(`E2E Vessel ${RUN}`)}`) === '04:00');

  /* ---------------- customer: approved after re-sign-in, books outbound + return ---------------- */
  await signOut(customer);
  await signIn(customer, customerEmail);
  check('customer: approved status after signing in again', await visible(customer.getByRole('heading', { name: 'Company approved by ATCO' })));
  await customer.getByRole('link', { name: 'Book a sailing' }).first().click();
  await customer.getByLabel('Route (from → to) *').selectOption({ label: `E2E Pier ${RUN} → E2E Anchorage ${RUN}` });
  await customer.getByRole('radiogroup', { name: 'Outbound sailing' }).locator('label').first().click();
  await customer.getByLabel('Add a return sailing on the reverse route').check();
  await customer.getByRole('radiogroup', { name: 'Return sailing' }).locator('label').first().click();
  await customer.getByLabel('Number of passengers *').fill('2');
  await customer.getByLabel('Lead passenger full name *').fill('E2E Lead Passenger');
  await customer.getByLabel('Contact phone number *').fill('+966 13 000 0000');
  await customer.getByRole('button', { name: 'Reserve seats' }).click();
  await customer.getByRole('heading', { name: 'Seats reserved' }).waitFor();
  const reference = (await customer.locator('.mono').filter({ hasText: /^GM-[0-9A-F]{8}$/ }).first().textContent())?.trim();
  check('customer: server reference shown', /^GM-[0-9A-F]{8}$/.test(reference ?? ''), reference);
  check('customer: no price or payment success shown', !(await customer.locator('body').textContent()).match(/SAR\s?\d|Payment recorded/));
  check('db: booking persisted with two legs and seats held',
    sql(`select b.passenger_count || ':' || count(l.*) from public.bookings b join public.booking_legs l on l.booking_id = b.id where b.reference = ${quote(reference)} group by b.passenger_count`) === '2:2');
  await customer.getByRole('link', { name: 'View booking details' }).click();
  await customer.getByRole('heading', { name: /Booking reference/ }).waitFor();
  await customer.getByText('E2E Lead Passenger').waitFor();
  check('customer: reopened booking shows saved record and separate statuses',
    (await customer.getByText('Not connected yet', { exact: true }).count()) === 3);
  await customer.reload();
  await customer.getByRole('heading', { name: /Booking reference/ }).waitFor();
  check('customer: booking still there after a full page reload', await customer.getByText(reference).isVisible());
  await customer.screenshot({ path: `${SHOTS}/customer-booking-desktop.png`, fullPage: true });

  /* ---------------- admin: reservations on the departure ---------------- */
  await admin.reload();
  await admin.getByRole('tab', { name: 'Sailing schedule' }).click();
  const row = admin.locator('.request-row').filter({ hasText: `E2E Pier ${RUN} → E2E Anchorage ${RUN}` }).first();
  check('admin: schedule shows 2 of 6 seats reserved', await row.getByText(/2 of 6 seats reserved/).isVisible());
  await row.getByRole('button', { name: 'View reservations' }).click();
  await admin.getByRole('heading', { name: 'Reservations on this departure' }).waitFor();
  check('admin: manifest lists the customer booking', await admin.getByRole('cell', { name: reference }).isVisible());

  /* ---------------- rejection journey ---------------- */
  const rejectedEmail = `e2e-${RUN}-rejected@example.test`;
  const rejected = await newPage({ width: 1366, height: 900 });
  await signUpAndConfirm(rejected, rejectedEmail);
  await signIn(rejected, rejectedEmail);
  await rejected.getByLabel('Company legal name *').fill(`E2E Rejected Co ${RUN}`);
  await rejected.getByLabel('Your full name *').fill('E2E Rejected');
  await rejected.getByRole('button', { name: 'Submit company registration' }).click();
  await rejected.getByRole('heading', { name: 'Awaiting ATCO approval' }).waitFor();
  await admin.goto(`${APP}/admin/companies`);
  await admin.getByLabel('Search by legal name').fill(`E2E Rejected Co ${RUN}`);
  await admin.getByRole('button', { name: 'Search companies' }).click();
  await admin.getByRole('button', { name: 'Open record' }).first().click();
  await admin.getByRole('button', { name: 'Reject company' }).click();
  check('admin: rejection without a reason is blocked', await admin.getByText('Enter a reason before rejecting.').isVisible());
  await admin.getByLabel('Reason for rejection (required to reject)').fill('E2E documents incomplete');
  await admin.getByRole('button', { name: 'Reject company' }).click();
  await admin.getByText(/Company rejected\./).waitFor();
  await rejected.reload();
  await rejected.getByRole('heading', { name: 'Registration not approved by ATCO' }).waitFor();
  check('rejected member sees the rejected state but not the internal reason', !(await rejected.locator('body').textContent()).includes('E2E documents incomplete'));

  /* ---------------- password recovery in the browser ---------------- */
  await signOut(customer);
  await customer.getByRole('button', { name: 'Forgot password?' }).click();
  await customer.getByLabel('Email', { exact: true }).fill(customerEmail);
  await customer.getByRole('button', { name: 'Send reset link' }).click();
  await customer.getByText('Reset email sent').waitFor();
  await new Promise(r => setTimeout(r, 1500));
  const resetLink = await (async () => {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${customerEmail}" subject:"Reset"`)}`);
    const first = (await res.json()).messages?.[0];
    const msg = await (await fetch(`${MAIL}/api/v1/message/${first.ID}`)).json();
    return `${msg.Text}${msg.HTML}`.match(/https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify\?[^\s"'<>)]+/)[0].replace(/&amp;/g, '&');
  })();
  await customer.goto(resetLink);
  await customer.getByRole('heading', { name: 'Set a new password' }).waitFor();
  await customer.getByLabel('New password').fill('e2e-NewPassw0rd-2');
  await customer.getByLabel('Confirm password').fill('e2e-NewPassw0rd-2');
  await customer.getByRole('button', { name: 'Save new password' }).click();
  await customer.getByText('Password changed').waitFor();
  check('recovery: e-mailed link opens the new-password screen and the change is confirmed', true);
  await customer.getByRole('button', { name: 'Continue to Gulf Mover' }).click();
  await signOut(customer);
  await signIn(customer, customerEmail, 'e2e-NewPassw0rd-2');
  check('recovery: sign-in works with the new password', true);
  await customer.goto(resetLink);
  await customer.waitForTimeout(1500);
  check('recovery: re-using the link does not show the password form',
    (await customer.getByLabel('New password').count()) === 0);

  /* ---------------- mobile + Arabic ---------------- */
  const mobile = await newPage({ width: 390, height: 844 });
  await signIn(mobile, customerEmail, 'e2e-NewPassw0rd-2');
  await mobile.goto(`${APP}/bookings`);
  await mobile.getByText(reference).waitFor();
  await mobile.getByRole('button', { name: 'Account menu' }).click();
  await mobile.getByRole('button', { name: 'العربية' }).click();
  await mobile.keyboard.press('Escape');
  await mobile.getByRole('heading', { name: 'حجوزاتي' }).waitFor();
  check('mobile Arabic: My bookings in RTL with Arabic headings', (await mobile.evaluate(() => document.documentElement.dir)) === 'rtl');
  check('mobile Arabic: the booking is listed', await mobile.getByText(reference).isVisible());
  check('mobile Arabic: no horizontal overflow', await noOverflow(mobile));
  await mobile.screenshot({ path: `${SHOTS}/customer-bookings-ar-mobile.png`, fullPage: true });

  const adminMobile = await newPage({ width: 390, height: 844 });
  await signIn(adminMobile, adminEmail);
  await adminMobile.goto(`${APP}/admin/companies`);
  await adminMobile.getByRole('heading', { name: 'Company review' }).waitFor();
  check('mobile: admin review screen has no horizontal overflow', await noOverflow(adminMobile));
  await adminMobile.goto(`${APP}/admin/operations`);
  await adminMobile.getByRole('heading', { name: 'Vessels and sailings' }).waitFor();
  check('mobile: admin operations screen has no horizontal overflow', await noOverflow(adminMobile));
  await adminMobile.screenshot({ path: `${SHOTS}/admin-operations-mobile.png`, fullPage: true });

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  check('journey completed without an unexpected failure', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
