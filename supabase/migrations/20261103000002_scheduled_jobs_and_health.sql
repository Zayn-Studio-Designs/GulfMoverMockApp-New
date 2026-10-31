-- =============================================================================
-- Background jobs + health alerts (production-readiness audit, areas 2 and 4).
--
-- 1. Seats held by unpaid "pay now" bookings were released ONLY when someone
--    called expire_stale_holds(); no scheduler was configured, so a stopped or
--    missing scheduler left seats blocked forever. This schedules it every
--    minute with pg_cron (available on Supabase; skipped cleanly elsewhere).
--    The job is idempotent (row locks + SKIP LOCKED; an expired booking is
--    never processed twice), so overlapping or repeated runs are harmless.
-- 2. system_diagnostics() gains the jobs' last-run status and an `alerts`
--    array with explicit thresholds, so an uptime monitor can alert on new
--    or repeated problems. It may also be called by the service role (for an
--    external monitor) — it returns counts only, never personal data.
--
-- Not scheduled here on purpose:
--  * notifications-dispatch (edge function) — needs the project URL and a
--    service key from Vault; see docs/operations/background-jobs.md.
--  * apply_retention — deletes data; only after ATCO approves retention periods.
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'gm-expire-stale-holds';
    perform cron.schedule('gm-expire-stale-holds', '* * * * *', 'select public.expire_stale_holds()');
  else
    raise notice 'pg_cron is not available: schedule expire_stale_holds() every minute with an external scheduler';
  end if;
end $$;

create or replace function public.system_diagnostics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_jobs jsonb := '[]'::jsonb; v_alerts text[] := '{}'; v_stale_holds bigint;
begin
  if not (public.has_platform_role('{super_admin,it_support}') or auth.role() = 'service_role') then
    raise exception 'not authorized' using errcode = '42501'; end if;

  if to_regclass('cron.job') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'job', j.jobname, 'schedule', j.schedule, 'active', j.active,
               'last_run_at', r.start_time, 'last_status', r.status) order by j.jobname), '[]'::jsonb)
        from cron.job j
        left join lateral (select d.start_time, d.status from cron.job_run_details d
                            where d.jobid = j.jobid order by d.start_time desc limit 1) r on true
       where j.jobname like 'gm-%'$q$ into v_jobs;
  end if;

  -- Holds more than 10 minutes past expiry mean the expiry job is not running.
  select count(*) into v_stale_holds from public.bookings
   where settlement_mode = 'pay_now' and status in ('reserved', 'pending_payment')
     and payment_status in ('unpaid', 'pending') and hold_expires_at < now() - interval '10 minutes';

  v := jsonb_build_object(
    'checked_at', now(),
    'schema_version', (select max(version) from supabase_migrations.schema_migrations),
    'payments_mode', public.setting_text('payments.mode', 'sandbox'),
    'payments_live_enabled', public.setting_bool('payments.live_enabled', false),
    'staff_mfa_required', public.setting_bool('security.staff_mfa_required', false),
    'notification_channels', (select value -> 'value' from public.platform_settings where key = 'notifications.channels'),
    'outbox_failed', (select count(*) from public.notification_outbox where status = 'failed'),
    'outbox_stuck', (select count(*) from public.notification_outbox where status in ('queued', 'sending') and created_at < now() - interval '15 minutes'),
    'provider_events_unprocessed', (select count(*) from public.payment_provider_events where processed_at is null),
    'payments_requiring_review', (select count(*) from public.payments where status = 'requires_review'),
    'refunds_pending_review', (select count(*) from public.refunds where status = 'pending_review'),
    'holds_awaiting_expiry', (select count(*) from public.bookings where settlement_mode = 'pay_now' and status in ('reserved', 'pending_payment')
                                and payment_status in ('unpaid', 'pending') and hold_expires_at < now()),
    'holds_stale_over_10_min', v_stale_holds,
    'privacy_requests_open', (select count(*) from public.privacy_requests where status in ('received', 'in_progress')),
    'privacy_requests_overdue', (select count(*) from public.privacy_requests where status in ('received', 'in_progress') and due_at < now()),
    'scheduled_jobs', v_jobs);

  if v_stale_holds > 0 then v_alerts := array_append(v_alerts, 'hold_expiry_job_not_running'); end if;
  if jsonb_array_length(v_jobs) = 0 then v_alerts := array_append(v_alerts, 'no_scheduled_jobs_configured'); end if;
  if exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'last_status' = 'failed') then v_alerts := array_append(v_alerts, 'scheduled_job_failed'); end if;
  if (v ->> 'outbox_failed')::bigint > 0 then v_alerts := array_append(v_alerts, 'notifications_failed'); end if;
  if (v ->> 'outbox_stuck')::bigint > 0 then v_alerts := array_append(v_alerts, 'notifications_stuck'); end if;
  if exists (select 1 from public.payment_provider_events where processed_at is null and received_at < now() - interval '10 minutes') then
    v_alerts := array_append(v_alerts, 'payment_events_unprocessed'); end if;
  if (v ->> 'payments_requiring_review')::bigint > 0 then v_alerts := array_append(v_alerts, 'payments_requiring_review'); end if;
  -- A checkout still pending after an hour means webhooks and reconciliation are not completing it.
  if exists (select 1 from public.payments where status in ('initiated', 'pending') and provider_payment_id is not null
              and created_at < now() - interval '60 minutes' and created_at > now() - interval '7 days') then
    v_alerts := array_append(v_alerts, 'payments_pending_too_long'); end if;
  if (v ->> 'privacy_requests_overdue')::bigint > 0 then v_alerts := array_append(v_alerts, 'privacy_requests_overdue'); end if;
  -- Spend guard (messaging.daily_cap, migration 20261103000004): queued messages waiting because a channel hit its cap.
  if to_regprocedure('public._messaging_remaining(text)') is not null and exists (
       select 1 from public.notification_outbox o where o.status = 'queued' and o.next_attempt_at <= now()
          and public._messaging_remaining(o.channel) = 0) then
    v_alerts := array_append(v_alerts, 'messaging_daily_cap_reached'); end if;
  return v || jsonb_build_object('alerts', to_jsonb(v_alerts), 'healthy', cardinality(v_alerts) = 0);
end; $$;
revoke all on function public.system_diagnostics() from public, anon;
grant execute on function public.system_diagnostics() to authenticated, service_role;
