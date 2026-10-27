-- ===========================================================================
-- 20261031100000 — Phase 7: ATCO requirements (tariffs, access, lifecycle,
-- payments sandbox, materials, credit/settlement, reports, policies)
-- ===========================================================================
-- Additive: no earlier migration is edited. All money is integer minor units
-- (halala; SAR 1 = 100 halala). No floating point anywhere.
--
-- PROVISIONAL DEFAULTS (pending ATCO confirmation, see
-- docs/atco-pending-business-rules.md and docs/requirements-traceability.md):
--   * fare 50000 halala (SAR 500) per person per one-way leg, VAT unset/inactive
--   * seeded Ras Tanura route + 07:00/09:30/13:00 Asia/Riyadh sailings (provisional names/times)
--   * minimum 4 tickets OR 200000 halala (SAR 2,000) revenue per sailing
--   * 24h confirmation deadline, cancellation/refund workflows present but
--     financial consequences REQUIRE an approved policy before live activation
--   * sandbox payments only: no real money, no card data, no merchant credentials
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Organizations: account type + credit foundations
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists account_type text not null default 'corporate'
    constraint organizations_account_type_check check (account_type in ('corporate', 'agent')),
  add column if not exists credit_limit_halala bigint
    constraint organizations_credit_limit_range check (credit_limit_halala is null or credit_limit_halala between 0 and 9000000000000),
  add column if not exists payment_terms_days integer
    constraint organizations_payment_terms_range check (payment_terms_days is null or payment_terms_days between 0 and 365);

comment on column public.organizations.account_type is
  'corporate = books for itself; agent = ship agent booking on behalf of clients. Set by ATCO staff only.';
comment on column public.organizations.credit_limit_halala is
  'Credit limit in halala. NULL = no credit facility. Inactive until ATCO Finance approves terms.';
comment on column public.organizations.payment_terms_days is
  'Payment terms in days. NULL = pay before travel (default). Inactive until approved.';

create or replace function public.set_organization_account_type(p_org uuid, p_account_type text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_org is null or p_account_type is null
     or p_account_type not in ('corporate', 'agent') then
    raise exception 'invalid input' using errcode = '22023';
  end if;
  if not public.has_platform_role('{super_admin}') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.organizations set account_type = p_account_type where id = p_org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
end; $$;
revoke all on function public.set_organization_account_type(uuid, text) from public, anon, service_role;
grant execute on function public.set_organization_account_type(uuid, text) to authenticated;

create or replace function public.set_organization_credit(p_org uuid, p_credit_limit_halala bigint, p_payment_terms_days integer)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_org is null then raise exception 'invalid input' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,finance}') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_credit_limit_halala is not null and (p_credit_limit_halala < 0 or p_credit_limit_halala > 9000000000000) then
    raise exception 'invalid credit limit' using errcode = '22023';
  end if;
  if p_payment_terms_days is not null and (p_payment_terms_days < 0 or p_payment_terms_days > 365) then
    raise exception 'invalid payment terms' using errcode = '22023';
  end if;
  update public.organizations
     set credit_limit_halala = p_credit_limit_halala, payment_terms_days = p_payment_terms_days
   where id = p_org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
