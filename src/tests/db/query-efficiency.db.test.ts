// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asUser, clearSailing, createSailingPair, createStaff, createUser,
  dbConfigured, fails, individualBooking, owner, payInSandbox, q,
} from './pg';

/**
 * Migration `20261103000000_query_efficiency.sql` — N+1 removal.
 *
 * - `sailing_control_status(uuid[])` returns, in one call, exactly what the
 *   per-sailing `sailing_commercial_status` + `sailing_boarding_gate` return
 *   (the two implementations must never drift apart).
 * - The occupancy and revenue reports (unchanged) agree with it.
 * - The set-based helper is internal; the batch API is bounded and not anonymous.
 *
 * Skipped without a local database.
 */
const d = dbConfigured ? describe : describe.skip;

d('query efficiency — batch sailing status (local database)', () => {
  let ops: string; let fin: string; let user: string;
  let a: { out: string; back: string }; let b: { out: string; back: string }; let c: { out: string; back: string };

  beforeAll(async () => {
    ops = await createStaff('qe-ops', 'operations');
    fin = await createStaff('qe-fin', 'finance');
    user = await createUser('qe-user');
    a = await createSailingPair(12, 24 * 40);
    b = await createSailingPair(12, 24 * 41);
    c = await createSailingPair(12, 24 * 42);
    // a: 3 pax with return, paid + 2 pax unpaid. b: 4 paid tickets (minimum met) and cleared. c: suspended, empty.
    const b1 = await individualBooking(user, a.out, 3, a.back); await payInSandbox(user, b1);
    await individualBooking(user, a.out, 2);
    for (let i = 0; i < 4; i++) { const x = await individualBooking(user, b.out, 1); await payInSandbox(user, x); }
    await clearSailing(ops, b.out);
    await asUser(ops, `select public.suspend_sailing(${q(c.out)}, 'Weather hold (fictional)')`);
  }, 120000);

  it('one batch call returns exactly what the per-sailing functions return', async () => {
    const ids = [a.out, a.back, b.out, b.back, c.out, c.back];
    const cols = `reserved_tickets||'|'||qualifying_tickets||'|'||qualifying_revenue_halala||'|'||threshold_met||'|'||commercial_state||'|'||confirmation_deadline`;
    const batch = await asUser(user, `select string_agg(sailing_id||'|'||${cols}||'|'||boarding_gate, E'\\n' order by sailing_id)
      from public.sailing_control_status(array[${ids.map(q).join(',')}]::uuid[])`);
    const single = await asUser(user, `select string_agg(s.id||'|'||(select ${cols} from public.sailing_commercial_status(s.id))||'|'||public.sailing_boarding_gate(s.id), E'\\n' order by s.id)
      from public.sailings s where s.id in (${ids.map(q).join(',')})`);
    expect(batch).toBe(single);
    const byId = Object.fromEntries(batch.split('\n').map(line => [line.split('|')[0], line]));
    expect(byId[a.out]).toMatch(/^[^|]+\|5\|3\|150000\|false\|awaiting_minimum\|/);
    expect(byId[a.back]).toMatch(/\|3\|3\|/);
    expect(byId[b.out]).toMatch(/\|4\|4\|200000\|true\|threshold_met\|.*\|open$/);
    expect(byId[c.out]).toMatch(/\|sailing_suspended$/);
  });

  it('unknown sailings are simply absent; the single-sailing API keeps its errors', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead';
    expect(await asUser(user, `select count(*) from public.sailing_control_status(array[${q(ghost)}, ${q(a.out)}]::uuid[])`)).toBe('1');
    expect(await asUser(user, `select public.sailing_boarding_gate(${q(ghost)})`)).toBe('not_found');
    expect((await fails(asUser(user, `select * from public.sailing_commercial_status(${q(ghost)})`))).sqlState).toBe('P0002');
    expect((await fails(asUser(user, `select * from public.sailing_commercial_status(null)`))).sqlState).toBe('22023');
  });

  it('the batch is bounded (max 500 ids) and rejects a null list', async () => {
    expect((await fails(asUser(user, `select * from public.sailing_control_status(array(select gen_random_uuid() from generate_series(1, 501)))`))).sqlState).toBe('22023');
    expect((await fails(asUser(user, `select * from public.sailing_control_status(null)`))).sqlState).toBe('22023');
    expect(await asUser(user, `select count(*) from public.sailing_control_status(array(select gen_random_uuid() from generate_series(1, 500)))`)).toBe('0');
  });

  it('the batch API is for signed-in users only; the set-based helper is internal', async () => {
    expect((await fails(asAnon(`select * from public.sailing_control_status(array[${q(a.out)}]::uuid[])`))).message).toMatch(/permission denied/i);
    for (const role of ['anon', 'authenticated']) {
      expect(await owner(`select bool_or(has_function_privilege(${q(role)}, p.oid, 'execute')) from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = '_sailing_status_rows'`)).toBe('f');
    }
    expect((await fails(asUser(user, `select * from public._sailing_status_rows(array[${q(a.out)}]::uuid[])`))).message).toMatch(/permission denied/i);
  });

  it('the occupancy report agrees with the batch status', async () => {
    const day = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date from public.sailings where id = ${q(b.out)}`);
    const report = await asUser(ops, `select threshold_met||'|'||ticket_count from public.report_sailing_occupancy(${q(day)}, ${q(day)}) where sailing_id = ${q(b.out)}`);
    expect(report).toBe('true|4');
  });

  it('revenue by sailing splits each booking across its legs (matches the batch fixture)', async () => {
    const day1 = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date from public.sailings where id = ${q(a.out)}`);
    const day2 = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date from public.sailings where id = ${q(a.back)}`);
    // 3 pax × 2 legs × SAR 500 = SAR 3,000 captured, split SAR 1,500 per leg; the unpaid booking adds nothing.
    expect(await asUser(fin, `select collected_halala from public.report_revenue_by_sailing(${q(day1)}, ${q(day2)}) where sailing_id = ${q(a.out)}`)).toBe('150000');
    expect(await asUser(fin, `select collected_halala from public.report_revenue_by_sailing(${q(day1)}, ${q(day2)}) where sailing_id = ${q(a.back)}`)).toBe('150000');
    expect(await asUser(fin, `select bookings||'|'||passengers from public.report_revenue_by_sailing(${q(day1)}, ${q(day1)}) where sailing_id = ${q(a.out)}`)).toBe('2|5');
  });
});
