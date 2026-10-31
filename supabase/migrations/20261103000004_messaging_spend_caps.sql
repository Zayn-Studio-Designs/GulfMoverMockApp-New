-- =============================================================================
-- Messaging spend caps (production-readiness audit, area 5: spending limits).
--
-- SMS and WhatsApp are charged per message. Channels are off by default
-- (notifications.channels), but once enabled nothing bounded the daily volume:
-- a bug or an event storm could send thousands of paid messages. The dispatcher
-- now only claims a channel's messages while that channel has sent fewer than its
-- daily cap in the last 24 hours. Over-cap messages stay QUEUED (nothing is lost
-- and nothing is sent twice) and system_diagnostics() raises
-- `messaging_daily_cap_reached` so an operator can decide to raise the cap.
-- Caps are settings (no code change); ATCO should align them with provider budgets.
-- =============================================================================

insert into public.platform_settings (key, value, description) values
  ('messaging.daily_cap', '{"value": {"email": 2000, "sms": 300, "whatsapp": 300}}',
   'Maximum messages sent per channel in any 24 hours (cost guard). Over-cap messages wait in the queue.')
on conflict (key) do nothing;

create index if not exists notification_outbox_sent_recent_idx on public.notification_outbox (channel, sent_at) where sent_at is not null;

-- Remaining sends a channel may make now: cap minus (sent in the last 24 h + currently in flight).
create or replace function public._messaging_remaining(p_channel text)
returns bigint language sql stable security definer set search_path = '' as $$
  select greatest(
    coalesce(((select value -> 'value' from public.platform_settings where key = 'messaging.daily_cap') ->> p_channel)::bigint, 0)
    - (select count(*) from public.notification_outbox o
        where o.channel = p_channel and (o.sent_at > now() - interval '24 hours' or (o.status = 'sending' and o.next_attempt_at > now()))), 0)
$$;
revoke all on function public._messaging_remaining(text) from public, anon, authenticated, service_role;

create or replace function public.claim_outbox_batch(p_limit integer)
returns table (outbox_id uuid, channel text, template_key text, target text, locale text, recipient text, attempts integer)
language plpgsql security definer set search_path = '' as $$
declare v_left integer := greatest(1, least(coalesce(p_limit, 50), 200)); v_ch text; v_take integer; v_got integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  foreach v_ch in array array['email', 'sms', 'whatsapp'] loop
    exit when v_left <= 0;
    -- Serialise quota checks per channel so parallel dispatcher runs cannot both overshoot the cap.
    perform pg_advisory_xact_lock(hashtextextended('gm-messaging-quota:' || v_ch, 0));
    v_take := least(v_left, public._messaging_remaining(v_ch))::integer;
    continue when v_take <= 0;
    return query
    with due as (
      select o.id from public.notification_outbox o
       where o.channel = v_ch and o.status in ('queued', 'sending') and o.next_attempt_at <= now()
       order by o.next_attempt_at limit v_take for update skip locked)
    update public.notification_outbox o set status = 'sending', attempts = o.attempts + 1,
      next_attempt_at = now() + interval '5 minutes', updated_at = now()
     from due where o.id = due.id
    returning o.id, o.channel, o.template_key, o.target,
      coalesce((select p.preferred_language from public.profiles p where p.id = o.user_id), 'en'),
      case when o.channel = 'email' then (select u.email from auth.users u where u.id = o.user_id)::text
           else (select p.phone from public.profiles p where p.id = o.user_id) end,
      o.attempts;
    get diagnostics v_got = row_count;
    v_left := v_left - v_got;
  end loop;
end; $$;
revoke all on function public.claim_outbox_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_outbox_batch(integer) to service_role;
