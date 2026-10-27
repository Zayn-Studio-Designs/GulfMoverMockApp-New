import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Helpers for the LOCAL Supabase integration suite (`npm run test:integration`).
 *
 * Everything here targets the local development stack only. Connection values come from
 * environment variables printed by `supabase status` on the developer's machine; nothing is
 * hard-coded and nothing is committed. The service key is used ONLY to create already-confirmed
 * throw-away test users quickly, and psql (as the local `postgres` owner) only for the
 * documented out-of-band role provisioning and for read-only assertions on audit rows.
 */

export const IT = {
  url: process.env.GM_IT_SUPABASE_URL ?? '',
  anonKey: process.env.GM_IT_ANON_KEY ?? '',
  serviceKey: process.env.GM_IT_SERVICE_KEY ?? '',
  dbUrl: process.env.GM_IT_DB_URL ?? '',
  mailUrl: process.env.GM_IT_MAILPIT_URL ?? '',
};

/** True only when every local-stack variable is present and points at a loopback host. */
export const localStackConfigured = (() => {
  if (!IT.url || !IT.anonKey || !IT.serviceKey || !IT.dbUrl || !IT.mailUrl) return false;
  const local = (u: string) => {
    try { return ['127.0.0.1', 'localhost'].includes(new URL(u.replace(/^postgres(ql)?:/, 'http:')).hostname); } catch { return false; }
  };
  return local(IT.url) && local(IT.dbUrl) && local(IT.mailUrl);
})();

export const RUN = randomUUID().slice(0, 8);
export const email = (label: string) => `gm-it-${RUN}-${label}@example.test`;
export const PASSWORD = 'it-Passw0rd-local';

export function anonClient(): SupabaseClient {
  return createClient(IT.url, IT.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

const serviceClient = () =>
  createClient(IT.url, IT.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

/** Runs SQL as the local owner role and returns trimmed unaligned output. */
export function sql(query: string): string {
  if (process.env.GM_IT_SQL_DRIVER === 'supabase') {
    // Native CLI stacks need no system-wide psql installation. Same local-only
    // owner SQL; normalise JSON rows to psql's unaligned output for assertions.
    if (!localStackConfigured) throw new Error('Local stack configuration required');
    const url = new URL(IT.dbUrl);
    url.searchParams.set('sslmode', 'disable'); // loopback native database only
    const output = execFileSync('supabase', ['db', 'query', '--db-url', url.href, query, '--output-format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!output || !output.startsWith('[')) return '';
    const rows = JSON.parse(output) as Array<Record<string, unknown>>;
    return rows.map(row => Object.values(row).map(v => v === null ? '' : v === true ? 't' : v === false ? 'f' : String(v)).join('|')).join('\n').trim();
  }
  return execFileSync('psql', [IT.dbUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim();
}

export const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

export interface TestUser { id: string; email: string; client: SupabaseClient }

/** Creates a confirmed throw-away user (service key, local only) and returns a signed-in client. */
export async function confirmedUser(label: string): Promise<TestUser> {
  const address = email(label);
  const { data, error } = await serviceClient().auth.admin.createUser({ email: address, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email: address, password: PASSWORD });
  if (signIn.error) throw new Error(`signIn failed: ${signIn.error.message}`);
  return { id: data.user.id, email: address, client };
}

/**
 * Documented out-of-band provisioning (supabase/scripts/provision_platform_role.sql): an
 * owner-session insert of the staff profile and the platform role. The app has no write path.
 */
export function grantPlatformRole(userId: string, role: 'super_admin' | 'operations' | 'finance' | 'boarding_staff') {
  sql(`insert into public.profiles (id, display_name, preferred_language, status)
         values (${quote(userId)}, 'IT ATCO staff', 'en', 'active') on conflict (id) do nothing`);
  sql(`insert into public.role_assignments (user_id, role) values (${quote(userId)}, ${quote(role)})`);
}

/** Staff role WITHOUT a profile: reproduces an incompletely provisioned account. */
export function grantRoleOnly(userId: string, role: 'super_admin') {
  sql(`insert into public.role_assignments (user_id, role) values (${quote(userId)}, ${quote(role)})`);
}

/* ------------------------------ Mailpit ------------------------------ */

interface MailSummary { ID: string; Subject: string; Created: string }

export async function latestMailTo(address: string, timeoutMs = 10_000): Promise<{ subject: string; text: string; html: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${IT.mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    if (res.ok) {
      const body = await res.json() as { messages?: MailSummary[] };
      const first = body.messages?.[0];
      if (first) {
        const msg = await (await fetch(`${IT.mailUrl}/api/v1/message/${first.ID}`)).json() as { Subject: string; Text: string; HTML: string };
        return { subject: msg.Subject, text: msg.Text ?? '', html: msg.HTML ?? '' };
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`no email for ${address}`);
}

/** The Supabase Auth verify link in an email body. */
export function verifyLink(mail: { text: string; html: string }): string {
  const match = (mail.text + mail.html).match(/https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify\?[^\s"'<>)]+/);
  if (!match) throw new Error('no verify link in email');
  return match[0].replace(/&amp;/g, '&');
}

/** Opens a verify link like a browser would (without following the final redirect). */
export async function openVerifyLink(link: string): Promise<URL> {
  const res = await fetch(link, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`verify link did not redirect (HTTP ${res.status})`);
  return new URL(location);
}

export function futureIso(hoursAhead: number): string {
  return new Date(Date.now() + hoursAhead * 3_600_000).toISOString();
}
