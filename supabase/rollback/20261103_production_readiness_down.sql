-- =============================================================================
-- DOWN script for the production-readiness audit migrations (20261103000000..05).
--
-- NOT a migration (it lives outside supabase/migrations so `db push` never runs it).
-- You normally do NOT need it: every audit migration is additive and the previous
-- application version runs unchanged on the new schema (verified, see
-- docs/production-readiness-audit.md). Use it only if a database-side change itself
-- must be withdrawn. It restores the exact pre-audit definitions and removes only
-- objects the audit added; it deletes no business data.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/rollback/20261103_production_readiness_down.sql
--   then: delete from supabase_migrations.schema_migrations where version between '20261103000000' and '20261103000005';
-- =============================================================================

-- 05 payment reconciliation (the /reconcile route then errors: remove its schedule before running this)
drop function if exists public.list_payments_to_reconcile(integer, integer);
drop index if exists public.payments_open_created_idx;

-- 04 messaging spend caps -> original claim (no caps)
create or replace function public.claim_outbox_batch(p_limit integer)
returns table (outbox_id uuid, channel text, template_key text, target text, locale text, recipient text, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
  with due as (
    select o.id from public.notification_outbox o
     where o.status in ('queued', 'sending') and o.next_attempt_at <= now()
     order by o.next_attempt_at limit greatest(1, least(coalesce(p_limit, 50), 200)) for update skip locked)
  update public.notification_outbox o set status = 'sending', attempts = o.attempts + 1,
    next_attempt_at = now() + interval '5 minutes', updated_at = now()
   from due where o.id = due.id
  returning o.id, o.channel, o.template_key, o.target,
    coalesce((select p.preferred_language from public.profiles p where p.id = o.user_id), 'en'),
    case when o.channel = 'email' then (select u.email from auth.users u where u.id = o.user_id)::text
         else (select p.phone from public.profiles p where p.id = o.user_id) end,
    o.attempts;
end; $$;
revoke all on function public.claim_outbox_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_outbox_batch(integer) to service_role;
drop function if exists public._messaging_remaining(text);
drop index if exists public.notification_outbox_sent_recent_idx;
delete from public.platform_settings where key = 'messaging.daily_cap';

-- 03 abuse limits
drop trigger if exists trg_bookings_rate on public.bookings;
drop trigger if exists trg_payments_rate on public.payments;
drop trigger if exists trg_transfer_requests_rate on public.transfer_requests;
drop trigger if exists trg_organizations_rate on public.organizations;
drop trigger if exists trg_company_invitations_rate on public.company_invitations;
drop function if exists public._guard_write_rate();
delete from public.platform_settings where key like 'limits.%';
drop index if exists public.payments_creator_created_idx;
drop index if exists public.transfer_requests_creator_created_idx;
drop index if exists public.organizations_creator_created_idx;
drop index if exists public.company_invitations_creator_created_idx;

-- 02 scheduled jobs + diagnostics -> unschedule (re-schedule externally!) and original diagnostics
do $$ begin
  if to_regclass('cron.job') is not null then perform cron.unschedule(jobid) from cron.job where jobname = 'gm-expire-stale-holds'; end if;
end $$;
create or replace function public.system_diagnostics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,it_support}') then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
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
    'privacy_requests_open', (select count(*) from public.privacy_requests where status in ('received', 'in_progress')),
    'privacy_requests_overdue', (select count(*) from public.privacy_requests where status in ('received', 'in_progress') and due_at < now()));
end; $$;
revoke all on function public.system_diagnostics() from public, anon, service_role;
grant execute on function public.system_diagnostics() to authenticated;
revoke execute on function public.system_diagnostics() from service_role;

-- 01 integrity backstops
alter table public.sailings drop constraint if exists sailings_payload_not_over_capacity;
alter table public.invoices drop constraint if exists invoices_amount_paid_within_total;

-- 00 query efficiency (batch status). The previous app never calls it.
drop function if exists public.sailing_control_status(uuid[]);
drop function if exists public._sailing_status_rows(uuid[]);
