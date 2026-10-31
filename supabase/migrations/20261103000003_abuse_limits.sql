-- =============================================================================
-- Abuse / rate limits on write endpoints (production-readiness audit, area 3).
--
-- Supabase Auth already rate-limits sign-in, sign-up and password-recovery per IP
-- (supabase/config.toml [auth.rate_limit]; hosted values are set in the dashboard).
-- The application's own write RPCs had no limit except privacy requests, so one
-- signed-in account could, for example, hold every seat on a sailing with unpaid
-- reservations or create unlimited requests. These BEFORE INSERT guards apply to
-- every path that creates the row (RPCs and the payments edge function alike);
-- idempotent replays insert nothing and are therefore never counted.
--
-- * Limits are per user, configurable in platform_settings (no code change).
-- * Server jobs (no user) and ATCO staff acting for customers are exempt.
-- * Checks are serialised per user (advisory lock), so parallel requests cannot
--   slip past a limit together.
-- * Refusals raise `rate_limited` / `too_many_unpaid_holds` with SQLSTATE 54000,
--   the convention already used by submit_privacy_request.
-- =============================================================================

insert into public.platform_settings (key, value, description) values
  ('limits.bookings_per_10_minutes', '{"value": 10}', 'New bookings one user may create in 10 minutes (abuse limit).'),
  ('limits.unpaid_holds_per_user', '{"value": 5}', 'Unpaid "pay now" reservations one user may hold at the same time (stops seat hoarding).'),
  ('limits.checkouts_per_hour', '{"value": 20}', 'Payment checkout attempts one user may start per hour.'),
  ('limits.transfer_requests_per_hour', '{"value": 10}', 'Material / charter requests one user may submit per hour.'),
  ('limits.company_registrations_per_day', '{"value": 3}', 'Company registrations one user may submit per day.'),
  ('limits.invitations_per_hour', '{"value": 30}', 'Company invitations one user may send per hour.')
on conflict (key) do nothing;

-- Indexes so each limit check is a short index range scan (bookings already has bookings_creator_idx).
create index if not exists payments_creator_created_idx on public.payments (created_by, created_at desc);
create index if not exists transfer_requests_creator_created_idx on public.transfer_requests (created_by, created_at desc);
create index if not exists organizations_creator_created_idx on public.organizations (created_by, created_at desc);
create index if not exists company_invitations_creator_created_idx on public.company_invitations (created_by, created_at desc);

create or replace function public._guard_write_rate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_max integer; v_recent bigint; v_holds bigint;
begin
  -- Server jobs / owner maintenance have no user; staff act on behalf of customers.
  if v_uid is null or public.has_platform_role('{super_admin,operations,finance,boarding_staff,it_support}') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('gm-rate:' || tg_table_name || ':' || v_uid::text, 0));

  if tg_table_name = 'bookings' then
    v_max := public.setting_int('limits.bookings_per_10_minutes', 10);
    select count(*) into v_recent from public.bookings where created_by = v_uid and created_at > now() - interval '10 minutes';
    if v_recent >= v_max then raise exception 'rate_limited: too many bookings, try again in a few minutes' using errcode = '54000'; end if;
    if new.settlement_mode = 'pay_now' then
      v_max := public.setting_int('limits.unpaid_holds_per_user', 5);
      select count(*) into v_holds from public.bookings
       where created_by = v_uid and settlement_mode = 'pay_now' and status in ('reserved', 'pending_payment')
         and payment_status in ('unpaid', 'pending') and hold_expires_at > now();
      if v_holds >= v_max then
        raise exception 'too_many_unpaid_holds: pay for or cancel an existing reservation first' using errcode = '54000'; end if;
    end if;
  elsif tg_table_name = 'payments' then
    v_max := public.setting_int('limits.checkouts_per_hour', 20);
    select count(*) into v_recent from public.payments where created_by = v_uid and created_at > now() - interval '1 hour';
    if v_recent >= v_max then raise exception 'rate_limited: too many payment attempts, try again later' using errcode = '54000'; end if;
  elsif tg_table_name = 'transfer_requests' then
    v_max := public.setting_int('limits.transfer_requests_per_hour', 10);
    select count(*) into v_recent from public.transfer_requests where created_by = v_uid and created_at > now() - interval '1 hour';
    if v_recent >= v_max then raise exception 'rate_limited: too many requests, try again later' using errcode = '54000'; end if;
  elsif tg_table_name = 'organizations' then
    v_max := public.setting_int('limits.company_registrations_per_day', 3);
    select count(*) into v_recent from public.organizations where created_by = v_uid and created_at > now() - interval '1 day';
    if v_recent >= v_max then raise exception 'rate_limited: too many company registrations today' using errcode = '54000'; end if;
  elsif tg_table_name = 'company_invitations' then
    v_max := public.setting_int('limits.invitations_per_hour', 30);
    select count(*) into v_recent from public.company_invitations where created_by = v_uid and created_at > now() - interval '1 hour';
    if v_recent >= v_max then raise exception 'rate_limited: too many invitations, try again later' using errcode = '54000'; end if;
  end if;
  return new;
end; $$;
revoke all on function public._guard_write_rate() from public, anon, authenticated, service_role;

drop trigger if exists trg_bookings_rate on public.bookings;
create trigger trg_bookings_rate before insert on public.bookings for each row execute function public._guard_write_rate();
drop trigger if exists trg_payments_rate on public.payments;
create trigger trg_payments_rate before insert on public.payments for each row execute function public._guard_write_rate();
drop trigger if exists trg_transfer_requests_rate on public.transfer_requests;
create trigger trg_transfer_requests_rate before insert on public.transfer_requests for each row execute function public._guard_write_rate();
drop trigger if exists trg_organizations_rate on public.organizations;
create trigger trg_organizations_rate before insert on public.organizations for each row execute function public._guard_write_rate();
drop trigger if exists trg_company_invitations_rate on public.company_invitations;
create trigger trg_company_invitations_rate before insert on public.company_invitations for each row execute function public._guard_write_rate();