end; $$;
revoke all on function public.set_organization_credit(uuid, bigint, integer) from public, anon, service_role;
grant execute on function public.set_organization_credit(uuid, bigint, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tariffs (auditable, minor units, VAT inactive)
-- ---------------------------------------------------------------------------
create table if not exists public.tariffs (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique constraint tariffs_code_length check (char_length(btrim(code)) between 1 and 64),
  per_person_halala bigint not null constraint tariffs_fare_range check (per_person_halala between 0 and 9000000000000),
  currency          text not null default 'SAR' constraint tariffs_currency_check check (currency = 'SAR'),
  vat_percent       numeric(5,2) constraint tariffs_vat_range check (vat_percent is null or (vat_percent >= 0 and vat_percent <= 100)),
  vat_active        boolean not null default false,
  effective_from    timestamptz not null default now(),
  effective_to      timestamptz,
  active            boolean not null default true,
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  constraint tariffs_dates_order check (effective_to is null or effective_to > effective_from)
);
comment on table public.tariffs is
  'Auditable fare table. Money in halala integers. vat_active=false until ATCO approves a tariff treatment. No code claims ZATCA compliance.';
alter table public.tariffs enable row level security;
drop policy if exists tariffs_select_all on public.tariffs;
create policy tariffs_select_all on public.tariffs for select to authenticated using (true);
drop policy if exists tariffs_write_staff on public.tariffs;
create policy tariffs_write_staff on public.tariffs for all to authenticated
  using (public.has_platform_role('{super_admin,finance,operations}'))
  with check (public.has_platform_role('{super_admin,finance,operations}'));
revoke all on public.tariffs from public, anon, authenticated, service_role;
grant select on public.tariffs to authenticated;
grant insert (code, per_person_halala, currency, vat_percent, vat_active, effective_from, effective_to, active) on public.tariffs to authenticated;
grant update (code, per_person_halala, currency, vat_percent, vat_active, effective_from, effective_to, active) on public.tariffs to authenticated;

insert into public.tariffs (code, per_person_halala, currency, vat_percent, vat_active, active)
values ('BASE-2026-ATCO-PENDING', 50000, 'SAR', null, false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Service policies (versioned; financial activation requires approval)
-- ---------------------------------------------------------------------------
create table if not exists public.service_policies (
  id             uuid primary key default gen_random_uuid(),
  policy_type    text not null constraint service_policies_type_check check (policy_type in (
                   'cancellation', 'no_show', 'weather', 'refund', 'waiting_time',
                   'baggage', 'port_access', 'materials_safety', 'booking_terms')),
  version        text not null constraint service_policies_version_length check (char_length(btrim(version)) between 1 and 32),
  content        jsonb not null,
  status         text not null default 'provisional' constraint service_policies_status_check check (status in ('provisional', 'approved', 'retired')),
  effective_from timestamptz not null default now(),
  created_by     uuid references auth.users (id),
  created_at     timestamptz not null default now(),
  unique (policy_type, version)
);
comment on table public.service_policies is
  'Versioned policy texts. Only status=approved policies may drive financial consequences. Provisional defaults are clearly marked.';
alter table public.service_policies enable row level security;
drop policy if exists service_policies_select_all on public.service_policies;
create policy service_policies_select_all on public.service_policies for select to authenticated using (true);
drop policy if exists service_policies_write_staff on public.service_policies;
create policy service_policies_write_staff on public.service_policies for all to authenticated
  using (public.has_platform_role('{super_admin,operations}'))
  with check (public.has_platform_role('{super_admin,operations}'));
revoke all on public.service_policies from public, anon, authenticated, service_role;
grant select on public.service_policies to authenticated;
grant insert (policy_type, version, content, status, effective_from) on public.service_policies to authenticated;
grant update (policy_type, version, content, status, effective_from) on public.service_policies to authenticated;

insert into public.service_policies (policy_type, version, content, status) values
  ('booking_terms', 'v1-provisional', '{"title": {"en": "Gulf Mover booking terms (provisional)", "ar": "شروط حجز Gulf Mover (مؤقتة)"}, "body": {"en": "Provisional demo terms. No payment is taken and no legal clearance is granted. Pending ATCO approval.", "ar": "شروط تجريبية مؤقتة. لا يتم تحصيل أي مبلغ ولا يُمنح أي تصريح قانوني. بانتظار اعتماد ATCO."}}', 'provisional'),
  ('cancellation', 'v1-provisional', '{"free_cancellation_hours": 24, "refund_requires_approved_policy": true, "note": "Provisional default. Financial consequences inactive until ATCO approves a refund policy."}', 'provisional'),
  ('refund', 'v1-provisional', '{"automatic_refunds": false, "requires_approval": true, "note": "No automatic refunds. Every refund needs an approved policy and staff action."}', 'provisional'),
  ('no_show', 'v1-provisional', '{"policy": "Provisional: no-show is recorded only. No fee until ATCO approves.", "fee_halala": 0}', 'provisional'),
  ('weather', 'v1-provisional', '{"policy": "ATCO operations may cancel or reschedule for weather or safety. Rebooking is offered; refunds need an approved policy."}', 'provisional')
on conflict (policy_type, version) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Seed: initial Ras Tanura route + 07:00/09:30/13:00 Asia/Riyadh sailings
-- ---------------------------------------------------------------------------
-- Asia/Riyadh is UTC+3 year-round. Times below are stored as UTC instants.
-- Names and the return offsets are PROVISIONAL and editable by ATCO staff.
do $$
declare
  v_vessel uuid; v_out uuid; v_back uuid; d integer; hh integer; t time;
begin
  if not exists (select 1 from public.vessels where lower(btrim(name)) = lower(btrim('Provisional Taxi Vessel - pending ATCO confirmation'))) then
    insert into public.vessels (name, passenger_capacity, status)
    values ('Provisional Taxi Vessel - pending ATCO confirmation', 12, 'active');
  end if;
  select id into v_vessel from public.vessels
   where lower(btrim(name)) = lower(btrim('Provisional Taxi Vessel - pending ATCO confirmation')) limit 1;

  if not exists (select 1 from public.routes
      where lower(btrim(origin)) = lower(btrim('Ras Tanura Service Pier'))
        and lower(btrim(destination)) = lower(btrim('Approved Anchorage - pending ATCO confirmation'))) then
    insert into public.routes (origin, destination, status)
    values ('Ras Tanura Service Pier', 'Approved Anchorage - pending ATCO confirmation', 'active');
  end if;
  if not exists (select 1 from public.routes
      where lower(btrim(origin)) = lower(btrim('Approved Anchorage - pending ATCO confirmation'))
        and lower(btrim(destination)) = lower(btrim('Ras Tanura Service Pier'))) then
    insert into public.routes (origin, destination, status)
    values ('Approved Anchorage - pending ATCO confirmation', 'Ras Tanura Service Pier', 'active');
  end if;
  select id into v_out from public.routes
   where lower(btrim(origin)) = lower(btrim('Ras Tanura Service Pier')) limit 1;
  select id into v_back from public.routes
   where lower(btrim(origin)) = lower(btrim('Approved Anchorage - pending ATCO confirmation')) limit 1;

  -- Next 7 days, outbound 07:00/09:30/13:00 (+03:00), return on the reverse route same times.
  for d in 1..7 loop
    for hh in 0..2 loop
      t := (ARRAY[time '04:00', time '06:30', time '10:00'])[hh + 1];
      begin
        insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
        values (v_out, v_vessel, ((current_date + d) + t)::timestamptz, 12, 'open');
      exception when unique_violation then null;
      end;
      begin
        insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
        values (v_back, v_vessel, ((current_date + d) + t)::timestamptz, 12, 'open');
      exception when unique_violation then null;
      end;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Bookings: account model, lifecycle, terms, money references
-- ---------------------------------------------------------------------------
alter table public.bookings
  add column if not exists account_type text not null default 'corporate'
    constraint bookings_account_type_check check (account_type in ('corporate', 'individual', 'agent')),
  add column if not exists agent_organization_id uuid references public.organizations (id),
  add column if not exists client_name text constraint bookings_client_name_length check (client_name is null or char_length(btrim(client_name)) between 1 and 120),
  add column if not exists client_reference text constraint bookings_client_reference_length check (client_reference is null or char_length(client_reference) <= 64),
  add column if not exists destination_vessel text constraint bookings_destination_vessel_length check (destination_vessel is null or char_length(btrim(destination_vessel)) between 1 and 120),
  add column if not exists destination_imo text constraint bookings_destination_imo_format check (destination_imo is null or destination_imo ~ '^IMO[0-9]{7}$'),
  add column if not exists permit_status text constraint bookings_permit_status_check check (permit_status is null or permit_status in ('not_required', 'pending', 'verified')),
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists payment_status text not null default 'unpaid'
    constraint bookings_payment_status_check check (payment_status in ('unpaid', 'pending', 'paid', 'refunded', 'partially_refunded')),
  add column if not exists operational_status text not null default 'awaiting_minimum'
    constraint bookings_operational_status_check check (operational_status in ('awaiting_minimum', 'threshold_met', 'confirmed_for_departure', 'suspended', 'cancelled')),
  add column if not exists fare_halala bigint constraint bookings_fare_range check (fare_halala is null or fare_halala between 0 and 9000000000000),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text constraint bookings_cancel_reason_length check (cancel_reason is null or char_length(cancel_reason) <= 500);

-- Individuals book without an organization: allow NULL for that path only.
alter table public.bookings alter column organization_id drop not null;
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('reserved', 'pending_payment', 'paid', 'cancelled', 'refunded', 'rescheduled'));

-- Corporate/agent bookings still require an organization; individuals must not send one.
alter table public.bookings drop constraint if exists bookings_account_org_shape;
alter table public.bookings add constraint bookings_account_org_shape check (
  (account_type = 'individual' and organization_id is null and agent_organization_id is null)
  or ((account_type = 'corporate' or account_type = 'agent') and organization_id is not null)
);
alter table public.bookings drop constraint if exists bookings_agent_shape;
alter table public.bookings add constraint bookings_agent_shape check (
  (account_type = 'agent' and agent_organization_id is not null)
  or (account_type <> 'agent' and agent_organization_id is null)
);

-- ---------------------------------------------------------------------------
-- 6. Minimum-sailing evaluation (configurable; warning only, never auto-acts)
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description) values
  ('sailing.minimum_tickets', '{"value": 4}', 'Minimum passenger tickets across all bookings for one sailing (provisional, ATCO to confirm). Warning only.'),
  ('sailing.minimum_revenue_halala', '{"value": 200000}', 'Alternative minimum revenue in halala (SAR 2,000 at the initial fare). Warning only.'),
  ('booking.confirmation_deadline_hours', '{"value": 24}', 'Provisional confirmation deadline in hours. No automatic action is taken.'),
  ('payments.mode', '{"value": "sandbox"}', 'Payments mode. Only "sandbox" exists: no real money moves.'),
  ('payments.provider', '{"value": "sandbox-provider"}', 'Active payment provider id. Sandbox only until ATCO contracts a provider.')
