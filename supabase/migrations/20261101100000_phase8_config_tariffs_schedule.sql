-- ===========================================================================
-- 20261101100000 — Phase 8: configuration audit, versioned tariffs + VAT,
-- authorised settings changes, schedule templates (Asia/Riyadh).
-- ===========================================================================
-- Additive. No earlier migration is edited. Money stays in halala integers.
--
-- Decisions recorded here (see docs/atco-pending-business-rules.md, Phase 8):
--   * Tariffs become append-only versions. Monetary fields cannot be edited in
--     place; a new version is published and (separately) approved.
--   * VAT treatment is a property of the tariff version: not_configured (default
--     until ATCO Finance decides), exclusive, inclusive, exempt, zero_rated.
--     Rate in basis points (1500 = 15.00%). Rounding: half-up per line.
--   * Approval of a tariff requires a different person than its publisher.
--   * Schedule templates generate sailings in Asia/Riyadh local time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Configuration audit (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.config_audit (
  id            bigint generated always as identity primary key,
  entity        text not null,
  entity_id     text not null,
  action        text not null constraint config_audit_action_check check (action in ('insert', 'update', 'delete')),
  before_value  jsonb,
  after_value   jsonb,
  reason        text,
  actor_user_id uuid,
  created_at    timestamptz not null default now()
);
create index if not exists config_audit_entity_idx on public.config_audit (entity, entity_id, created_at desc);
comment on table public.config_audit is
  'Append-only history of changes to fares, policies, settings, schedules, credit and permissions. Written only by triggers.';
alter table public.config_audit enable row level security;
drop policy if exists config_audit_select_staff on public.config_audit;
create policy config_audit_select_staff on public.config_audit for select to authenticated
  using (public.has_platform_role('{super_admin,finance,operations}'));
revoke all on public.config_audit from public, anon, authenticated, service_role;
grant select on public.config_audit to authenticated;

-- Generic audit trigger. Reason is optional and comes from the transaction-local
-- setting gm.change_reason that the RPCs below set before writing.
create or replace function public.audit_config_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id text; v_before jsonb; v_after jsonb;
begin
  if tg_op = 'DELETE' then v_before := to_jsonb(old); v_after := null;
  elsif tg_op = 'INSERT' then v_before := null; v_after := to_jsonb(new);
  else v_before := to_jsonb(old); v_after := to_jsonb(new);
    if v_before = v_after then return new; end if;
  end if;
  v_id := coalesce(v_after ->> 'id', v_before ->> 'id', v_after ->> 'key', v_before ->> 'key', '?');
  insert into public.config_audit (entity, entity_id, action, before_value, after_value, reason, actor_user_id)
  values (tg_table_name, v_id, lower(tg_op), v_before, v_after,
          nullif(current_setting('gm.change_reason', true), ''), auth.uid());
  return coalesce(new, old);
end; $$;
revoke all on function public.audit_config_change() from public, anon, authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['tariffs', 'service_policies', 'platform_settings', 'material_tariffs',
                           'routes', 'vessels', 'role_assignments'] loop
    execute format('drop trigger if exists trg_audit_config on public.%I', t);
    execute format('create trigger trg_audit_config after insert or update or delete on public.%I
                    for each row execute function public.audit_config_change()', t);
  end loop;
end $$;

-- Sailings: audit schedule-relevant changes only (seat counters change constantly).
drop trigger if exists trg_audit_config on public.sailings;
create trigger trg_audit_config after insert or update of route_id, vessel_id, departs_at, seat_capacity, status
  on public.sailings for each row execute function public.audit_config_change();

-- Organizations: audit commercial/credit fields (status changes already have approval_events).
drop trigger if exists trg_audit_config on public.organizations;
create trigger trg_audit_config after update of account_type, credit_limit_halala, payment_terms_days
  on public.organizations for each row execute function public.audit_config_change();

-- ---------------------------------------------------------------------------
-- 2. Versioned tariffs with explicit VAT treatment
-- ---------------------------------------------------------------------------
alter table public.tariffs
  add column if not exists vat_mode text not null default 'not_configured'
    constraint tariffs_vat_mode_check check (vat_mode in ('not_configured', 'exclusive', 'inclusive', 'exempt', 'zero_rated')),
  add column if not exists vat_rate_bp integer
    constraint tariffs_vat_rate_bp_range check (vat_rate_bp is null or vat_rate_bp between 0 and 10000),
  add column if not exists approval_status text not null default 'provisional'
    constraint tariffs_approval_status_check check (approval_status in ('provisional', 'approved', 'retired')),
  add column if not exists approved_by uuid references auth.users (id),
  add column if not exists approved_at timestamptz,
  add column if not exists route_id uuid references public.routes (id),
  add column if not exists notes text constraint tariffs_notes_length check (notes is null or char_length(notes) <= 500);

alter table public.tariffs drop constraint if exists tariffs_vat_shape;
alter table public.tariffs add constraint tariffs_vat_shape check (
  (vat_mode in ('exclusive', 'inclusive') and vat_rate_bp is not null and vat_rate_bp > 0)
  or (vat_mode in ('not_configured', 'exempt', 'zero_rated') and coalesce(vat_rate_bp, 0) = 0)
);

comment on column public.tariffs.vat_mode is
  'VAT treatment decided by ATCO Finance. not_configured = no VAT is charged or shown as tax; documents are not tax invoices.';

-- No direct writes from the app: publish/approve/retire through audited RPCs.
revoke insert, update, delete on public.tariffs from authenticated;

-- Monetary fields of a version are immutable once approved or once a booking used it.
create or replace function public.guard_tariff_immutability()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (old.per_person_halala, old.currency, old.vat_mode, coalesce(old.vat_rate_bp, -1), old.code, old.route_id)
     is distinct from
     (new.per_person_halala, new.currency, new.vat_mode, coalesce(new.vat_rate_bp, -1), new.code, new.route_id) then
    raise exception 'tariff_immutable: publish a new tariff version instead of editing amounts' using errcode = '55000';
  end if;
  if old.approval_status = 'retired' and new.approval_status <> 'retired' then
    raise exception 'invalid_transition: a retired tariff cannot be reactivated' using errcode = '55000';
  end if;
  return new;
end; $$;
revoke all on function public.guard_tariff_immutability() from public, anon, authenticated, service_role;
drop trigger if exists trg_tariff_immutability on public.tariffs;
create trigger trg_tariff_immutability before update on public.tariffs
  for each row execute function public.guard_tariff_immutability();

-- The tariff that applies to a sailing departure. Approved versions win over
-- provisional ones; route-specific versions win over network-wide ones.
create or replace function public.applicable_tariff(p_route_id uuid, p_at timestamptz)
returns public.tariffs
language sql stable security definer set search_path = '' as $$
  select t.* from public.tariffs t
   where t.active and t.approval_status in ('approved', 'provisional')
     and t.effective_from <= coalesce(p_at, now())
     and (t.effective_to is null or t.effective_to > coalesce(p_at, now()))
     and (t.route_id is null or t.route_id = p_route_id)
   order by (t.approval_status = 'approved') desc, (t.route_id is not null) desc, t.effective_from desc
   limit 1
$$;
revoke all on function public.applicable_tariff(uuid, timestamptz) from public, anon, service_role;
grant execute on function public.applicable_tariff(uuid, timestamptz) to authenticated;

-- Exact VAT arithmetic for one line (integers only, half-up rounding).
create or replace function public.vat_breakdown(p_amount_halala bigint, p_vat_mode text, p_vat_rate_bp integer)
returns table (net_halala bigint, vat_halala bigint, gross_halala bigint)
language plpgsql immutable set search_path = '' as $$
declare v_net bigint;
begin
  if p_amount_halala is null or p_amount_halala < 0 then raise exception 'invalid amount' using errcode = '22023'; end if;
  if p_vat_mode = 'exclusive' then
    return query select p_amount_halala, (p_amount_halala * p_vat_rate_bp + 5000) / 10000,
                        p_amount_halala + (p_amount_halala * p_vat_rate_bp + 5000) / 10000;
  elsif p_vat_mode = 'inclusive' then
    v_net := (p_amount_halala * 10000 * 2 + (10000 + p_vat_rate_bp)) / (2 * (10000 + p_vat_rate_bp));
    return query select v_net, p_amount_halala - v_net, p_amount_halala;
  elsif p_vat_mode in ('not_configured', 'exempt', 'zero_rated') then
    return query select p_amount_halala, 0::bigint, p_amount_halala;
  else
    raise exception 'invalid vat mode' using errcode = '22023';
  end if;
end; $$;
grant execute on function public.vat_breakdown(bigint, text, integer) to authenticated, service_role;

create or replace function public.publish_tariff(
  p_code text, p_per_person_halala bigint, p_vat_mode text, p_vat_rate_bp integer,
  p_effective_from timestamptz, p_route_id uuid default null, p_notes text default null, p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if nullif(btrim(p_code), '') is null or char_length(btrim(p_code)) > 64 then raise exception 'invalid code' using errcode = '22023'; end if;
  if p_per_person_halala is null or p_per_person_halala < 0 or p_per_person_halala > 9000000000000 then
    raise exception 'invalid fare' using errcode = '22023'; end if;
  if p_vat_mode is null or p_vat_mode not in ('not_configured', 'exclusive', 'inclusive', 'exempt', 'zero_rated') then
    raise exception 'invalid vat mode' using errcode = '22023'; end if;
  if p_vat_mode in ('exclusive', 'inclusive') and (p_vat_rate_bp is null or p_vat_rate_bp <= 0 or p_vat_rate_bp > 10000) then
    raise exception 'invalid vat rate' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', coalesce(btrim(p_reason), 'tariff published'), true);
  insert into public.tariffs (code, per_person_halala, currency, vat_percent, vat_active, vat_mode, vat_rate_bp,
                              effective_from, active, approval_status, route_id, notes, created_by)
  values (btrim(p_code), p_per_person_halala, 'SAR', null, p_vat_mode in ('exclusive', 'inclusive'), p_vat_mode,
          case when p_vat_mode in ('exclusive', 'inclusive') then p_vat_rate_bp else null end,
          coalesce(p_effective_from, now()), true, 'provisional', p_route_id, nullif(btrim(p_notes), ''), auth.uid())
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.publish_tariff(text, bigint, text, integer, timestamptz, uuid, text, text) from public, anon, service_role;
grant execute on function public.publish_tariff(text, bigint, text, integer, timestamptz, uuid, text, text) to authenticated;

-- Four-eyes approval: the approver must not be the publisher.
create or replace function public.approve_tariff(p_tariff_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_t public.tariffs%rowtype;
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_t from public.tariffs where id = p_tariff_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_t.approval_status = 'approved' then return 'unchanged'; end if;
  if v_t.approval_status = 'retired' then raise exception 'invalid_transition' using errcode = '55000'; end if;
  if v_t.created_by is not null and v_t.created_by = auth.uid() then
    raise exception 'four_eyes_required: the publisher cannot approve their own tariff' using errcode = '42501'; end if;
  perform set_config('gm.change_reason', btrim(p_reason), true);
  update public.tariffs set approval_status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_tariff_id;
  return 'approved';
end; $$;
revoke all on function public.approve_tariff(uuid, text) from public, anon, service_role;
grant execute on function public.approve_tariff(uuid, text) to authenticated;

create or replace function public.retire_tariff(p_tariff_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'reason required' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', btrim(p_reason), true);
  update public.tariffs set approval_status = 'retired', active = false, effective_to = greatest(now(), effective_from + interval '1 second')
   where id = p_tariff_id and approval_status <> 'retired';
  if not found then
    if exists (select 1 from public.tariffs where id = p_tariff_id) then return 'unchanged'; end if;
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return 'retired';
end; $$;
revoke all on function public.retire_tariff(uuid, text) from public, anon, service_role;
grant execute on function public.retire_tariff(uuid, text) to authenticated;

-- Server-side quote for a passenger journey. The browser never sends amounts.
create or replace function public.quote_passenger_fare(p_outbound_sailing_id uuid, p_return_sailing_id uuid, p_passenger_count integer)
returns table (tariff_id uuid, tariff_code text, tariff_status text, unit_halala bigint, quantity integer,
               net_halala bigint, vat_halala bigint, total_halala bigint, vat_mode text, vat_rate_bp integer, currency text)
language plpgsql stable security definer set search_path = '' as $$
declare v_route uuid; v_at timestamptz; v_t public.tariffs; v_qty integer; v_b record;
begin
  if p_outbound_sailing_id is null or p_passenger_count is null or p_passenger_count < 1 or p_passenger_count > 1000 then
    raise exception 'invalid quote request' using errcode = '22023'; end if;
  select s.route_id, s.departs_at into v_route, v_at from public.sailings s where s.id = p_outbound_sailing_id;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  v_t := public.applicable_tariff(v_route, v_at);
  if v_t.id is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;
  v_qty := p_passenger_count * (case when p_return_sailing_id is null then 1 else 2 end);
  select * into v_b from public.vat_breakdown(v_t.per_person_halala * v_qty, v_t.vat_mode, coalesce(v_t.vat_rate_bp, 0));
  return query select v_t.id, v_t.code, v_t.approval_status, v_t.per_person_halala, v_qty,
    v_b.net_halala, v_b.vat_halala, v_b.gross_halala, v_t.vat_mode, coalesce(v_t.vat_rate_bp, 0), v_t.currency;
end; $$;
revoke all on function public.quote_passenger_fare(uuid, uuid, integer) from public, anon, service_role;
grant execute on function public.quote_passenger_fare(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Authorised, validated platform settings
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description) values
  ('booking.payment_hold_minutes', '{"value": 30}', 'Minutes an unpaid pay-now reservation holds seats before it can be expired. Technical default; ATCO may change.'),
  ('booking.customer_change_cutoff_hours', '{"value": 24}', 'Customers may reschedule/cancel online until this many hours before departure (provisional). Staff are not limited.'),
  ('sailing.minimum_counts', '{"value": "paid_and_on_account"}', 'Which tickets qualify for the minimum: paid_and_on_account (default) or all_reserved.'),
  ('boarding.require_settled_payment', '{"value": true}', 'Boarding requires a paid or approved on-account booking.'),
  ('boarding.required_checkpoints', '{"value": ["operations_readiness", "master_decision", "port_clearance"]}', 'Checkpoints that must be cleared before boarding opens.'),
  ('payments.live_enabled', '{"value": false}', 'Live payments switch. Must stay false until ATCO supplies an approved merchant account and authorises testing.'),
  ('seller.legal_name', '{"value": null}', 'Seller legal name for invoices (ATCO Finance to supply).'),
  ('seller.vat_number', '{"value": null}', 'Seller VAT registration number (15 digits). Unset = documents are not tax invoices.'),
  ('security.staff_mfa_required', '{"value": false}', 'When true, staff platform roles only apply to sessions with MFA (aal2). Enable in staging/production.'),
  ('payload.passenger_allowance_kg', '{"value": null}', 'Optional kg per passenger counted against vessel payload. Null = passengers not counted (pending ATCO).')
on conflict (key) do nothing;

revoke insert, update, delete on public.platform_settings from authenticated;

create or replace function public.update_platform_setting(p_key text, p_value jsonb, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_v jsonb; v_roles text[];
begin
  if p_key is null or p_value is null or jsonb_typeof(p_value) <> 'object' or not (p_value ? 'value') then
    raise exception 'invalid setting' using errcode = '22023'; end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'reason required' using errcode = '22023'; end if;
  v_v := p_value -> 'value';
  v_roles := case
    when p_key in ('sailing.minimum_tickets', 'sailing.minimum_revenue_halala', 'sailing.minimum_counts',
                   'booking.confirmation_deadline_hours', 'booking.payment_hold_minutes',
                   'booking.customer_change_cutoff_hours', 'boarding.required_checkpoints',
                   'payload.passenger_allowance_kg') then '{super_admin,operations}'
    when p_key in ('seller.legal_name', 'seller.vat_number', 'payments.provider') then '{super_admin,finance}'
    when p_key in ('payments.mode', 'payments.live_enabled', 'boarding.require_settled_payment',
                   'security.staff_mfa_required') then '{super_admin}'
    else null end;
  if v_roles is null then raise exception 'unknown or protected setting' using errcode = '22023'; end if;
  if not public.has_platform_role(v_roles) then raise exception 'not authorized' using errcode = '42501'; end if;

  -- Per-key validation.
  if p_key in ('sailing.minimum_tickets') and not (jsonb_typeof(v_v) = 'number' and (v_v::text)::numeric between 1 and 1000 and (v_v::text) ~ '^[0-9]+$') then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key in ('sailing.minimum_revenue_halala') and not (jsonb_typeof(v_v) = 'number' and (v_v::text) ~ '^[0-9]+$') then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key in ('booking.confirmation_deadline_hours', 'booking.customer_change_cutoff_hours') and not (jsonb_typeof(v_v) = 'number' and (v_v::text) ~ '^[0-9]+$' and (v_v::text)::int <= 720) then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key = 'booking.payment_hold_minutes' and not (jsonb_typeof(v_v) = 'number' and (v_v::text) ~ '^[0-9]+$' and (v_v::text)::int between 5 and 1440) then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key = 'sailing.minimum_counts' and not (v_v #>> '{}') in ('paid_and_on_account', 'all_reserved') then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key = 'boarding.required_checkpoints' and not (jsonb_typeof(v_v) = 'array'
       and not exists (select 1 from jsonb_array_elements_text(v_v) e where e not in ('operations_readiness', 'master_decision', 'port_clearance'))
       and v_v ? 'operations_readiness') then
    raise exception 'invalid value: operations_readiness is always required' using errcode = '22023'; end if;
  if p_key = 'payload.passenger_allowance_kg' and not (jsonb_typeof(v_v) = 'null' or (jsonb_typeof(v_v) = 'number' and (v_v::text) ~ '^[0-9]+$' and (v_v::text)::int between 1 and 500)) then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key = 'seller.vat_number' and not (jsonb_typeof(v_v) = 'null' or (jsonb_typeof(v_v) = 'string' and (v_v #>> '{}') ~ '^3[0-9]{13}3$')) then
    raise exception 'invalid value: Saudi VAT numbers are 15 digits starting and ending with 3' using errcode = '22023'; end if;
  if p_key = 'seller.legal_name' and not (jsonb_typeof(v_v) = 'null' or (jsonb_typeof(v_v) = 'string' and char_length(v_v #>> '{}') between 1 and 200)) then
    raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key = 'payments.mode' and not (v_v #>> '{}') in ('sandbox', 'live') then raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key = 'payments.provider' and not (v_v #>> '{}') in ('sandbox-provider', 'moyasar', 'tap', 'hyperpay') then raise exception 'invalid value' using errcode = '22023'; end if;
  if p_key in ('payments.live_enabled', 'boarding.require_settled_payment', 'security.staff_mfa_required') and jsonb_typeof(v_v) <> 'boolean' then
    raise exception 'invalid value' using errcode = '22023'; end if;
  -- Live payments cannot be switched on while the seller identity is unset.
  if p_key = 'payments.live_enabled' and v_v = 'true'::jsonb and (
       (select value -> 'value' from public.platform_settings where key = 'seller.legal_name') = 'null'::jsonb) then
    raise exception 'seller_identity_required: set seller.legal_name before enabling live payments' using errcode = '55000'; end if;

  perform set_config('gm.change_reason', btrim(p_reason), true);
  insert into public.platform_settings (key, value, description, updated_at, updated_by)
  values (p_key, jsonb_build_object('value', v_v), '', now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  return 'updated';
end; $$;
revoke all on function public.update_platform_setting(text, jsonb, text) from public, anon, service_role;
grant execute on function public.update_platform_setting(text, jsonb, text) to authenticated;

-- Small typed readers used by later functions.
create or replace function public.setting_int(p_key text, p_default integer)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(value -> 'value') = 'number' then (value ->> 'value')::integer end
                     from public.platform_settings where key = p_key), p_default)
$$;
create or replace function public.setting_text(p_key text, p_default text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(value -> 'value') = 'string' then value ->> 'value' end
                     from public.platform_settings where key = p_key), p_default)
$$;
create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(value -> 'value') = 'boolean' then (value ->> 'value')::boolean end
                     from public.platform_settings where key = p_key), p_default)
$$;
revoke all on function public.setting_int(text, integer), public.setting_text(text, text), public.setting_bool(text, boolean) from public, anon;
grant execute on function public.setting_int(text, integer), public.setting_text(text, text), public.setting_bool(text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Schedule templates (Asia/Riyadh) and sailing generation
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_templates (
  id               uuid primary key default gen_random_uuid(),
  route_id         uuid not null references public.routes (id),
  vessel_id        uuid not null references public.vessels (id),
  departure_local  time not null,
  days_of_week     integer[] not null default '{1,2,3,4,5,6,7}'
    constraint schedule_templates_dow_check check (days_of_week <@ array[1,2,3,4,5,6,7] and cardinality(days_of_week) between 1 and 7),
  seat_capacity    integer not null constraint schedule_templates_capacity_range check (seat_capacity between 1 and 1000),
  valid_from       date not null default current_date,
  valid_to         date,
  active           boolean not null default true,
  notes            text constraint schedule_templates_notes_length check (notes is null or char_length(notes) <= 500),
  created_by       uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  constraint schedule_templates_dates check (valid_to is null or valid_to >= valid_from),
  constraint schedule_templates_unique unique (route_id, vessel_id, departure_local)
);
comment on table public.schedule_templates is
  'Recurring departures in Asia/Riyadh local time (ISO day of week, 1 = Monday). Generates sailings; edits never move booked sailings.';
alter table public.schedule_templates enable row level security;
drop policy if exists schedule_templates_select on public.schedule_templates;
create policy schedule_templates_select on public.schedule_templates for select to authenticated using (true);
revoke all on public.schedule_templates from public, anon, authenticated, service_role;
grant select on public.schedule_templates to authenticated;
drop trigger if exists trg_audit_config on public.schedule_templates;
create trigger trg_audit_config after insert or update or delete on public.schedule_templates
  for each row execute function public.audit_config_change();

create or replace function public.upsert_schedule_template(
  p_id uuid, p_route_id uuid, p_vessel_id uuid, p_departure_local time, p_days_of_week integer[],
  p_seat_capacity integer, p_valid_from date, p_valid_to date, p_active boolean, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_cap integer;
begin
  if not public.has_platform_role('{super_admin,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'reason required' using errcode = '22023'; end if;
  if p_route_id is null or p_vessel_id is null or p_departure_local is null or p_seat_capacity is null then
    raise exception 'invalid template' using errcode = '22023'; end if;
  select passenger_capacity into v_cap from public.vessels where id = p_vessel_id and status = 'active';
  if not found then raise exception 'invalid vessel' using errcode = '22023'; end if;
  if v_cap is not null and p_seat_capacity > v_cap then raise exception 'invalid seat capacity: exceeds vessel capacity' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', btrim(p_reason), true);
  if p_id is null then
    insert into public.schedule_templates (route_id, vessel_id, departure_local, days_of_week, seat_capacity, valid_from, valid_to, active, created_by)
    values (p_route_id, p_vessel_id, p_departure_local, coalesce(p_days_of_week, '{1,2,3,4,5,6,7}'), p_seat_capacity,
            coalesce(p_valid_from, current_date), p_valid_to, coalesce(p_active, true), auth.uid())
    returning id into v_id;
  else
    update public.schedule_templates set route_id = p_route_id, vessel_id = p_vessel_id, departure_local = p_departure_local,
      days_of_week = coalesce(p_days_of_week, days_of_week), seat_capacity = p_seat_capacity,
      valid_from = coalesce(p_valid_from, valid_from), valid_to = p_valid_to, active = coalesce(p_active, active)
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end; $$;
revoke all on function public.upsert_schedule_template(uuid, uuid, uuid, time, integer[], integer, date, date, boolean, text) from public, anon, service_role;
grant execute on function public.upsert_schedule_template(uuid, uuid, uuid, time, integer[], integer, date, date, boolean, text) to authenticated;

-- Creates missing sailings for active templates between two Riyadh-local dates.
-- Existing sailings (same vessel + instant) are left untouched.
create or replace function public._generate_sailings(p_from date, p_to date)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_t record; v_d date; v_at timestamptz; v_n integer := 0;
begin
  for v_t in select * from public.schedule_templates where active loop
    v_d := greatest(p_from, v_t.valid_from);
    while v_d <= p_to and (v_t.valid_to is null or v_d <= v_t.valid_to) loop
      if extract(isodow from v_d)::int = any(v_t.days_of_week) then
        v_at := (v_d + v_t.departure_local) at time zone 'Asia/Riyadh';
        if v_at > now() and not exists (select 1 from public.sailings s where s.vessel_id = v_t.vessel_id and s.departs_at = v_at) then
          insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
          values (v_t.route_id, v_t.vessel_id, v_at, v_t.seat_capacity, 'open');
          v_n := v_n + 1;
        end if;
      end if;
      v_d := v_d + 1;
    end loop;
  end loop;
  return v_n;
end; $$;
revoke all on function public._generate_sailings(date, date) from public, anon, authenticated, service_role;

create or replace function public.generate_sailings(p_from date, p_to date)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'invalid range (max 93 days)' using errcode = '22023'; end if;
  return public._generate_sailings(p_from, p_to);
end; $$;
revoke all on function public.generate_sailings(date, date) from public, anon, service_role;
grant execute on function public.generate_sailings(date, date) to authenticated, service_role;

-- Seed templates for the provisional Ras Tanura route. Outbound 07:00/09:30/13:00
-- (ATCO-specified). Return departures are PROVISIONAL (+60 min) because ATCO has
-- not supplied return times and one vessel cannot depart twice at one instant —
-- Phase 7's same-time return seed collided with sailings_vessel_departure_uniq and
-- created no return sailings at all.
do $$
declare v_vessel uuid; v_out uuid; v_back uuid; t time;
begin
  select id into v_vessel from public.vessels where name = 'Provisional Taxi Vessel - pending ATCO confirmation' limit 1;
  select id into v_out from public.routes where origin = 'Ras Tanura Service Pier' and destination = 'Approved Anchorage - pending ATCO confirmation' limit 1;
  select id into v_back from public.routes where origin = 'Approved Anchorage - pending ATCO confirmation' and destination = 'Ras Tanura Service Pier' limit 1;
  if v_vessel is null or v_out is null or v_back is null then return; end if;
  foreach t in array array[time '07:00', time '09:30', time '13:00'] loop
    insert into public.schedule_templates (route_id, vessel_id, departure_local, seat_capacity, notes)
    values (v_out, v_vessel, t, 12, 'ATCO-specified outbound time; vessel/capacity provisional')
    on conflict (route_id, vessel_id, departure_local) do nothing;
    insert into public.schedule_templates (route_id, vessel_id, departure_local, seat_capacity, notes)
    values (v_back, v_vessel, t + interval '60 minutes', 12, 'PROVISIONAL return time pending ATCO confirmation')
    on conflict (route_id, vessel_id, departure_local) do nothing;
  end loop;
  perform public._generate_sailings((now() at time zone 'Asia/Riyadh')::date + 1, (now() at time zone 'Asia/Riyadh')::date + 14);
end $$;
