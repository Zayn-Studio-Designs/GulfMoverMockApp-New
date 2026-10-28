-- ===========================================================================
-- 20261101100001 — Phase 8: booking engine completion, minimum-sailing states,
-- holds/expiry, rescheduling, credit foundations, payload, clearance
-- checkpoints (Master's decision, port clearance), suspension, no-shows and a
-- payment-aware boarding gate.
-- ===========================================================================
-- Status model (kept deliberately separate):
--   booking.status          reserved | pending_payment | paid | cancelled | refunded | rescheduled | expired
--   booking.payment_status  unpaid | pending | paid | on_account | partially_refunded | refunded
--   sailing commercial      awaiting_minimum | threshold_met | below_minimum_after_deadline | proceed_below_minimum
--   sailing operational     sailings.status open|closed|suspended|cancelled + checkpoints
--   ticket                  valid | boarded | cancelled | no_show | revoked
-- Reaching the minimum NEVER clears a sailing; clearance is three separate checkpoints.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Shape changes
-- ---------------------------------------------------------------------------
alter table public.bookings
  add column if not exists tariff_id uuid references public.tariffs (id),
  add column if not exists tariff_status text,
  add column if not exists net_halala bigint constraint bookings_net_range check (net_halala is null or net_halala between 0 and 9000000000000),
  add column if not exists vat_halala bigint constraint bookings_vat_range check (vat_halala is null or vat_halala between 0 and 9000000000000),
  add column if not exists total_halala bigint constraint bookings_total_range check (total_halala is null or total_halala between 0 and 9000000000000),
  add column if not exists vat_mode text,
  add column if not exists vat_rate_bp integer,
  add column if not exists hold_expires_at timestamptz,
  add column if not exists settlement_mode text not null default 'pay_now'
    constraint bookings_settlement_mode_check check (settlement_mode in ('pay_now', 'on_account')),
  add column if not exists policy_versions jsonb not null default '{}';

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('reserved', 'pending_payment', 'paid', 'cancelled', 'refunded', 'rescheduled', 'expired'));
alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings add constraint bookings_payment_status_check
  check (payment_status in ('unpaid', 'pending', 'paid', 'on_account', 'refunded', 'partially_refunded'));

alter table public.booking_events alter column actor_user_id drop not null;
comment on column public.booking_events.actor_user_id is 'NULL = automated system job (e.g. hold expiry, verified provider webhook).';
alter table public.booking_events drop constraint if exists booking_events_action_check;
alter table public.booking_events add constraint booking_events_action_check check (action in (
  'created', 'amended', 'cancelled', 'rescheduled', 'paid', 'refunded', 'terms_accepted', 'expired',
  'payment_failed', 'payment_review', 'refund_requested', 'no_show', 'ticket_revoked', 'sailing_decision', 'invoiced'));

alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets add constraint tickets_status_check check (status in ('valid', 'boarded', 'cancelled', 'no_show', 'revoked'));

alter table public.sailings drop constraint if exists sailings_status_check;
alter table public.sailings add constraint sailings_status_check check (status in ('open', 'closed', 'suspended', 'cancelled'));
alter table public.sailings
  add column if not exists master_decision text not null default 'pending'
    constraint sailings_master_decision_check check (master_decision in ('pending', 'go', 'no_go')),
  add column if not exists master_name text constraint sailings_master_name_length check (master_name is null or char_length(master_name) <= 120),
  add column if not exists port_clearance_status text not null default 'pending'
    constraint sailings_port_clearance_check check (port_clearance_status in ('pending', 'cleared', 'refused', 'not_required')),
  add column if not exists port_clearance_ref text constraint sailings_port_clearance_ref_length check (port_clearance_ref is null or char_length(port_clearance_ref) <= 120),
  add column if not exists commercial_decision text not null default 'none'
    constraint sailings_commercial_decision_check check (commercial_decision in ('none', 'proceed_below_minimum')),
  add column if not exists payload_capacity_kg integer constraint sailings_payload_capacity_range check (payload_capacity_kg is null or payload_capacity_kg between 0 and 1000000),
  add column if not exists payload_booked_kg integer not null default 0 constraint sailings_payload_booked_range check (payload_booked_kg >= 0);

alter table public.vessels
  add column if not exists payload_capacity_kg integer constraint vessels_payload_capacity_range check (payload_capacity_kg is null or payload_capacity_kg between 0 and 1000000);

-- Credit foundations (limits set only by ATCO Finance; see migration ...0003).
alter table public.organizations
  add column if not exists credit_status text not null default 'none'
    constraint organizations_credit_status_check check (credit_status in ('none', 'active', 'on_hold')),
  add column if not exists credit_hold_reason text constraint organizations_credit_hold_reason_length check (credit_hold_reason is null or char_length(credit_hold_reason) <= 500);

drop trigger if exists trg_audit_config on public.organizations;
create trigger trg_audit_config after update of account_type, credit_limit_halala, payment_terms_days, credit_status, credit_hold_reason
  on public.organizations for each row execute function public.audit_config_change();

create table if not exists public.sailing_checkpoint_events (
  id            uuid primary key default gen_random_uuid(),
  sailing_id    uuid not null references public.sailings (id) on delete cascade,
  checkpoint    text not null constraint sailing_checkpoint_events_checkpoint_check check (checkpoint in (
                  'master_decision', 'port_clearance', 'suspension', 'resumption', 'cancellation', 'minimum_decision', 'no_show_sweep')),
  status        text not null,
  reason        text not null constraint sailing_checkpoint_events_reason_length check (char_length(reason) between 1 and 500),
  reference     text,
  actor_user_id uuid references auth.users (id),
  created_at    timestamptz not null default now()
);
create index if not exists sailing_checkpoint_events_sailing_idx on public.sailing_checkpoint_events (sailing_id, created_at desc);
alter table public.sailing_checkpoint_events enable row level security;
drop policy if exists sailing_checkpoint_events_staff on public.sailing_checkpoint_events;
create policy sailing_checkpoint_events_staff on public.sailing_checkpoint_events for select to authenticated
  using (public.has_platform_role('{super_admin,operations,boarding_staff}'));