on conflict (key) do nothing;

create or replace function public.sailing_minimum_status(p_sailing_id uuid)
returns table (ticket_count bigint, revenue_halala bigint, threshold_tickets integer, threshold_revenue_halala bigint, threshold_met boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_need_tickets integer; v_need_revenue bigint; v_count bigint; v_recorded bigint; v_fare bigint; v_revenue bigint;
begin
  if p_sailing_id is null then raise exception 'invalid sailing' using errcode = '22023'; end if;
  select coalesce((select (value->>'value')::int from public.platform_settings where key = 'sailing.minimum_tickets'), 4) into v_need_tickets;
  select coalesce((select (value->>'value')::bigint from public.platform_settings where key = 'sailing.minimum_revenue_halala'), 200000) into v_need_revenue;
  select count(*) into v_count from public.tickets t join public.bookings b on b.id = t.booking_id
   where t.sailing_id = p_sailing_id and t.status <> 'cancelled' and b.status <> 'cancelled';
  select coalesce(sum(x.fare_halala), 0) into v_recorded from
    (select distinct b2.id, coalesce(b2.fare_halala, 0) as fare_halala from public.tickets t2
     join public.bookings b2 on b2.id = t2.booking_id
     where t2.sailing_id = p_sailing_id and t2.status <> 'cancelled' and b2.status <> 'cancelled') x;
  if v_recorded = 0 and v_count > 0 then
    select per_person_halala into v_fare from public.tariffs where active = true order by effective_from desc limit 1;
    v_revenue := v_count * coalesce(v_fare, 50000);
  else
    v_revenue := v_recorded;
  end if;
  return query select v_count, v_revenue, v_need_tickets, v_need_revenue,
    (v_count >= v_need_tickets or v_revenue >= v_need_revenue);
end; $$;
revoke all on function public.sailing_minimum_status(uuid) from public, anon, service_role;
grant execute on function public.sailing_minimum_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Individual + agent booking paths (extend; do not replace create_booking)
-- ---------------------------------------------------------------------------
-- Any signed-in user with an active profile may book as an individual. No company,
-- no staff role and no privilege are granted by this path.
create or replace function public.create_individual_booking(
  p_request_key         uuid,
  p_outbound_sailing_id uuid,
  p_passenger_count     integer,
  p_contact_name        text,
  p_contact_email       text,
  p_contact_phone       text,
  p_passenger_names     text[] default null,
  p_return_sailing_id   uuid default null,
  p_destination_vessel  text default null,
  p_destination_imo     text default null,
  p_terms_version       text default null
)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid; v_terms text; v_fare bigint;
begin
  v_uid := (select auth.uid());
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'suspended') then
    raise exception 'profile_suspended' using errcode = '28000';
  end if;
  select sp.version into v_terms from public.service_policies as sp
   where sp.policy_type = 'booking_terms' and sp.status = 'provisional' order by sp.effective_from desc limit 1;
  if p_terms_version is null or p_terms_version <> v_terms then
    raise exception 'terms_not_accepted: current booking terms must be accepted' using errcode = '22023';
  end if;
  if p_destination_imo is not null and p_destination_imo !~ '^IMO[0-9]{7}$' then
    raise exception 'invalid IMO number' using errcode = '22023';
  end if;
  select per_person_halala into v_fare from public.tariffs where active = true order by effective_from desc limit 1;
  if v_fare is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;

  -- Reuse the corporate engine for locking, capacity, legs and tickets by
  -- booking through a per-user individual path would duplicate it; instead the
  -- individual flow is implemented here with the same guarantees.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_request_key::text, 0));
  -- Full reservation body is implemented in public._reserve_booking below;
  -- this wrapper validates the individual path then delegates.
  return query select r.booking_id, r.reference, r.status, r.outcome from public._reserve_booking(
    p_request_key, null, 'individual', null, null, null,
    p_outbound_sailing_id, p_passenger_count, p_contact_name, p_contact_email, p_contact_phone,
    p_passenger_names, p_return_sailing_id, null,
    p_destination_vessel, p_destination_imo, null, p_terms_version, true) as r;
  return;
