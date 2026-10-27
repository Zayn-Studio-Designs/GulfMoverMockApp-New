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
const sql = q => {
  if (process.env.GM_IT_SQL_DRIVER === 'supabase') {
    const url = new URL(DB); url.searchParams.set('sslmode', 'disable');
    const output = execFileSync('supabase', ['db', 'query', '--db-url', url.href, q, '--output-format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!output.startsWith('[')) return '';
    return JSON.parse(output).map(row => Object.values(row).map(v => v === null ? '' : String(v)).join('|')).join('\n').trim();
  }
  return execFileSync('psql', [DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
};
const quote = v => `'${String(v).replace(/'/g, "''")}'`;
const capture = process.env.GM_E2E_CAPTURE_SCREENSHOTS === '1';
if (capture) mkdirSync(SHOTS, { recursive: true });
const screenshot = (page, name) => capture ? page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true }) : Promise.resolve();

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
  await screenshot(customer, 'customer-pending-desktop.png');

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
  await screenshot(admin, 'admin-review-desktop.png');
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
  await customer.getByText('E2E Lead Passenger', { exact: true }).waitFor();
  check('customer: reopened booking shows saved record and separate statuses',
    (await customer.getByText('Not connected yet', { exact: true }).count()) === 1);
  await customer.reload();
  await customer.getByRole('heading', { name: /Booking reference/ }).waitFor();
  check('customer: booking still there after a full page reload', await customer.getByText(reference).isVisible());
  await screenshot(customer, 'customer-booking-desktop.png');

  /* ---------------- Phase 4: tickets, QR, readiness and boarding ---------------- */
  await customer.getByRole('heading', { name: 'Reservation tickets' }).waitFor();
  const ticketCount = sql(`select count(*) from public.tickets t join public.bookings b on b.id=t.booking_id where b.reference=${quote(reference)}`);
  check('tickets: two passengers on each separate leg persist exactly four tickets', ticketCount === '4');
  await customer.getByRole('button', { name: 'Show private QR' }).first().click();
  await customer.getByRole('img', { name: 'Ticket verification QR' }).waitFor();
  check('tickets: owner retrieves opaque QR and sees no-payment disclaimer', await customer.getByText(/No real payment made/).isVisible());
  const ticketRef = sql(`select t.reference from public.tickets t join public.bookings b on b.id=t.booking_id join public.booking_legs l on l.id=t.booking_leg_id where b.reference=${quote(reference)} and l.leg='outbound' order by t.passenger_index limit 1`);
  const sailingId = sql(`select l.sailing_id from public.booking_legs l join public.bookings b on b.id=l.booking_id where b.reference=${quote(reference)} and l.leg='outbound'`);
  await admin.goto(`${APP}/admin/boarding`);
  await admin.getByRole('heading', { name: 'Boarding & readiness' }).waitFor();
  await admin.getByLabel('Selected sailing').selectOption(sailingId);
  await admin.getByLabel('Ticket reference or QR payload').fill(ticketRef);
  await admin.getByRole('button', { name: 'Validate and record boarding', exact: true }).click();
  check('boarding: server refuses pending internal readiness', await visible(admin.getByText('Internal readiness has not been recorded as ready. Boarding refused.')));
  await admin.getByLabel('Readiness decision').selectOption('ready');
  await admin.locator('#p4-reason').fill('Fictional internal readiness exercise, not a legal clearance');
  await admin.getByRole('button', { name: 'Save internal decision' }).click();
  await admin.getByText('Internal readiness decision recorded.', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Validate and record boarding', exact: true }).click();
  check('boarding: manual reference records server-confirmed boarding', await visible(admin.getByText('Boarding recorded successfully.', { exact: true })));
  await admin.getByRole('button', { name: 'Validate and record boarding', exact: true }).click();
  check('boarding: duplicate rejected without second audit event', await visible(admin.getByText('Already boarded. No duplicate boarding recorded.')) && sql(`select count(*) from public.boarding_events e join public.tickets t on t.id=e.ticket_id where t.reference=${quote(ticketRef)}`) === '1');
  await customer.reload();
  check('tickets: owner sees persisted boarded status after reload', await visible(customer.getByText('Boarded', { exact: true })));
  await admin.goto(`${APP}/admin/operations`);
  await admin.getByRole('heading', { name: 'Vessels and sailings' }).waitFor();

  /* ---------------- admin: reservations on the departure ---------------- */
  await admin.reload();
  await admin.getByRole('tab', { name: 'Sailing schedule' }).click();
  const row = admin.locator('.request-row').filter({ hasText: `E2E Pier ${RUN} → E2E Anchorage ${RUN}` }).first();
  check('admin: schedule shows 2 of 6 seats reserved', await row.getByText(/2 of 6 seats reserved/).isVisible());
  await row.getByRole('button', { name: 'View reservations' }).click();
  await admin.getByRole('heading', { name: 'Reservations on this departure' }).waitFor();
  check('admin: manifest lists the customer booking', await visible(admin.getByRole('cell', { name: reference })));

  /* ---------------- Phase 5: invitations, requests and notifications ---------------- */
  const inviteeEmail=`e2e-${RUN}-invitee@example.test`;
  const invitee=await newPage({width:390,height:844});
  await signUpAndConfirm(invitee,inviteeEmail); await signIn(invitee,inviteeEmail);
  await customer.goto(`${APP}/company/members`);
  await customer.getByLabel('Email',{exact:true}).fill(inviteeEmail);
  await customer.getByRole('button',{name:'Create invitation',exact:true}).click();
  check('members: invitation saved with honest no-email feedback',await visible(customer.getByText('Invitation saved in the database. No email sent.')));
  await invitee.goto(`${APP}/company/members`);
  await invitee.getByRole('button',{name:'Accept invitation',exact:true}).click();
  await invitee.getByText('Change recorded.',{exact:true}).waitFor();
  check('members: authenticated recipient accepts as company booker',sql(`select count(*) from public.organization_memberships m join auth.users u on u.id=m.user_id where u.email=${quote(inviteeEmail)} and m.organization_id=${quote(orgId)} and m.membership_role='company_booker' and m.status='active'`)==='1');
  await customer.reload();
  await customer.getByRole('button',{name:'Revoke membership',exact:true}).click();
  await customer.getByText('Change recorded.',{exact:true}).waitFor();
  await invitee.goto(`${APP}/materials`);
  check('members: revoked recipient cannot submit requests',await invitee.getByRole('button',{name:'Submit request for review'}).count()===0);
  for(const [path,title] of [['materials','Materials-transfer requests'],['charters','Charter requests']]){
    await customer.goto(`${APP}/${path}`);
    await customer.getByRole('heading',{name:title,exact:true}).waitFor();
    await customer.getByLabel('Request description *').fill(`Fictional ${path} ${RUN}`);
    await customer.getByLabel('Destination (requested)').fill('Demo destination pending ATCO');
    await customer.getByRole('button',{name:'Submit request for review'}).click();
    await customer.getByText('Change recorded.',{exact:true}).waitFor();
    const ref=sql(`select reference from public.transfer_requests where organization_id=${quote(orgId)} and details->>'description'=${quote(`Fictional ${path} ${RUN}`)}`);
    check(`${path}: request persists with server reference`,/^RQ-/.test(ref));
    await customer.reload();await customer.getByRole('button').filter({hasText:ref}).click();
    check(`${path}: saved details survive reload`,await visible(customer.getByText(`Fictional ${path} ${RUN}`,{exact:false})));
    await admin.goto(`${APP}/admin/${path}`);
    await admin.getByRole('button').filter({hasText:ref}).click();
    await admin.getByLabel('Review decision').selectOption('reviewed_for_planning');
    await admin.locator('#request-reason').fill('Fictional internal planning, not confirmation');
    await admin.getByRole('button',{name:'Record review',exact:true}).click();
    await admin.getByText('Change recorded.',{exact:true}).waitFor();
    await customer.reload();
    check(`${path}: customer sees planning-only decision`,await visible(customer.getByRole('button').filter({hasText:ref}).filter({hasText:'Reviewed for planning — not confirmed'})));
  }
  await customer.goto(`${APP}/notifications`);
  await customer.getByRole('heading',{name:'Notifications',exact:true}).waitFor();
  check('notifications: real booking/ticket events visible',await visible(customer.getByRole('link',{name:'Reservation created',exact:true}))&&await visible(customer.getByRole('link',{name:'Reservation tickets issued — not a payment confirmation',exact:true})));
  await customer.getByRole('button',{name:'Mark read',exact:true}).first().click();
  check('notifications: read state persists after reload',sql(`select count(*) from public.notifications n join auth.users u on u.id=n.user_id where u.email=${quote(customerEmail)} and n.read_at is not null`)!=='0');
  await admin.goto(`${APP}/admin/boarding`);await admin.getByLabel('Selected sailing').selectOption(sailingId);
  await admin.evaluate(()=>{Object.defineProperty(window,'BarcodeDetector',{value:undefined,configurable:true});});
  await admin.getByRole('button',{name:'Start QR camera',exact:true}).click();
  check('camera: unsupported browser provides manual fallback',await visible(admin.getByText('Camera QR decoding unavailable in this browser. Use manual entry.'))&&await admin.getByLabel('Ticket reference or QR payload').isEnabled());
  // Browser-level permission failure test; no simulated success is counted as physical camera verification.
  await admin.reload();await admin.getByLabel('Selected sailing').selectOption(sailingId);
  await admin.evaluate(()=>{window.BarcodeDetector=class{async detect(){return [];}};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{throw new DOMException('Denied','NotAllowedError');}},configurable:true});});
  await admin.getByRole('button',{name:'Start QR camera',exact:true}).click();
  check('camera: denied permission leaves manual validation available',await visible(admin.getByText('Camera permission denied. Use manual entry.'))&&await admin.getByLabel('Ticket reference or QR payload').isEnabled());

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
  await screenshot(mobile, 'customer-bookings-ar-mobile.png');
  await mobile.getByRole('link', { name: 'فتح الحجز' }).first().click();
  check('mobile Arabic: reservation tickets render without horizontal overflow', await visible(mobile.getByRole('heading', { name: 'تذاكر الحجز' })) && await noOverflow(mobile));

  const adminMobile = await newPage({ width: 390, height: 844 });
  await signIn(adminMobile, adminEmail);
  await adminMobile.goto(`${APP}/admin/companies`);
  await adminMobile.getByRole('heading', { name: 'Company review' }).waitFor();
  check('mobile: admin review screen has no horizontal overflow', await noOverflow(adminMobile));
  await adminMobile.goto(`${APP}/admin/operations`);
  await adminMobile.getByRole('heading', { name: 'Vessels and sailings' }).waitFor();
  check('mobile: admin operations screen has no horizontal overflow', await noOverflow(adminMobile));
  await screenshot(adminMobile, 'admin-operations-mobile.png');
  await adminMobile.goto(`${APP}/admin/boarding`);
  await adminMobile.getByLabel('Selected sailing').selectOption(sailingId);
  await adminMobile.getByRole('button', { name: 'Account menu' }).click();
  await adminMobile.getByRole('button', { name: 'العربية' }).click();
  await adminMobile.keyboard.press('Escape');
  check('mobile Arabic: boarding/readiness actions and manifest fit without overflow', await visible(adminMobile.getByRole('heading', { name: 'الصعود والجاهزية' })) && await noOverflow(adminMobile));

  for(const [path,title] of [['materials','طلبات نقل المواد'],['charters','طلبات الرحلات الخاصة'],['company/members','أعضاء الشركة'],['notifications','الإشعارات']]){
    await mobile.goto(`${APP}/${path}`);
    await mobile.getByRole('button',{name:'Account menu'}).click();await mobile.getByRole('button',{name:'العربية'}).click();await mobile.keyboard.press('Escape');
    await mobile.getByRole('heading',{name:title,exact:true}).first().waitFor();
    check(`mobile Arabic: ${path} RTL and no horizontal overflow`,(await mobile.evaluate(()=>document.documentElement.dir))==='rtl'&&await noOverflow(mobile));
  }
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  check('journey completed without an unexpected failure', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