revoke all on public.sailing_checkpoint_events from public, anon, authenticated, service_role;
grant select on public.sailing_checkpoint_events to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Server-side pricing of every booking (all creation paths)
-- ---------------------------------------------------------------------------
-- Prices a booking from its persisted legs and the tariff applicable to the
-- outbound departure. Never runs once money has moved.
create or replace function public._price_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype; v_route uuid; v_at timestamptz; v_t public.tariffs; v_legs integer; v_x record;
begin
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found or v_b.payment_status <> 'unpaid' then return; end if;
  if exists (select 1 from public.payments p where p.booking_id = p_booking_id) then return; end if;
  select s.route_id, s.departs_at into v_route, v_at
    from public.booking_legs l join public.sailings s on s.id = l.sailing_id
   where l.booking_id = p_booking_id and l.leg = 'outbound';
  if not found then return; end if;
  select count(*) into v_legs from public.booking_legs where booking_id = p_booking_id;
  v_t := public.applicable_tariff(v_route, v_at);
  if v_t.id is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;
  select * into v_x from public.vat_breakdown(v_t.per_person_halala * v_b.passenger_count * v_legs, v_t.vat_mode, coalesce(v_t.vat_rate_bp, 0));
  update public.bookings set tariff_id = v_t.id, tariff_status = v_t.approval_status,
    net_halala = v_x.net_halala, vat_halala = v_x.vat_halala, total_halala = v_x.gross_halala,
    fare_halala = v_x.gross_halala, vat_mode = v_t.vat_mode, vat_rate_bp = coalesce(v_t.vat_rate_bp, 0)
   where id = p_booking_id;
end; $$;
revoke all on function public._price_booking(uuid) from public, anon, authenticated, service_role;

create or replace function public.trg_price_booking_after_leg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public._price_booking(new.booking_id);
  return new;
end; $$;
revoke all on function public.trg_price_booking_after_leg() from public, anon, authenticated, service_role;
drop trigger if exists trg_price_booking on public.booking_legs;
create trigger trg_price_booking after insert on public.booking_legs
  for each row execute function public.trg_price_booking_after_leg();

-- Pay-now reservations hold seats for a limited time (set on insert, every path).
create or replace function public.trg_booking_hold()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.settlement_mode = 'pay_now' and new.hold_expires_at is null and new.payment_status = 'unpaid' then
    new.hold_expires_at := now() + make_interval(mins => public.setting_int('booking.payment_hold_minutes', 30));
  end if;
  return new;
end; $$;
revoke all on function public.trg_booking_hold() from public, anon, authenticated, service_role;
drop trigger if exists trg_booking_hold on public.bookings;
create trigger trg_booking_hold before insert on public.bookings
  for each row execute function public.trg_booking_hold();

-- Backfill: price existing bookings without a breakdown. Pre-Phase-8 bookings
-- keep their recorded fare; no hold is applied retroactively (existing seats preserved).
update public.bookings b set
  tariff_id = coalesce(b.tariff_id, (select t.id from public.tariffs t where t.code = 'BASE-2026-ATCO-PENDING')),
  tariff_status = coalesce(b.tariff_status, 'provisional'),
  total_halala = coalesce(b.fare_halala, (select t.per_person_halala from public.tariffs t where t.code = 'BASE-2026-ATCO-PENDING')
                   * b.passenger_count * (select count(*) from public.booking_legs l where l.booking_id = b.id)),
  vat_halala = 0, vat_mode = 'not_configured', vat_rate_bp = 0
 where b.total_halala is null;
update public.bookings set net_halala = total_halala, fare_halala = coalesce(fare_halala, total_halala) where net_halala is null;