end; $$;
revoke all on function public.create_individual_booking(uuid, uuid, integer, text, text, text, text[], uuid, text, text, text) from public, anon, service_role;
grant execute on function public.create_individual_booking(uuid, uuid, integer, text, text, text, text[], uuid, text, text, text) to authenticated;

-- Booking audit trail (append-only; staff and customers see their own rows).
create table if not exists public.booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  action text not null constraint booking_events_action_check check (action in ('created','amended','cancelled','rescheduled','paid','refunded','terms_accepted')),
  actor_user_id uuid not null references auth.users (id),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.booking_events enable row level security;
drop policy if exists booking_events_select_via_booking on public.booking_events;
create policy booking_events_select_via_booking on public.booking_events for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_events.booking_id));
revoke all on public.booking_events from public, anon, authenticated;
grant select on public.booking_events to authenticated;

-- Shared reservation engine for the individual and agent paths. NOT granted to
-- any app role: only the public wrappers below (SECURITY DEFINER) may call it.
create or replace function public._reserve_booking(
  p_request_key uuid, p_organization_id uuid, p_account_type text,
  p_agent_organization_id uuid, p_client_name text, p_client_reference text,
  p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text,
  p_passenger_names text[], p_return_sailing_id uuid, p_po_reference text,
  p_destination_vessel text, p_destination_imo text, p_permit_status text,
  p_terms_version text, p_terms_required boolean
)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid; v_name text; v_email text; v_phone text; v_po text; v_client text; v_cref text;
  v_dvessel text; v_names text[]; v_extra text; v_hash text; v_existing record;
  v_profile text; v_org text; v_org_type text; v_out record; v_ret record;
  v_ref text; v_id uuid; v_attempt integer := 0; v_constraint text;
  v_terms text; v_fare_each bigint; v_fare_total bigint;
