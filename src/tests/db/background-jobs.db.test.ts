// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createSailingPair, createUser, dbConfigured, individualBooking, owner, q } from './pg';

/**
 * Production-readiness audit — areas 2 & 4 (alerts, background jobs), real PostgreSQL + pg_cron.
 *
 * - The hold-expiry job is scheduled in the database and actually runs: an expired
 *   unpaid hold is released by pg_cron without anyone calling the function.
 * - The job is idempotent: concurrent/overlapping runs never release seats twice.
 * - system_diagnostics() raises an alert when holds are not being released.
 * Skipped without a local database.
 */
const d = dbConfigured ? describe : describe.skip;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

d('scheduled jobs and health alerts (local database)', () => {
  let cron = false;
  beforeAll(async () => { cron = (await owner(`select to_regclass('cron.job') is not null`)) === 't'; });

  it('the hold-expiry job is registered to run every minute', async () => {
    if (!cron) return;
    expect(await owner(`select schedule||'|'||active||'|'||command from cron.job where jobname = 'gm-expire-stale-holds'`))
      .toBe('* * * * *|true|select public.expire_stale_holds()');
  });

  it('pg_cron really releases an expired unpaid hold, with no manual call', async () => {
    if (!cron) return;
    const { out } = await createSailingPair(12, 24 * 70);
    const user = await createUser('cron-hold');
    const booking = await individualBooking(user, out, 3);
    expect(await owner(`select seats_booked from public.sailings where id = ${q(out)}`)).toBe('3');
    await owner(`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = ${q(booking)}`);
    let status = '';
    for (let i = 0; i < 45 && status !== 'expired'; i++) { await sleep(2000); status = await owner(`select status from public.bookings where id = ${q(booking)}`); }
    expect(status).toBe('expired');
    expect(await owner(`select seats_booked from public.sailings where id = ${q(out)}`)).toBe('0');
    expect(await owner(`select count(*) from public.tickets where booking_id = ${q(booking)} and status = 'valid'`)).toBe('0');
    expect(await owner(`select status from cron.job_run_details d join cron.job j using (jobid)
      where j.jobname = 'gm-expire-stale-holds' order by d.start_time desc limit 1`)).toBe('succeeded');
  }, 120000);

  it('overlapping runs are idempotent: seats are released exactly once', async () => {
    const { out } = await createSailingPair(12, 24 * 71);
    const user = await createUser('idem-hold');
    const bookings = await Promise.all([1, 2, 3].map(() => individualBooking(user, out, 2)));
    await owner(`update public.bookings set hold_expires_at = now() - interval '1 minute' where id in (${bookings.map(q).join(',')})`);
    await Promise.all(Array.from({ length: 5 }, () => asService(`select public.expire_stale_holds()`)));
    expect(await owner(`select seats_booked from public.sailings where id = ${q(out)}`)).toBe('0');
    expect(await owner(`select count(*) from public.booking_events where action = 'expired' and booking_id in (${bookings.map(q).join(',')})`)).toBe('3');
  }, 60000);

  it('diagnostics raise an alert when expired holds are not being released, and expose no personal data', async () => {
    const { out } = await createSailingPair(12, 24 * 72);
    const user = await createUser('stale-alert');
    const booking = await individualBooking(user, out, 1);
    // Inside one transaction the cron worker cannot see (and release) the stale hold.
    const result = await owner(`begin;
      update public.bookings set hold_expires_at = now() - interval '20 minutes' where id = ${q(booking)};
      set local request.jwt.claims = '{"role":"service_role"}'; set local role service_role;
      select public.system_diagnostics()::text;
      rollback`);
    const diag = JSON.parse(result.split('\n').filter(l => l.startsWith('{')).pop()!);
    expect(diag.alerts).toContain('hold_expiry_job_not_running');
    expect(diag.healthy).toBe(false);
    expect(result).not.toMatch(/@example\.test|\+9665/);
  });

  it('diagnostics are refused to ordinary users', async () => {
    const user = await createUser('diag-user');
    await expect(asUser(user, `select public.system_diagnostics()`)).rejects.toThrow(/not authorized/);
  });
});