-- ---------------------------------------------------------------------------
-- 3. Credit availability (used by on-account bookings)
-- ---------------------------------------------------------------------------
create or replace function public._credit_position(p_org uuid)
returns table (credit_status text, credit_limit_halala bigint, outstanding_halala bigint,
               overdue_halala bigint, available_halala bigint, payment_terms_days integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_o record; v_out bigint := 0; v_over bigint := 0;
begin
  select o.credit_status, o.credit_limit_halala, o.payment_terms_days into v_o from public.organizations o where o.id = p_org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select coalesce(sum(i.total_halala - i.amount_paid_halala), 0),
         coalesce(sum(i.total_halala - i.amount_paid_halala) filter (where i.due_date < (now() at time zone 'Asia/Riyadh')::date), 0)
    into v_out, v_over
    from public.invoices i
   where i.organization_id = p_org and i.settlement_mode = 'on_account' and i.status in ('issued', 'partially_paid');
  return query select v_o.credit_status, v_o.credit_limit_halala, v_out, v_over,
    greatest(coalesce(v_o.credit_limit_halala, 0) - v_out, 0), v_o.payment_terms_days;
end; $$;
revoke all on function public._credit_position(uuid) from public, anon, authenticated, service_role;

-- Finance and the organization's own admins may read the position; nobody else.
create or replace function public.organization_credit_position(p_org uuid)
returns table (credit_status text, credit_limit_halala bigint, outstanding_halala bigint,
               overdue_halala bigint, available_halala bigint, payment_terms_days integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.has_platform_role('{super_admin,finance}') or public.has_org_role(p_org, '{company_admin}')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return query select * from public._credit_position(p_org);
end; $$;
revoke all on function public.organization_credit_position(uuid) from public, anon, service_role;
grant execute on function public.organization_credit_position(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Reservation engine v2 (corporate + individual + agent, pay-now or on-account)
-- ---------------------------------------------------------------------------
create or replace function public._reserve_booking_v2(
  p_request_key uuid, p_organization_id uuid, p_account_type text,
  p_client_name text, p_client_reference text,
  p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text,
  p_passenger_names text[], p_return_sailing_id uuid, p_po_reference text,
  p_destination_vessel text, p_destination_imo text, p_permit_status text,
  p_terms_version text, p_terms_required boolean, p_settlement_mode text
)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid; v_name text; v_email text; v_phone text; v_po text; v_client text; v_cref text;
  v_dvessel text; v_names text[]; v_extra text; v_hash text; v_existing record;
  v_profile text; v_org record; v_out record; v_ret record;
  v_ref text; v_id uuid; v_attempt integer := 0; v_constraint text;
  v_terms text; v_quote record; v_credit record; v_allow integer; v_policies jsonb;
begin
  v_uid := (select auth.uid());
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_request_key is null then raise exception 'invalid request key' using errcode = '22023'; end if;
  if p_account_type not in ('individual', 'agent', 'corporate') then raise exception 'invalid account type' using errcode = '22023'; end if;
  if p_settlement_mode is null or p_settlement_mode not in ('pay_now', 'on_account') then raise exception 'invalid settlement mode' using errcode = '22023'; end if;
  if p_account_type = 'individual' and (p_organization_id is not null or p_settlement_mode <> 'pay_now') then
    raise exception 'invalid organization for individual booking' using errcode = '22023'; end if;
  if p_account_type in ('agent', 'corporate') and p_organization_id is null then
    raise exception 'invalid organization' using errcode = '22023'; end if;
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
  if v_phone is null or v_phone !~ '^[+]?[0-9 ()-]{7,20}$' then raise exception 'invalid contact phone' using errcode = '22023'; end if;
  if v_po is not null and char_length(v_po) > 64 then raise exception 'invalid po reference (<= 64 chars)' using errcode = '22023'; end if;
  if p_account_type = 'agent' and v_client is null then raise exception 'invalid client name (required for agent bookings)' using errcode = '22023'; end if;
  if p_account_type <> 'agent' and (v_client is not null or v_cref is not null) then raise exception 'invalid client fields' using errcode = '22023'; end if;
  if v_client is not null and char_length(v_client) > 120 then raise exception 'invalid client name' using errcode = '22023'; end if;
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
     where sp.policy_type = 'booking_terms' and sp.status in ('approved', 'provisional')
     order by (sp.status = 'approved') desc, sp.effective_from desc limit 1;
    if p_terms_version is null or p_terms_version <> v_terms then
      raise exception 'terms_not_accepted: current booking terms must be accepted' using errcode = '22023'; end if;
  end if;
  -- Record every policy version in force at acceptance time.
  select coalesce(jsonb_object_agg(x.policy_type, x.version), '{}') into v_policies from (
    select distinct on (sp.policy_type) sp.policy_type, sp.version from public.service_policies sp
     where sp.status in ('approved', 'provisional')
     order by sp.policy_type, (sp.status = 'approved') desc, sp.effective_from desc) x;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'account_type', p_account_type, 'organization_id', p_organization_id, 'settlement', p_settlement_mode,
    'outbound', p_outbound_sailing_id, 'return', p_return_sailing_id, 'passengers', p_passenger_count,
    'contact_name', v_name, 'contact_email', v_email, 'contact_phone', v_phone, 'names', to_jsonb(v_names),
    'po', v_po, 'client', v_client, 'client_ref', v_cref, 'vessel', v_dvessel, 'imo', p_destination_imo,
    'permit', p_permit_status, 'terms', p_terms_version)::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_request_key::text, 0));
  select b.id, b.reference, b.status, b.request_hash into v_existing from public.bookings as b
   where b.created_by = v_uid and b.request_key = p_request_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      raise exception 'payload_mismatch: this request key was already used with different details' using errcode = '22023'; end if;
    return query select v_existing.id, v_existing.reference, v_existing.status, 'replayed'::text;
    return;
  end if;

  select p.status into v_profile from public.profiles as p where p.id = v_uid for share;
  if found and v_profile = 'suspended' then raise exception 'profile_suspended' using errcode = '28000'; end if;
  if p_account_type in ('agent', 'corporate') then
    if not exists (select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id and m.user_id = v_uid
          and m.status = 'active' and m.membership_role in ('company_admin', 'company_booker')) then
      raise exception 'not_a_member' using errcode = '42501'; end if;
    select o.status, o.account_type, o.credit_status, o.credit_limit_halala, o.payment_terms_days into v_org
      from public.organizations as o where o.id = p_organization_id for update;
    if v_org.status is distinct from 'approved' then raise exception 'organization_not_approved' using errcode = '42501'; end if;
    if p_account_type = 'agent' and v_org.account_type is distinct from 'agent' then raise exception 'not_agent_organization' using errcode = '42501'; end if;
    if p_account_type = 'corporate' and v_org.account_type is distinct from 'corporate' then raise exception 'not_corporate_organization' using errcode = '42501'; end if;
  end if;
  perform 1 from public.sailings as s where s.id in (p_outbound_sailing_id, p_return_sailing_id) order by s.id for update;
  select s.id, s.status, s.departs_at, s.seat_capacity, s.seats_booked, s.payload_capacity_kg, s.payload_booked_kg, r.origin, r.destination into v_out
    from public.sailings as s join public.routes as r on r.id = s.route_id where s.id = p_outbound_sailing_id;
  if not found or v_out.status <> 'open' or v_out.departs_at <= now() then raise exception 'sailing_unavailable' using errcode = 'P0001'; end if;
  if v_out.seats_booked + p_passenger_count > v_out.seat_capacity then raise exception 'sailing_full' using errcode = 'P0001'; end if;
  v_allow := public.setting_int('payload.passenger_allowance_kg', null);
  if v_allow is not null and v_out.payload_capacity_kg is not null
     and v_out.payload_booked_kg + (v_out.seats_booked + p_passenger_count) * v_allow > v_out.payload_capacity_kg then
    raise exception 'payload_exceeded' using errcode = 'P0001'; end if;
  if p_return_sailing_id is not null then
    select s.id, s.status, s.departs_at, s.seat_capacity, s.seats_booked, s.payload_capacity_kg, s.payload_booked_kg, r.origin, r.destination into v_ret
      from public.sailings as s join public.routes as r on r.id = s.route_id where s.id = p_return_sailing_id;
    if not found or v_ret.status <> 'open' or v_ret.departs_at <= now() then raise exception 'sailing_unavailable: return' using errcode = 'P0001'; end if;
    if lower(btrim(v_ret.origin)) <> lower(btrim(v_out.destination)) or lower(btrim(v_ret.destination)) <> lower(btrim(v_out.origin)) then
      raise exception 'invalid return sailing' using errcode = '22023'; end if;
    if v_ret.departs_at <= v_out.departs_at then raise exception 'invalid return sailing: must depart after outbound' using errcode = '22023'; end if;
    if v_ret.seats_booked + p_passenger_count > v_ret.seat_capacity then raise exception 'sailing_full: return' using errcode = 'P0001'; end if;
    if v_allow is not null and v_ret.payload_capacity_kg is not null
       and v_ret.payload_booked_kg + (v_ret.seats_booked + p_passenger_count) * v_allow > v_ret.payload_capacity_kg then
      raise exception 'payload_exceeded: return' using errcode = 'P0001'; end if;
  end if;
  select * into v_quote from public.quote_passenger_fare(p_outbound_sailing_id, p_return_sailing_id, p_passenger_count);
  if p_settlement_mode = 'on_account' then
    if v_org.credit_status <> 'active' or v_org.credit_limit_halala is null or v_org.payment_terms_days is null then
      raise exception 'credit_not_available: this organization has no active credit facility' using errcode = '42501'; end if;
    select * into v_credit from public._credit_position(p_organization_id);
    if v_credit.overdue_halala > 0 then raise exception 'credit_on_hold: overdue balance must be settled first' using errcode = '42501'; end if;
    if v_credit.outstanding_halala + v_quote.total_halala > v_org.credit_limit_halala then
      raise exception 'credit_limit_exceeded' using errcode = '42501'; end if;
  end if;
  update public.sailings as s set seats_booked = s.seats_booked + p_passenger_count where s.id in (p_outbound_sailing_id, p_return_sailing_id);
  loop
    v_attempt := v_attempt + 1;
    v_ref := 'GM-' || upper(encode(extensions.gen_random_bytes(4), 'hex'));
    begin
      insert into public.bookings as b
        (reference, organization_id, account_type, agent_organization_id, client_name, client_reference,
         created_by, request_key, request_hash, status, passenger_count, contact_name, contact_email,
         contact_phone, passenger_names, po_reference, destination_vessel, destination_imo, permit_status,
         terms_version, terms_accepted_at, payment_status, operational_status, settlement_mode, policy_versions)
      values
        (v_ref, p_organization_id, p_account_type, case when p_account_type = 'agent' then p_organization_id end, v_client, v_cref,
         v_uid, p_request_key, v_hash, 'reserved', p_passenger_count, v_name, v_email,
         v_phone, v_names, v_po, v_dvessel, p_destination_imo, p_permit_status,
         p_terms_version, case when p_terms_version is not null then now() end, 'unpaid', 'awaiting_minimum',
         p_settlement_mode, v_policies)
      returning b.id into v_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bookings_reference_key' or v_attempt >= 5 then raise; end if;
    end;
  end loop;
  insert into public.booking_legs (booking_id, sailing_id, leg, passengers) values (v_id, p_outbound_sailing_id, 'outbound', p_passenger_count);
  if p_return_sailing_id is not null then
    insert into public.booking_legs (booking_id, sailing_id, leg, passengers) values (v_id, p_return_sailing_id, 'return', p_passenger_count);
  end if;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (v_id, 'created', v_uid, jsonb_build_object('account_type', p_account_type, 'settlement_mode', p_settlement_mode,
          'total_halala', v_quote.total_halala, 'tariff_id', v_quote.tariff_id, 'policies', v_policies));
  if p_terms_version is not null then
    insert into public.booking_events (booking_id, action, actor_user_id, details)
    values (v_id, 'terms_accepted', v_uid, jsonb_build_object('version', p_terms_version));
  end if;
  if p_settlement_mode = 'on_account' then
    update public.bookings set payment_status = 'on_account', hold_expires_at = null where id = v_id;
    perform public._issue_booking_invoice(v_id, null);
  end if;
  return query select v_id, v_ref, 'reserved'::text, 'created'::text;
  return;
