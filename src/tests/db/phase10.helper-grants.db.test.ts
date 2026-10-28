// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asUser, createSailingPair, createStaff, createUser,
  dbConfigured, fails, individualBooking, owner, payInSandbox, q,
} from './pg';

/**
 * Phase 10.1 — catalog + execution verification for the security-hardening
 * migration (`20261102000000_phase10_security_hardening.sql`).
 *
 * - The three internal helpers are not executable by `anon`/`authenticated`
 *   (PostgreSQL catalog truth, not source parsing).
 * - Legitimate server-side paths still work: a staff report exercising
 *   `_riyadh_date`, invoice issuance exercising `_zatca_initial_pih` (via
 *   `_last_document_hash`), and a sandbox-paid individual booking exercising
 *   the terms-guarded booking engine.
 *
 * Skipped without a local stack (`dbConfigured` false); see Task 2 notes.
 */
const d = dbConfigured ? describe : describe.skip;

d('Phase 10.1 internal-helper grants (local database)', () => {
  let ops: string;

  beforeAll(async () => {
    ops = await createStaff('p101-ops', 'operations');
  });

  it('the three helpers are invisible to client roles in the catalog', async () => {
    const fns = ['_reserve_booking_terms', '_riyadh_date', '_zatca_initial_pih'];
    for (const fn of fns) {
      const anonCan = await owner(
        `select bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p ` +
        `where p.pronamespace = 'public'::regnamespace and p.proname = ${q(fn)}`);
      const authCan = await owner(
        `select bool_or(has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p ` +
        `where p.pronamespace = 'public'::regnamespace and p.proname = ${q(fn)}`);
      expect(anonCan).toBe('f');
      expect(authCan).toBe('f');
    }
    expect((await fails(asAnon(`select public._riyadh_date(now())`))).message).toMatch(/permission denied/i);
  });

  it('server-side paths using the helpers still work', async () => {
    const user = await createUser('p101-user');
    const { out } = await createSailingPair();
    const booking = await individualBooking(user, out, 1);
    await payInSandbox(user, booking);
    // Report path (uses _riyadh_date internally, runs as owner via SECURITY DEFINER).
    const day = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date from public.sailings where id = ${q(out)}`);
    expect(Number(await asUser(ops, `select count(*) from public.report_sailing_occupancy(${q(day)}, ${q(day)})`))).toBeGreaterThanOrEqual(0);
    // Invoice chain (uses _zatca_initial_pih via _last_document_hash, owner context).
    expect(await owner(`select count(*) from public.invoices where booking_id = ${q(booking)}`)).toBe('1');
    expect(await owner(`select public._last_document_hash()`)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
