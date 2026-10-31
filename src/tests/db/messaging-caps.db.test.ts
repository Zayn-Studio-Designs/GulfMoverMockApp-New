// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { asService, createUser, dbConfigured, owner, q } from './pg';

/**
 * Production-readiness audit — area 5 (spending limits), real PostgreSQL.
 * Migration 20261103000004_messaging_spend_caps.sql: the dispatcher's claim honours a
 * per-channel daily cap, exactly, even across parallel dispatcher runs; over-cap
 * messages stay queued and diagnostics raise an alert.
 */
const d = dbConfigured ? describe : describe.skip;

d('messaging spend caps (local database)', () => {
  it('claims never exceed the remaining daily SMS quota, even with parallel dispatcher runs', async () => {
    const user = await createUser('sms-cap');
    const before = await owner(`select value::text from public.platform_settings where key = 'messaging.daily_cap'`);
    // Isolate from other tests' rows: park any existing queued SMS for the duration of the test.
    await owner(`update public.notification_outbox set next_attempt_at = now() + interval '1 day' where channel = 'sms' and status in ('queued', 'sending')`);
    const sentToday = Number(await owner(`select count(*) from public.notification_outbox where channel = 'sms' and sent_at > now() - interval '24 hours'`));
    try {
      await owner(`update public.platform_settings set value = jsonb_build_object('value', jsonb_build_object('email', 2000, 'sms', ${sentToday + 7}, 'whatsapp', 300))
        where key = 'messaging.daily_cap'`);
      await owner(`with n as (insert into public.notifications (user_id, event_key, kind, target)
          select ${q(user)}, 'cap-test-' || g, 'booking', '/bookings' from generate_series(1, 20) g returning id)
        insert into public.notification_outbox (notification_id, user_id, channel, template_key, target)
          select id, ${q(user)}, 'sms', 'booking_created', '/bookings' from n`);
      const runs = await Promise.all(Array.from({ length: 4 }, () => asService(`select count(*) from public.claim_outbox_batch(50) where channel = 'sms'`)));
      expect(runs.map(Number).reduce((a, b) => a + b, 0)).toBe(7);
      expect(await owner(`select count(*) from public.notification_outbox where user_id = ${q(user)} and status = 'queued'`)).toBe('13');
      const diag = await owner(`begin; set local request.jwt.claims = '{"role":"service_role"}'; set local role service_role;
        select public.system_diagnostics() -> 'alerts'; rollback`);
      expect(diag).toContain('messaging_daily_cap_reached');
    } finally {
      await owner(`update public.platform_settings set value = ${q(before)}::jsonb where key = 'messaging.daily_cap'`);
      await owner(`delete from public.notification_outbox where user_id = ${q(user)}; delete from public.notifications where user_id = ${q(user)}`);
    }
  }, 60000);

  it('a channel with no cap configured sends nothing (fails closed)', async () => {
    expect(await owner(`select public._messaging_remaining('fax')`)).toBe('0');
  });
});