end; $$;
revoke all on function public._reserve_booking_v2(uuid, uuid, text, text, text, uuid, integer, text, text, text, text[], uuid, text, text, text, text, text, boolean, text) from public, anon, authenticated, service_role;

-- Public wrappers (unchanged signatures for individual + agent; new corporate path).
create or replace function public.create_individual_booking(
  p_request_key uuid, p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text,
  p_passenger_names text[] default null, p_return_sailing_id uuid default null,
  p_destination_vessel text default null, p_destination_imo text default null,
  p_terms_version text default null)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.booking_id, r.reference, r.status, r.outcome from public._reserve_booking_v2(
    p_request_key, null, 'individual', null, null, p_outbound_sailing_id, p_passenger_count,
    p_contact_name, p_contact_email, p_contact_phone, p_passenger_names, p_return_sailing_id, null,
    p_destination_vessel, p_destination_imo, null, p_terms_version, true, 'pay_now') as r;
end; $$;

create or replace function public.create_agent_booking(
  p_request_key uuid, p_agent_organization_id uuid, p_client_name text, p_client_reference text,
  p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text,
  p_passenger_names text[] default null, p_return_sailing_id uuid default null,
  p_po_reference text default null, p_destination_vessel text default null,
  p_destination_imo text default null, p_permit_status text default null, p_terms_version text default null)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.booking_id, r.reference, r.status, r.outcome from public._reserve_booking_v2(
    p_request_key, p_agent_organization_id, 'agent', p_client_name, p_client_reference,
    p_outbound_sailing_id, p_passenger_count, p_contact_name, p_contact_email, p_contact_phone,
    p_passenger_names, p_return_sailing_id, p_po_reference, p_destination_vessel, p_destination_imo,
    p_permit_status, p_terms_version, true, 'pay_now') as r;
end; $$;

create or replace function public.create_organization_booking(
  p_request_key uuid, p_organization_id uuid, p_outbound_sailing_id uuid, p_passenger_count integer,
  p_contact_name text, p_contact_email text, p_contact_phone text, p_terms_version text,
  p_settlement_mode text default 'pay_now', p_passenger_names text[] default null,
  p_return_sailing_id uuid default null, p_po_reference text default null,
  p_client_name text default null, p_client_reference text default null,
  p_destination_vessel text default null, p_destination_imo text default null, p_permit_status text default null)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  select o.account_type into v_type from public.organizations o where o.id = p_organization_id;
  if v_type is null then raise exception 'not_a_member' using errcode = '42501'; end if;
  return query select r.booking_id, r.reference, r.status, r.outcome from public._reserve_booking_v2(
    p_request_key, p_organization_id, v_type, p_client_name, p_client_reference,
    p_outbound_sailing_id, p_passenger_count, p_contact_name, p_contact_email, p_contact_phone,
    p_passenger_names, p_return_sailing_id, p_po_reference, p_destination_vessel, p_destination_imo,
    p_permit_status, p_terms_version, true, coalesce(p_settlement_mode, 'pay_now')) as r;
