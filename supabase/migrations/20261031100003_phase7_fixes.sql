-- ===========================================================================
-- 20261031100003 - Phase 7 fixes from integration testing (additive only)
-- 1. Qualify service_policies.status (PL/pgSQL OUT params named it ambiguous).
-- 2. Track refund amounts on payment_events so revenue reports are exact.
-- ===========================================================================

create or replace function public.create_individual_booking(
  p_request_key uuid, p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text,
  p_passenger_names text[] default null, p_return_sailing_id uuid default null,
  p_destination_vessel text default null, p_destination_imo text default null,
  p_terms_version text default null
)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid; v_terms text; v_fare bigint;
begin
  v_uid := (select auth.uid());
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'suspended') then
    raise exception 'profile_suspended' using errcode = '28000';
  end if;
  select sp.version into v_terms from public.service_policies as sp
   where sp.policy_type = 'booking_terms' and sp.status = 'provisional' order by sp.effective_from desc limit 1;
  if p_terms_version is null or p_terms_version <> v_terms then
    raise exception 'terms_not_accepted: current booking terms must be accepted' using errcode = '22023'; end if;
  if p_destination_imo is not null and p_destination_imo !~ '^IMO[0-9]{7}$' then
    raise exception 'invalid IMO number' using errcode = '22023'; end if;
  select per_person_halala into v_fare from public.tariffs where active = true order by effective_from desc limit 1;
  if v_fare is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;
  return query select r.booking_id, r.reference, r.status, r.outcome from public._reserve_booking(
    p_request_key, null, 'individual', null, null, null,
    p_outbound_sailing_id, p_passenger_count, p_contact_name, p_contact_email, p_contact_phone,
    p_passenger_names, p_return_sailing_id, null,
    p_destination_vessel, p_destination_imo, null, p_terms_version, true) as r;
  return;
end; $$;

-- Same terms-lookup qualification inside the shared reservation engine.
create or replace function public._reserve_booking_terms(p_required boolean, p_version text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_terms text;
begin
  if not p_required then return p_version; end if;
  select sp.version into v_terms from public.service_policies as sp
   where sp.policy_type = 'booking_terms' and sp.status = 'provisional' order by sp.effective_from desc limit 1;
  if p_version is null or p_version <> v_terms then
    raise exception 'terms_not_accepted: current booking terms must be accepted' using errcode = '22023'; end if;
  return v_terms;
end; $$;
revoke all on function public._reserve_booking_terms(boolean, text) from public, anon, service_role;

-- payment_events carry the money movement so reports are exact.
alter table public.payment_events
  add column if not exists amount_halala bigint constraint payment_events_amount_range check (amount_halala is null or amount_halala >= 0);

create or replace function public.refund_payment(p_payment_id uuid, p_amount_halala bigint, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_prev bigint; v_pol text;
begin
  if p_payment_id is null or p_amount_halala is null or p_amount_halala <= 0
     or nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'invalid input' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  select status into v_pol from public.service_policies where policy_type = 'refund' and status = 'approved'
   order by effective_from desc limit 1;
  if v_pol is null then raise exception 'refund_policy_not_approved: refunds are inactive until ATCO approves a refund policy' using errcode = '55000'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_p.status not in ('succeeded', 'partially_refunded') then
    raise exception 'invalid_transition: only succeeded payments can be refunded' using errcode = '55000'; end if;
  select coalesce(sum(amount_halala), 0) into v_prev from public.payment_events
   where payment_id = p_payment_id and status = 'refunded';
  if v_prev + p_amount_halala > v_p.amount_halala then
    raise exception 'invalid amount: refund exceeds captured amount' using errcode = '22023'; end if;
  insert into public.payment_events (payment_id, status, amount_halala, detail, actor_user_id)
  values (p_payment_id, 'refunded', p_amount_halala, 'Sandbox refund ' || p_amount_halala || ' halala: ' || btrim(p_reason), auth.uid());
  if v_prev + p_amount_halala >= v_p.amount_halala then
    update public.payments set status = 'refunded' where id = p_payment_id;
    update public.bookings set payment_status = 'refunded', status = 'refunded' where id = v_p.booking_id;
  else
    update public.payments set status = 'partially_refunded' where id = p_payment_id;
    update public.bookings set payment_status = 'partially_refunded' where id = v_p.booking_id;
  end if;
  return 'refunded';
end; $$;

create or replace function public.report_revenue_by_sailing(p_from date, p_to date)
returns table (sailing_id uuid, departs_at timestamptz, bookings bigint, passengers bigint,
  collected_halala bigint, refunded_halala bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance,operations}') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    select s.id, s.departs_at,
      count(distinct b.id) filter (where b.status <> 'cancelled'),
      coalesce(sum(l.passengers) filter (where b.status <> 'cancelled'), 0)::bigint,
      coalesce(sum(p.amount_halala) filter (where p.status = 'succeeded'), 0)::bigint,
      coalesce((select sum(e.amount_halala) from public.payment_events e join public.payments p2 on p2.id = e.payment_id
        join public.booking_legs l2 on l2.booking_id = p2.booking_id
        where l2.sailing_id = s.id and e.status = 'refunded'), 0)::bigint
    from public.sailings s
    left join public.booking_legs l on l.sailing_id = s.id
    left join public.bookings b on b.id = l.booking_id
    left join public.payments p on p.booking_id = b.id
    where s.departs_at::date between p_from and p_to
    group by s.id, s.departs_at order by s.departs_at;
end; $$;