begin
  v_uid := (select auth.uid());
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_request_key is null then raise exception 'invalid request key' using errcode = '22023'; end if;
  if p_account_type not in ('individual', 'agent') then raise exception 'invalid account type' using errcode = '22023'; end if;
  if p_account_type = 'individual' and (p_organization_id is not null or p_agent_organization_id is not null) then
    raise exception 'invalid organization for individual booking' using errcode = '22023'; end if;
  if p_account_type = 'agent' and (p_organization_id is null or p_agent_organization_id is null or p_organization_id <> p_agent_organization_id) then
    raise exception 'invalid agent organization' using errcode = '22023'; end if;
  if p_outbound_sailing_id is null then raise exception 'invalid outbound sailing' using errcode = '22023'; end if;
  if p_return_sailing_id is not null and p_return_sailing_id = p_outbound_sailing_id then
    raise exception 'invalid return sailing: must differ from the outbound sailing' using errcode = '22023'; end if;
  if p_passenger_count is null or p_passenger_count < 1 or p_passenger_count > 1000 then
    raise exception 'invalid passenger count' using errcode = '22023'; end if;
  v_name := nullif(btrim(p_contact_name), '');
  v_email := nullif(lower(btrim(p_contact_email)), '');
  v_phone := nullif(btrim(p_contact_phone), '');
  v_po := nullif(btrim(p_po_reference), '');
  v_client := nullif(btrim(p_client_name), '');
  v_cref := nullif(btrim(p_client_reference), '');
  v_dvessel := nullif(btrim(p_destination_vessel), '');
  if v_name is null or char_length(v_name) > 120 then raise exception 'invalid contact name (required, <= 120 chars)' using errcode = '22023'; end if;
  if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'invalid contact email' using errcode = '22023'; end if;
  if v_phone is null or v_phone !~ '^[+]?[0-9 ()-]{7,20}$' then
    raise exception 'invalid contact phone' using errcode = '22023'; end if;
  if v_po is not null and char_length(v_po) > 64 then raise exception 'invalid po reference (<= 64 chars)' using errcode = '22023'; end if;
  if p_account_type = 'agent' and v_client is null then raise exception 'invalid client name (required for agent bookings)' using errcode = '22023'; end if;
  if v_cref is not null and char_length(v_cref) > 64 then raise exception 'invalid client reference (<= 64 chars)' using errcode = '22023'; end if;
  if v_dvessel is not null and char_length(v_dvessel) > 120 then raise exception 'invalid destination vessel (<= 120 chars)' using errcode = '22023'; end if;
  if p_destination_imo is not null and p_destination_imo !~ '^IMO[0-9]{7}$' then raise exception 'invalid IMO number' using errcode = '22023'; end if;
  if p_permit_status is not null and p_permit_status not in ('not_required', 'pending', 'verified') then
    raise exception 'invalid permit status' using errcode = '22023'; end if;
  v_names := array[v_name];
  if p_passenger_names is not null then
    foreach v_extra in array p_passenger_names loop
      v_extra := nullif(btrim(v_extra), '');
      if v_extra is not null then
        if char_length(v_extra) > 120 then raise exception 'invalid passenger name (<= 120 chars)' using errcode = '22023'; end if;
        v_names := v_names || v_extra;
      end if;
    end loop;
  end if;
  if cardinality(v_names) > p_passenger_count then raise exception 'invalid passenger names: more names than passengers' using errcode = '22023'; end if;
  if p_terms_required then
    select sp.version into v_terms from public.service_policies as sp
     where sp.policy_type = 'booking_terms' and sp.status = 'provisional' order by sp.effective_from desc limit 1;
    if p_terms_version is null or p_terms_version <> v_terms then
      raise exception 'terms_not_accepted: current booking terms must be accepted' using errcode = '22023'; end if;
  end if;
  select per_person_halala into v_fare_each from public.tariffs where active = true order by effective_from desc limit 1;
  if v_fare_each is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;
  v_fare_total := v_fare_each * p_passenger_count * (case when p_return_sailing_id is null then 1 else 2 end);
  v_hash := encode(extensions.digest(jsonb_build_object(
    'account_type', p_account_type, 'organization_id', p_organization_id, 'agent_org', p_agent_organization_id,
    'outbound', p_outbound_sailing_id, 'return', p_return_sailing_id, 'passengers', p_passenger_count,
    'contact_name', v_name, 'contact_email', v_email, 'contact_phone', v_phone, 'names', to_jsonb(v_names),
    'po', v_po, 'client', v_client, 'client_ref', v_cref, 'vessel', v_dvessel, 'imo', p_destination_imo,
    'permit', p_permit_status, 'terms', p_terms_version, 'fare_each', v_fare_each)::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_request_key::text, 0));
  select b.id, b.reference, b.status, b.request_hash into v_existing from public.bookings as b
   where b.created_by = v_uid and b.request_key = p_request_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      raise exception 'payload_mismatch: this request key was already used with different details' using errcode = '22023';
    end if;
    return query select v_existing.id, v_existing.reference, v_existing.status, 'replayed'::text;
    return;
  end if;
  select p.status into v_profile from public.profiles as p where p.id = v_uid for share;
  if found and v_profile = 'suspended' then raise exception 'profile_suspended' using errcode = '28000'; end if;
  if p_account_type = 'agent' then
    if not exists (select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id and m.user_id = v_uid
          and m.status = 'active' and m.membership_role in ('company_admin', 'company_booker')) then
      raise exception 'not_a_member' using errcode = '42501'; end if;
    select o.status, o.account_type into v_org, v_org_type from public.organizations as o where o.id = p_organization_id for share;
    if v_org is distinct from 'approved' then raise exception 'organization_not_approved' using errcode = '42501'; end if;
    if v_org_type is distinct from 'agent' then raise exception 'not_agent_organization' using errcode = '42501'; end if;
  end if;
  perform 1 from public.sailings as s where s.id in (p_outbound_sailing_id, p_return_sailing_id) order by s.id for update;
  select s.id, s.status, s.departs_at, s.seat_capacity, s.seats_booked, r.origin, r.destination into v_out
    from public.sailings as s join public.routes as r on r.id = s.route_id where s.id = p_outbound_sailing_id;
  if not found or v_out.status <> 'open' or v_out.departs_at <= now() then
    raise exception 'sailing_unavailable' using errcode = 'P0001'; end if;
  if v_out.seats_booked + p_passenger_count > v_out.seat_capacity then
    raise exception 'sailing_full' using errcode = 'P0001'; end if;
  if p_return_sailing_id is not null then
    select s.id, s.status, s.departs_at, s.seat_capacity, s.seats_booked, r.origin, r.destination into v_ret
      from public.sailings as s join public.routes as r on r.id = s.route_id where s.id = p_return_sailing_id;
    if not found or v_ret.status <> 'open' or v_ret.departs_at <= now() then
      raise exception 'sailing_unavailable: return' using errcode = 'P0001'; end if;
    if lower(btrim(v_ret.origin)) <> lower(btrim(v_out.destination)) or lower(btrim(v_ret.destination)) <> lower(btrim(v_out.origin)) then
      raise exception 'invalid return sailing' using errcode = '22023'; end if;
    if v_ret.departs_at <= v_out.departs_at then raise exception 'invalid return sailing: must depart after outbound' using errcode = '22023'; end if;
    if v_ret.seats_booked + p_passenger_count > v_ret.seat_capacity then raise exception 'sailing_full: return' using errcode = 'P0001'; end if;
  end if;
  update public.sailings as s set seats_booked = s.seats_booked + p_passenger_count
   where s.id in (p_outbound_sailing_id, p_return_sailing_id);
  loop
    v_attempt := v_attempt + 1;
    v_ref := 'GM-' || upper(encode(extensions.gen_random_bytes(4), 'hex'));
    begin
      insert into public.bookings as b
        (reference, organization_id, account_type, agent_organization_id, client_name, client_reference,
         created_by, request_key, request_hash, status, passenger_count, contact_name, contact_email,
         contact_phone, passenger_names, po_reference, destination_vessel, destination_imo, permit_status,
         terms_version, terms_accepted_at, payment_status, operational_status, fare_halala)
      values
        (v_ref, p_organization_id, p_account_type, p_agent_organization_id, v_client, v_cref,
         v_uid, p_request_key, v_hash, 'reserved', p_passenger_count, v_name, v_email,
         v_phone, v_names, v_po, v_dvessel, p_destination_imo, p_permit_status,
         p_terms_version, now(), 'unpaid', 'awaiting_minimum', v_fare_total)
      returning b.id into v_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bookings_reference_key' or v_attempt >= 5 then raise; end if;
    end;
  end loop;
  insert into public.booking_legs (booking_id, sailing_id, leg, passengers)
  values (v_id, p_outbound_sailing_id, 'outbound', p_passenger_count);
  if p_return_sailing_id is not null then
    insert into public.booking_legs (booking_id, sailing_id, leg, passengers)
    values (v_id, p_return_sailing_id, 'return', p_passenger_count);
  end if;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (v_id, 'created', v_uid, jsonb_build_object('account_type', p_account_type, 'fare_halala', v_fare_total));
  return query select v_id, v_ref, 'reserved'::text, 'created'::text;
  return;