end; $$;
revoke all on function public.create_organization_booking(uuid, uuid, uuid, integer, text, text, text, text, text, text[], uuid, text, text, text, text, text, text) from public, anon, service_role;
grant execute on function public.create_organization_booking(uuid, uuid, uuid, integer, text, text, text, text, text, text[], uuid, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Minimum-sailing evaluation across ALL bookings on a sailing
-- ---------------------------------------------------------------------------
create or replace function public.sailing_commercial_status(p_sailing_id uuid)
returns table (reserved_tickets bigint, qualifying_tickets bigint, qualifying_revenue_halala bigint,
               threshold_tickets integer, threshold_revenue_halala bigint, threshold_met boolean,
               confirmation_deadline timestamptz, commercial_state text, counting_basis text)
language plpgsql stable security definer set search_path = '' as $$
declare v_s record; v_basis text; v_need_t integer; v_need_r bigint; v_res bigint; v_q bigint; v_rev bigint; v_deadline timestamptz; v_met boolean;
begin
  if p_sailing_id is null then raise exception 'invalid sailing' using errcode = '22023'; end if;
  select s.departs_at, s.commercial_decision into v_s from public.sailings s where s.id = p_sailing_id;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  v_basis := public.setting_text('sailing.minimum_counts', 'paid_and_on_account');
  v_need_t := public.setting_int('sailing.minimum_tickets', 4);
  v_need_r := coalesce((select (value ->> 'value')::bigint from public.platform_settings where key = 'sailing.minimum_revenue_halala'), 200000);
  select count(*) into v_res from public.tickets t join public.bookings b on b.id = t.booking_id
   where t.sailing_id = p_sailing_id and t.status in ('valid', 'boarded') and b.status not in ('cancelled', 'expired', 'refunded');
  -- Qualifying tickets and per-leg net revenue (booking net split evenly across its legs).
  select count(*), coalesce(sum(x.leg_net / greatest(x.pax, 1)), 0) into v_q, v_rev from (
    select t.id, b.passenger_count as pax,
      (coalesce(b.net_halala, 0) / greatest((select count(*) from public.booking_legs l2 where l2.booking_id = b.id), 1)) as leg_net
      from public.tickets t join public.bookings b on b.id = t.booking_id
     where t.sailing_id = p_sailing_id and t.status in ('valid', 'boarded')
       and b.status not in ('cancelled', 'expired', 'refunded')
       and (v_basis = 'all_reserved' or b.payment_status in ('paid', 'on_account', 'partially_refunded'))) x;
  v_met := v_q >= v_need_t or v_rev >= v_need_r;
  v_deadline := v_s.departs_at - make_interval(hours => public.setting_int('booking.confirmation_deadline_hours', 24));
  return query select v_res, v_q, v_rev, v_need_t, v_need_r, v_met, v_deadline,
    case when v_met then 'threshold_met'
         when v_s.commercial_decision = 'proceed_below_minimum' then 'proceed_below_minimum'
         when now() >= v_deadline then 'below_minimum_after_deadline'
         else 'awaiting_minimum' end,
    v_basis;
end; $$;
revoke all on function public.sailing_commercial_status(uuid) from public, anon, service_role;
grant execute on function public.sailing_commercial_status(uuid) to authenticated;

-- Keep the Phase 7 signature; it now reflects the configured counting basis.
create or replace function public.sailing_minimum_status(p_sailing_id uuid)
returns table (ticket_count bigint, revenue_halala bigint, threshold_tickets integer, threshold_revenue_halala bigint, threshold_met boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query select c.qualifying_tickets, c.qualifying_revenue_halala, c.threshold_tickets, c.threshold_revenue_halala, c.threshold_met
    from public.sailing_commercial_status(p_sailing_id) c;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Staff operational decisions (each audited with who/when/why)
-- ---------------------------------------------------------------------------
create or replace function public._require_staff(p_roles text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id = auth.uid() for share;
  perform 1 from public.role_assignments where user_id = auth.uid() and organization_id is null for share;
  if not public.has_platform_role(p_roles) then raise exception 'not authorized' using errcode = '42501'; end if;
end; $$;
revoke all on function public._require_staff(text[]) from public, anon, authenticated, service_role;

create or replace function public._valid_reason(p_reason text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'invalid input: a reason (<= 500 chars) is required' using errcode = '22023'; end if;
  return btrim(p_reason);
end; $$;

-- The Master's go/no-go is recorded by operations on the Master's instruction.
create or replace function public.record_master_decision(p_sailing_id uuid, p_decision text, p_master_name text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_s record;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  if p_decision is null or p_decision not in ('pending', 'go', 'no_go') then raise exception 'invalid decision' using errcode = '22023'; end if;
  if p_decision <> 'pending' and (nullif(btrim(p_master_name), '') is null or char_length(btrim(p_master_name)) > 120) then
    raise exception 'master name required' using errcode = '22023'; end if;
  select status, master_decision into v_s from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  if v_s.status = 'cancelled' then raise exception 'invalid_transition: cancelled sailing' using errcode = '55000'; end if;
  update public.sailings set master_decision = p_decision, master_name = nullif(btrim(p_master_name), '') where id = p_sailing_id;
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, reference, actor_user_id)
  values (p_sailing_id, 'master_decision', p_decision, v_reason, nullif(btrim(p_master_name), ''), auth.uid());
  return 'recorded';
end; $$;

create or replace function public.record_port_clearance(p_sailing_id uuid, p_status text, p_reference text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_status text;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  if p_status is null or p_status not in ('pending', 'cleared', 'refused', 'not_required') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_reference is not null and char_length(btrim(p_reference)) > 120 then raise exception 'invalid reference' using errcode = '22023'; end if;
  select status into v_status from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  if v_status = 'cancelled' then raise exception 'invalid_transition: cancelled sailing' using errcode = '55000'; end if;
  update public.sailings set port_clearance_status = p_status, port_clearance_ref = nullif(btrim(p_reference), '') where id = p_sailing_id;
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, reference, actor_user_id)
  values (p_sailing_id, 'port_clearance', p_status, v_reason, nullif(btrim(p_reference), ''), auth.uid());
  return 'recorded';
end; $$;

create or replace function public.suspend_sailing(p_sailing_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_status text; v_user uuid;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  select status into v_status from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  if v_status = 'suspended' then return 'unchanged'; end if;
  if v_status = 'cancelled' then raise exception 'invalid_transition: cancelled sailing' using errcode = '55000'; end if;
  update public.sailings set status = 'suspended' where id = p_sailing_id;
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, actor_user_id)
  values (p_sailing_id, 'suspension', 'suspended', v_reason, auth.uid());
  for v_user in select distinct b.created_by from public.bookings b join public.booking_legs l on l.booking_id = b.id
                 where l.sailing_id = p_sailing_id and b.status not in ('cancelled', 'expired') loop
    perform public.emit_notification(v_user, 'sailing_suspended:' || p_sailing_id || ':' || extract(epoch from now())::bigint, 'sailing_suspended', '/bookings');
  end loop;
  return 'suspended';
end; $$;

create or replace function public.resume_sailing(p_sailing_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_status text; v_user uuid;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  select status into v_status from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  if v_status <> 'suspended' then raise exception 'invalid_transition: only suspended sailings can resume' using errcode = '55000'; end if;
  update public.sailings set status = 'open' where id = p_sailing_id;
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, actor_user_id)
  values (p_sailing_id, 'resumption', 'open', v_reason, auth.uid());
  for v_user in select distinct b.created_by from public.bookings b join public.booking_legs l on l.booking_id = b.id
                 where l.sailing_id = p_sailing_id and b.status not in ('cancelled', 'expired') loop
    perform public.emit_notification(v_user, 'sailing_resumed:' || p_sailing_id || ':' || extract(epoch from now())::bigint, 'sailing_resumed', '/bookings');
  end loop;
  return 'resumed';
end; $$;

-- Cancelling a sailing never refunds automatically: affected paid bookings get
-- a refund request in pending_review for Finance (policy-gated approval).
create or replace function public.cancel_sailing(p_sailing_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_status text; v_b record; v_n integer := 0;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  select status into v_status from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  if v_status = 'cancelled' then return 0; end if;
  if exists (select 1 from public.tickets where sailing_id = p_sailing_id and status = 'boarded') then
    raise exception 'invalid_transition: passengers already boarded' using errcode = '55000'; end if;
  update public.sailings set status = 'cancelled' where id = p_sailing_id;
  update public.tickets set status = 'cancelled' where sailing_id = p_sailing_id and status = 'valid';
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, actor_user_id)
  values (p_sailing_id, 'cancellation', 'cancelled', v_reason, auth.uid());
  for v_b in select distinct b.id, b.created_by, b.reference, b.payment_status from public.bookings b
               join public.booking_legs l on l.booking_id = b.id
              where l.sailing_id = p_sailing_id and b.status not in ('cancelled', 'expired', 'refunded') loop
    update public.bookings set operational_status = 'cancelled' where id = v_b.id;
    insert into public.booking_events (booking_id, action, actor_user_id, details)
    values (v_b.id, 'sailing_decision', auth.uid(), jsonb_build_object('sailing_id', p_sailing_id, 'decision', 'sailing_cancelled', 'reason', v_reason));
    if v_b.payment_status in ('paid', 'partially_refunded') then
      perform public._open_refund_review(v_b.id, 'Sailing cancelled: ' || v_reason);
    end if;
    perform public.emit_notification(v_b.created_by, 'sailing_cancelled:' || p_sailing_id || ':' || v_b.id, 'sailing_cancelled', '/bookings/' || v_b.reference);
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;

-- Below-minimum decision after the deadline: proceed anyway (ATCO decision) or cancel.
create or replace function public.decide_sailing_minimum(p_sailing_id uuid, p_decision text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  if p_decision is null or p_decision not in ('proceed_below_minimum', 'cancel') then raise exception 'invalid decision' using errcode = '22023'; end if;
  perform 1 from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, actor_user_id)
  values (p_sailing_id, 'minimum_decision', p_decision, v_reason, auth.uid());
  if p_decision = 'proceed_below_minimum' then
    update public.sailings set commercial_decision = 'proceed_below_minimum' where id = p_sailing_id;
    return 'recorded';
  end if;
  perform public.cancel_sailing(p_sailing_id, 'Minimum not met: ' || v_reason);
  return 'cancelled';
end; $$;

-- After departure, unboarded valid tickets are recorded as no-shows (no fee implied).
create or replace function public.record_no_shows(p_sailing_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_dep timestamptz; v_n integer;
begin
  perform public._require_staff('{super_admin,operations,boarding_staff}');
  v_reason := public._valid_reason(p_reason);
  select departs_at into v_dep from public.sailings where id = p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  if v_dep > now() then raise exception 'invalid_transition: sailing has not departed' using errcode = '55000'; end if;
  update public.tickets set status = 'no_show' where sailing_id = p_sailing_id and status = 'valid';
  get diagnostics v_n = row_count;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
    select distinct t.booking_id, 'no_show', auth.uid(), jsonb_build_object('sailing_id', p_sailing_id, 'reason', v_reason)
      from public.tickets t where t.sailing_id = p_sailing_id and t.status = 'no_show'
       and not exists (select 1 from public.booking_events e where e.booking_id = t.booking_id and e.action = 'no_show' and e.details ->> 'sailing_id' = p_sailing_id::text);
  insert into public.sailing_checkpoint_events (sailing_id, checkpoint, status, reason, actor_user_id)
  values (p_sailing_id, 'no_show_sweep', v_n::text, v_reason, auth.uid());
  return v_n;
end; $$;

create or replace function public.revoke_ticket(p_ticket_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_t public.tickets%rowtype;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  select * into v_t from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_t.status = 'revoked' then return 'unchanged'; end if;
  if v_t.status <> 'valid' then raise exception 'invalid_transition: only valid tickets can be revoked' using errcode = '55000'; end if;
  update public.tickets set status = 'revoked' where id = p_ticket_id;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (v_t.booking_id, 'ticket_revoked', auth.uid(), jsonb_build_object('ticket', v_t.reference, 'reason', v_reason));
  return 'revoked';
end; $$;

-- Reschedule one leg to another sailing on the same route. Seats move atomically;
-- the leg's tickets get new references and QR secrets, so old tickets stop working.
create or replace function public.reschedule_booking_leg(p_booking_id uuid, p_leg text, p_new_sailing_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_b public.bookings%rowtype; v_l public.booking_legs%rowtype; v_old record; v_new record;
  v_staff boolean; v_cutoff integer; v_other record; v_old_refs jsonb;
begin
  v_reason := public._valid_reason(p_reason);
  if p_leg is null or p_leg not in ('outbound', 'return') or p_new_sailing_id is null then raise exception 'invalid input' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  v_staff := public.has_platform_role('{super_admin,operations}');
  if not (v_staff or v_b.created_by = auth.uid()
          or (v_b.organization_id is not null and public.has_org_role(v_b.organization_id, '{company_admin}'))) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_b.status in ('cancelled', 'expired', 'refunded') then raise exception 'invalid_transition: booking is closed' using errcode = '55000'; end if;
  select * into v_l from public.booking_legs where booking_id = p_booking_id and leg = p_leg for update;
  if not found then raise exception 'leg not found' using errcode = 'P0002'; end if;
  if v_l.sailing_id = p_new_sailing_id then return 'unchanged'; end if;
  if exists (select 1 from public.tickets where booking_leg_id = v_l.id and status not in ('valid', 'cancelled')) then
    raise exception 'invalid_transition: tickets already used' using errcode = '55000'; end if;
  perform 1 from public.sailings where id in (v_l.sailing_id, p_new_sailing_id) order by id for update;
  select s.departs_at, s.route_id into v_old from public.sailings s where s.id = v_l.sailing_id;
  select s.departs_at, s.route_id, s.status, s.seat_capacity, s.seats_booked into v_new from public.sailings s where s.id = p_new_sailing_id;
  if not found or v_new.status <> 'open' or v_new.departs_at <= now() then raise exception 'sailing_unavailable' using errcode = 'P0001'; end if;
  if v_new.route_id <> v_old.route_id then raise exception 'invalid sailing: different route' using errcode = '22023'; end if;
  if v_new.seats_booked + v_l.passengers > v_new.seat_capacity then raise exception 'sailing_full' using errcode = 'P0001'; end if;
  if not v_staff then
    v_cutoff := public.setting_int('booking.customer_change_cutoff_hours', 24);
    if v_old.departs_at - make_interval(hours => v_cutoff) <= now() then
      raise exception 'change_window_closed: contact ATCO operations' using errcode = '55000'; end if;
  end if;
  -- Legs must stay in order (outbound before return).
  select s.departs_at into v_other from public.booking_legs l join public.sailings s on s.id = l.sailing_id
   where l.booking_id = p_booking_id and l.leg <> p_leg;
  if found and ((p_leg = 'outbound' and v_new.departs_at >= v_other.departs_at) or (p_leg = 'return' and v_new.departs_at <= v_other.departs_at)) then
    raise exception 'invalid sailing: outbound must depart before return' using errcode = '22023'; end if;
  update public.sailings set seats_booked = greatest(0, seats_booked - v_l.passengers) where id = v_l.sailing_id;
  update public.sailings set seats_booked = seats_booked + v_l.passengers where id = p_new_sailing_id;
  update public.booking_legs set sailing_id = p_new_sailing_id where id = v_l.id;
  select coalesce(jsonb_agg(reference), '[]') into v_old_refs from public.tickets where booking_leg_id = v_l.id and status = 'valid';
  update public.tickets set sailing_id = p_new_sailing_id,
         reference = 'TK-' || upper(encode(extensions.gen_random_bytes(12), 'hex')),
         qr_token = encode(extensions.gen_random_bytes(32), 'hex')
   where booking_leg_id = v_l.id and status = 'valid';
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (p_booking_id, 'rescheduled', auth.uid(), jsonb_build_object('leg', p_leg, 'from_sailing', v_l.sailing_id,
          'to_sailing', p_new_sailing_id, 'reason', v_reason, 'replaced_tickets', v_old_refs, 'by_staff', v_staff));
  perform public.emit_notification(v_b.created_by, 'rescheduled:' || p_booking_id || ':' || p_new_sailing_id, 'booking_rescheduled', '/bookings/' || v_b.reference);
  return 'rescheduled';
end; $$;

-- Cancel: customers within the change window; staff any time. Paid bookings get a
-- refund review (no automatic refund). Boarded tickets block cancellation.
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_b public.bookings%rowtype; v_staff boolean; v_first timestamptz;
begin
  v_reason := public._valid_reason(p_reason);
  if p_booking_id is null then raise exception 'invalid input' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  v_staff := public.has_platform_role('{super_admin,operations}');
  if not (v_staff or v_b.created_by = auth.uid()
      or (v_b.organization_id is not null and public.has_org_role(v_b.organization_id, '{company_admin}'))) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_b.status = 'cancelled' then return 'unchanged'; end if;
  if v_b.status not in ('reserved', 'pending_payment', 'paid') then raise exception 'invalid_transition' using errcode = '55000'; end if;
  if exists (select 1 from public.tickets where booking_id = p_booking_id and status = 'boarded') then
    raise exception 'invalid_transition: a passenger has already boarded' using errcode = '55000'; end if;
  if exists (select 1 from public.payments where booking_id = p_booking_id and status in ('initiated', 'pending')) and not v_staff then
    raise exception 'payment_in_progress: wait for the payment result' using errcode = '55000'; end if;
  if not v_staff then
    select min(s.departs_at) into v_first from public.booking_legs l join public.sailings s on s.id = l.sailing_id where l.booking_id = p_booking_id;
    if v_first - make_interval(hours => public.setting_int('booking.customer_change_cutoff_hours', 24)) <= now() then
      raise exception 'change_window_closed: contact ATCO operations' using errcode = '55000'; end if;
  end if;
  perform 1 from public.sailings s where s.id in (select sailing_id from public.booking_legs where booking_id = p_booking_id) order by s.id for update;
  update public.sailings s set seats_booked = greatest(0, s.seats_booked - l.passengers)
    from public.booking_legs l where l.booking_id = p_booking_id and l.sailing_id = s.id;
  update public.bookings set status = 'cancelled', operational_status = 'cancelled', hold_expires_at = null,
    cancelled_at = now(), cancel_reason = v_reason where id = p_booking_id;
  update public.tickets set status = 'cancelled' where booking_id = p_booking_id and status = 'valid';
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (p_booking_id, 'cancelled', auth.uid(), jsonb_build_object('reason', v_reason, 'by_staff', v_staff));
  if v_b.payment_status in ('paid', 'partially_refunded') then
    perform public._open_refund_review(p_booking_id, 'Booking cancelled: ' || v_reason);
  end if;
  if v_b.payment_status = 'on_account' then
    perform public._credit_on_account_invoice(p_booking_id, 'Booking cancelled: ' || v_reason);
  end if;
  return 'cancelled';
end; $$;

-- Releases seats held by unpaid pay-now reservations past their hold time.
-- Callable by operations or by the scheduled job (service role). A payment that is
-- still in flight keeps the hold for a 30-minute grace period.
create or replace function public.expire_stale_holds()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_b record; v_n integer := 0;
begin
  if not (current_user = 'service_role' or auth.role() = 'service_role' or public.has_platform_role('{super_admin,operations}')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  for v_b in select b.id from public.bookings b
              where b.settlement_mode = 'pay_now' and b.payment_status in ('unpaid', 'pending')
                and b.status in ('reserved', 'pending_payment') and b.hold_expires_at is not null and b.hold_expires_at < now()
                and not exists (select 1 from public.payments p where p.booking_id = b.id and p.status in ('initiated', 'pending')
                                 and p.created_at > now() - interval '30 minutes')
              order by b.id for update skip locked loop
    perform 1 from public.sailings s where s.id in (select sailing_id from public.booking_legs where booking_id = v_b.id) order by s.id for update;
    update public.sailings s set seats_booked = greatest(0, s.seats_booked - l.passengers)
      from public.booking_legs l where l.booking_id = v_b.id and l.sailing_id = s.id;
    update public.bookings set status = 'expired', operational_status = 'cancelled', payment_status = 'unpaid' where id = v_b.id;
    update public.tickets set status = 'cancelled' where booking_id = v_b.id and status = 'valid';
    update public.payments set status = 'expired', updated_at = now() where booking_id = v_b.id and status in ('initiated', 'pending');
    insert into public.booking_events (booking_id, action, actor_user_id, details)
    values (v_b.id, 'expired', auth.uid(), jsonb_build_object('reason', 'payment hold expired'));
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;

-- ---------------------------------------------------------------------------
-- 7. Boarding gate: ticket + payment + every required checkpoint
-- ---------------------------------------------------------------------------
create or replace function public.sailing_boarding_gate(p_sailing_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_s public.sailings%rowtype; v_req jsonb;
begin
  select * into v_s from public.sailings where id = p_sailing_id;
  if not found then return 'not_found'; end if;
  if v_s.status = 'cancelled' then return 'sailing_cancelled'; end if;
  if v_s.status = 'suspended' then return 'sailing_suspended'; end if;
  v_req := coalesce((select value -> 'value' from public.platform_settings where key = 'boarding.required_checkpoints'),
                    '["operations_readiness","master_decision","port_clearance"]'::jsonb);
  if v_s.readiness_status <> 'ready' then return 'not_ready'; end if;
  if v_req ? 'master_decision' and v_s.master_decision <> 'go' then return 'master_not_go'; end if;
  if v_req ? 'port_clearance' and v_s.port_clearance_status not in ('cleared', 'not_required') then return 'clearance_pending'; end if;
  return 'open';
end; $$;
revoke all on function public.sailing_boarding_gate(uuid) from public, anon, service_role;
grant execute on function public.sailing_boarding_gate(uuid) to authenticated;

create or replace function public.board_ticket(p_code text, p_sailing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype; v_sailing public.sailings%rowtype; v_pay text; v_bstatus text; v_gate text;
begin
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then raise exception 'not authorized' using errcode = '42501'; end if;
  perform 1 from public.profiles where id = auth.uid() for share;
  perform 1 from public.role_assignments where user_id = auth.uid() and organization_id is null for share;
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_sailing_id is null or p_code is null or char_length(p_code) > 100 then raise exception 'invalid ticket lookup' using errcode = '22023'; end if;
  select * into v_sailing from public.sailings where id = p_sailing_id for update;
  if not found then return 'not_found'; end if;
  select * into v_ticket from public.tickets
   where (reference = btrim(p_code) and p_code like 'TK-%')
      or (qr_token = substring(btrim(p_code) from 6) and btrim(p_code) ~ '^GMT1:[0-9a-f]{64}$')
   for update;
  if not found then return 'not_found'; end if;
  if v_ticket.sailing_id <> p_sailing_id then return 'wrong_sailing'; end if;
  if v_sailing.status = 'cancelled' then return 'sailing_cancelled'; end if;
  if v_ticket.status = 'cancelled' then return 'cancelled'; end if;
  if v_ticket.status = 'revoked' then return 'revoked'; end if;
  if v_ticket.status = 'no_show' then return 'no_show'; end if;
  if v_ticket.status = 'boarded' then return 'already_boarded'; end if;
  select b.payment_status, b.status into v_pay, v_bstatus from public.bookings b where b.id = v_ticket.booking_id for share;
  if v_bstatus in ('cancelled', 'expired', 'refunded') then return 'cancelled'; end if;
  if public.setting_bool('boarding.require_settled_payment', true) and v_pay not in ('paid', 'on_account', 'partially_refunded') then
    return 'payment_required'; end if;
  v_gate := public.sailing_boarding_gate(p_sailing_id);
  if v_gate <> 'open' then return v_gate; end if;
  update public.tickets set status = 'boarded', boarded_at = now() where id = v_ticket.id;
  insert into public.boarding_events (ticket_id, sailing_id, actor_user_id) values (v_ticket.id, p_sailing_id, auth.uid());
  return 'boarded';
end; $$;

-- Grants for the new staff/customer RPCs.
do $$
declare f text;
begin
  foreach f in array array[
    'record_master_decision(uuid, text, text, text)', 'record_port_clearance(uuid, text, text, text)',
    'suspend_sailing(uuid, text)', 'resume_sailing(uuid, text)', 'cancel_sailing(uuid, text)',
    'decide_sailing_minimum(uuid, text, text)', 'record_no_shows(uuid, text)', 'revoke_ticket(uuid, text)',
    'reschedule_booking_leg(uuid, text, uuid, text)', 'cancel_booking(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.expire_stale_holds() from public, anon;
grant execute on function public.expire_stale_holds() to authenticated, service_role;
revoke all on function public._valid_reason(text) from public, anon, authenticated, service_role;

-- Passenger + material manifest export for staff (no contact details, no QR secrets).
create or replace function public.sailing_manifest_summary(p_sailing_id uuid)
returns table (seat_capacity integer, seats_booked integer, tickets_valid bigint, tickets_boarded bigint,
               tickets_no_show bigint, payload_capacity_kg integer, payload_booked_kg integer, gate text,
               master_decision text, port_clearance_status text, readiness_status text, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select s.seat_capacity, s.seats_booked,
    (select count(*) from public.tickets t where t.sailing_id = s.id and t.status = 'valid'),
    (select count(*) from public.tickets t where t.sailing_id = s.id and t.status = 'boarded'),
    (select count(*) from public.tickets t where t.sailing_id = s.id and t.status = 'no_show'),
    s.payload_capacity_kg, s.payload_booked_kg, public.sailing_boarding_gate(s.id),
    s.master_decision, s.port_clearance_status, s.readiness_status, s.status
    from public.sailings s where s.id = p_sailing_id;
end; $$;
revoke all on function public.sailing_manifest_summary(uuid) from public, anon, service_role;
grant execute on function public.sailing_manifest_summary(uuid) to authenticated;
