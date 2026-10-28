import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * SQL-level test harness for the LOCAL disposable database started by
 * `scripts/db/local-db.sh up` (supabase/postgres image, all migrations applied).
 *
 * Statements run through psql as the real application roles (`authenticated`,
 * `anon`, `service_role`) with Supabase-style JWT claims, so RLS policies, column
 * grants, SECURITY DEFINER functions and constraints are exercised for real.
 * Only loopback URLs are accepted; nothing here can reach a hosted project.
 */
export let DB_URL = process.env.GM_DB_URL ?? '';

/** Points the harness at another loopback database (e.g. the upgrade-path container). */
export function useDatabase(url: string): void {
  if (!['127.0.0.1', 'localhost'].includes(new URL(url.replace(/^postgres(ql)?:/, 'http:')).hostname)) throw new Error('loopback only');
  DB_URL = url;
}

export const dbConfigured = (() => {
  if (!DB_URL) return false;
  try { return ['127.0.0.1', 'localhost'].includes(new URL(DB_URL.replace(/^postgres(ql)?:/, 'http:')).hostname); } catch { return false; }
})();

export class SqlError extends Error {
  constructor(message: string, readonly sqlState: string | null) { super(message); }
}

function psql(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('psql', [DB_URL, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '-'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const line = stderr.split('\n').find(l => /ERROR:/.test(l)) ?? stderr.trim();
          const state = /ERROR:\s+([0-9A-Z]{5}):/.exec(line)?.[1] ?? null;
          reject(new SqlError(line.replace(/^.*ERROR:\s+([0-9A-Z]{5}:\s+)?/, ''), state));
          return;
        }
        resolve(stdout.trim());
      });
    child.stdin?.end(`\\set VERBOSITY verbose\n${script}\n`);
  });
}

export const q = (v: string | null | undefined) => (v == null ? 'null' : `'${v.replace(/'/g, "''")}'`);

/** Runs SQL as the database owner (setup and read-only assertions only). */
export const owner = (sql: string) => psql(sql);

/** Runs SQL inside one transaction as `authenticated` with the given user's JWT claims. */
export function asUser(userId: string, sql: string, claims: Record<string, unknown> = {}): Promise<string> {
  const jwt = JSON.stringify({ sub: userId, role: 'authenticated', aal: 'aal1', ...claims });
  return psql(`begin;\nset local request.jwt.claims = ${q(jwt)};\nset local role authenticated;\n${sql};\ncommit;`);
}

/** Runs SQL as the `service_role` (the payments edge function's privilege). */
export function asService(sql: string): Promise<string> {
  return psql(`begin;\nset local request.jwt.claims = '{"role":"service_role"}';\nset local role service_role;\n${sql};\ncommit;`);
}

/** Runs SQL as `anon` (signed-out visitor). */
export function asAnon(sql: string): Promise<string> {
  return psql(`begin;\nset local request.jwt.claims = '{"role":"anon"}';\nset local role anon;\n${sql};\ncommit;`);
}

/** Expects the promise to fail; returns the error for assertions. */
export async function fails(p: Promise<unknown>): Promise<SqlError> {
  try { await p; } catch (e) { if (e instanceof SqlError) return e; throw e; }
  throw new Error('expected SQL to fail but it succeeded');
}

export const RUN = randomUUID().slice(0, 8);

export async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner(`insert into auth.users (id, email, email_confirmed_at, aud, role, created_at, updated_at)
    values (${q(id)}, ${q(`gm-db-${RUN}-${label}-${id.slice(0, 6)}@example.test`)}, now(), 'authenticated', 'authenticated', now(), now());
    insert into public.profiles (id, display_name, preferred_language, status) values (${q(id)}, ${q(`Test ${label}`)}, 'en', 'active');`);
  return id;
}

export type StaffRole = 'super_admin' | 'operations' | 'finance' | 'boarding_staff' | 'it_support';
export async function createStaff(label: string, role: StaffRole): Promise<string> {
  const id = await createUser(label);
  await owner(`insert into public.role_assignments (user_id, role) values (${q(id)}, ${q(role)})`);
  return id;
}

export async function createOrg(label: string, accountType: 'corporate' | 'agent', adminId: string, bookerIds: string[] = []): Promise<string> {
  const id = randomUUID();
  await owner(`insert into public.organizations (id, legal_name, display_name, status, account_type, contact_email, created_by)
      values (${q(id)}, ${q(`Fictional ${label} LLC`)}, ${q(label)}, 'approved', ${q(accountType)}, ${q(`${label}@example.test`)}, ${q(adminId)});
    insert into public.organization_memberships (organization_id, user_id, membership_role, status) values (${q(id)}, ${q(adminId)}, 'company_admin', 'active');
    ${bookerIds.map(b => `insert into public.organization_memberships (organization_id, user_id, membership_role, status) values (${q(id)}, ${q(b)}, 'company_booker', 'active');`).join('\n')}`);
  return id;
}

/** A fresh open sailing pair on the seeded route, far in the future and isolated per test. */
export async function createSailingPair(capacity = 12, hoursAhead = 24 * 30): Promise<{ out: string; back: string }> {
  const vessel = randomUUID();
  await owner(`insert into public.vessels (id, name, passenger_capacity, status) values (${q(vessel)}, ${q(`IT vessel ${vessel.slice(0, 8)}`)}, ${capacity}, 'active')`);
  const out = await owner(`insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
    select id, ${q(vessel)}, now() + interval '${hoursAhead} hours' + (random() * interval '30 days'), ${capacity}, 'open'
      from public.routes where origin = 'Ras Tanura Service Pier' limit 1 returning id`);
  const back = await owner(`insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
    select r.id, ${q(vessel)}, s.departs_at + interval '6 hours', ${capacity}, 'open'
      from public.routes r, public.sailings s where r.origin <> 'Ras Tanura Service Pier' and s.id = ${q(out)} limit 1 returning id`);
  return { out, back };
}

export async function currentTerms(): Promise<string> {
  return owner(`select version from public.service_policies where policy_type = 'booking_terms'
    order by (status = 'approved') desc, effective_from desc limit 1`);
}

/** Books as an individual; returns booking id. */
export async function individualBooking(userId: string, outbound: string, pax: number, ret: string | null = null, key = randomUUID()): Promise<string> {
  const terms = await currentTerms();
  const row = await asUser(userId, `select booking_id from public.create_individual_booking(${q(key)}, ${q(outbound)}, ${pax},
    'Test Traveller', 'traveller@example.test', '+966500000000', null, ${q(ret)}, null, null, ${q(terms)})`);
  return row;
}

export async function payInSandbox(userId: string, bookingId: string): Promise<string> {
  const pay = await asUser(userId, `select payment_id from public.begin_checkout(${q(bookingId)}, 'mada', ${q(randomUUID())})`);
  await asUser(userId, `select public.sandbox_simulate_payment(${q(pay)}, 'paid')`);
  return pay;
}

/** Opens every boarding checkpoint for a sailing as operations staff. */
export async function clearSailing(opsId: string, sailingId: string): Promise<void> {
  await asUser(opsId, `select public.set_sailing_readiness(${q(sailingId)}, 'ready', 'IT ready');
    select public.record_master_decision(${q(sailingId)}, 'go', 'Capt. Fictional', 'IT go');
    select public.record_port_clearance(${q(sailingId)}, 'cleared', 'IT-PERMIT-1', 'IT cleared')`);
}