end; $$;
revoke all on function public._reserve_booking(uuid, uuid, text, uuid, text, text, uuid, integer, text, text, text, text[], uuid, text, text, text, text, text, boolean) from public, anon, authenticated, service_role;

create or replace function public.create_agent_booking(
  p_request_key uuid, p_agent_organization_id uuid,
  p_client_name text, p_client_reference text,
  p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text,
  p_passenger_names text[] default null, p_return_sailing_id uuid default null,
  p_po_reference text default null, p_destination_vessel text default null,
  p_destination_imo text default null, p_permit_status text default null,
  p_terms_version text default null
)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.booking_id, r.reference, r.status, r.outcome from public._reserve_booking(
    p_request_key, p_agent_organization_id, 'agent', p_agent_organization_id, p_client_name, p_client_reference,
    p_outbound_sailing_id, p_passenger_count, p_contact_name, p_contact_email, p_contact_phone,
    p_passenger_names, p_return_sailing_id, p_po_reference,
    p_destination_vessel, p_destination_imo, p_permit_status, p_terms_version, true) as r;
  return;
end; $$;
revoke all on function public.create_agent_booking(uuid, uuid, text, text, uuid, integer, text, text, text, text[], uuid, text, text, text, text, text) from public, anon, service_role;
grant execute on function public.create_agent_booking(uuid, uuid, text, text, uuid, integer, text, text, text, text[], uuid, text, text, text, text, text) to authenticated;
