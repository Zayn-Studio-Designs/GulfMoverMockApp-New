-- ===========================================================================
-- 20261101100004 — Phase 8: materials and charters workflow completion.
-- ===========================================================================
-- Materials: private attachments (Supabase Storage, path-scoped RLS), category,
-- volume, parameterised tariffs and quotes, a mandatory staff safety review for
-- EVERY material request (a customer's "not hazardous" label is never trusted),
-- operational approval, payload-checked sailing assignment, manifest and
-- proof-of-delivery per the materials_safety policy.
-- Charters: approval is not confirmation; a charter is confirmed only when an
-- allocation (vessel + time window without conflicts) is recorded.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Status model
-- ---------------------------------------------------------------------------
alter table public.transfer_requests drop constraint if exists transfer_requests_status_check;
alter table public.transfer_requests add constraint transfer_requests_status_check check (status in (
  'pending_review', 'clarification_required', 'reviewed_for_planning', 'approved', 'rejected',
  'scheduled', 'delivered', 'confirmed', 'completed', 'cancelled'));
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.transfer_request_events'::regclass and contype = 'c' loop
    execute format('alter table public.transfer_request_events drop constraint %I', c);
  end loop;
end $$;
alter table public.transfer_request_events add constraint transfer_request_events_status_check check (status in (
  'pending_review', 'clarification_required', 'reviewed_for_planning', 'approved', 'rejected',
  'scheduled', 'delivered', 'confirmed', 'completed', 'cancelled', 'safety_accepted', 'safety_refused', 'quoted'));

alter table public.transfer_requests
  add column if not exists weight_kg integer,
  add column if not exists safety_decision text not null default 'pending'
    constraint transfer_requests_safety_check check (safety_decision in ('pending', 'accepted', 'refused', 'not_applicable')),
  add column if not exists safety_reference text,
  add column if not exists safety_reviewed_by uuid references auth.users (id),
  add column if not exists safety_reviewed_at timestamptz,
  add column if not exists declared_hazardous boolean not null default false;
update public.transfer_requests set safety_decision = 'not_applicable' where kind = 'charter' and safety_decision = 'pending';

-- Derived, server-side fields: weight (rounded up to whole kg) and the declaration.
create or replace function public.trg_transfer_request_derive()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'materials' then
    new.weight_kg := case when coalesce(new.details ->> 'weight_kg', '') ~ '^[0-9]+([.][0-9]+)?$'
                          then ceil((new.details ->> 'weight_kg')::numeric)::int end;
    new.declared_hazardous := coalesce(new.details ->> 'hazardous', 'false') = 'true'
                              or coalesce(new.details ->> 'category', '') = 'dangerous_goods';
  else
    new.safety_decision := 'not_applicable';
  end if;
  return new;
end; $$;
revoke all on function public.trg_transfer_request_derive() from public, anon, authenticated, service_role;
drop trigger if exists trg_transfer_request_derive on public.transfer_requests;
create trigger trg_transfer_request_derive before insert or update of details, kind on public.transfer_requests
  for each row execute function public.trg_transfer_request_derive();
update public.transfer_requests set details = details where kind = 'materials';

-- Submit: accept the ATCO field set plus category and volume.
create or replace function public.submit_transfer_request(p_org uuid, p_kind text, p_key uuid, p_details jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_existing public.transfer_requests%rowtype; v_id uuid; k text; v text; allowed text[]; u text; n numeric;
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
 perform 1 from public.organizations where id = p_org and status = 'approved' for share;
 if not found then raise exception 'organization_not_approved' using errcode = '42501'; end if;
 perform 1 from public.profiles where id = auth.uid() for share;
 perform 1 from public.organization_memberships where organization_id = p_org and user_id = auth.uid() for share;
 if not public.has_org_role(p_org, '{company_admin,company_booker}') then raise exception 'not_a_member' using errcode = '42501'; end if;
 if p_key is null or p_kind is null or p_kind not in ('materials', 'charter') or jsonb_typeof(p_details) is distinct from 'object' then
   raise exception 'invalid request' using errcode = '22023'; end if;
 allowed := case when p_kind = 'materials' then array['description', 'destination', 'date', 'quantity', 'weight_kg',
   'dimensions', 'volume_cbm', 'category', 'sender', 'receiver', 'handling', 'photo_urls', 'hazardous', 'notes']
   else array['description', 'destination', 'date', 'time', 'passengers', 'duration', 'materials', 'notes'] end;
 for k, v in select key, value from jsonb_each_text(p_details) loop
  if not k = any(allowed) then raise exception 'invalid details' using errcode = '22023'; end if;
  if k = 'photo_urls' then
    if jsonb_typeof(p_details->k) <> 'array' then raise exception 'invalid photo_urls' using errcode = '22023'; end if;
    for u in select jsonb_array_elements_text(p_details->k) loop
      if u is null or char_length(u) > 2048 or u !~ '^https?://' then raise exception 'invalid photo url' using errcode = '22023'; end if;
    end loop;
  else
    if jsonb_typeof(p_details->k) <> 'string' or char_length(v) > 1000 then raise exception 'invalid details' using errcode = '22023'; end if;
  end if;
 end loop;
 if nullif(btrim(p_details->>'description'), '') is null then raise exception 'invalid description' using errcode = '22023'; end if;
 if coalesce(p_details->>'date', '') <> '' then
  if (p_details->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid date' using errcode = '22023'; end if;
  perform (p_details->>'date')::date;
 end if;
 if p_kind = 'materials' then
  if coalesce(p_details->>'quantity', '') <> '' and (p_details->>'quantity') !~ '^[1-9][0-9]{0,5}$' then raise exception 'invalid quantity' using errcode = '22023'; end if;
  if coalesce(p_details->>'weight_kg', '') <> '' then
    if (p_details->>'weight_kg') !~ '^[0-9]+([.][0-9]{1,2})?$' then raise exception 'invalid weight_kg' using errcode = '22023'; end if;
    n := (p_details->>'weight_kg')::numeric;
    if n <= 0 or n > 1000000 then raise exception 'invalid weight_kg' using errcode = '22023'; end if;
  end if;
  if coalesce(p_details->>'volume_cbm', '') <> '' then
    if (p_details->>'volume_cbm') !~ '^[0-9]+([.][0-9]{1,3})?$' or (p_details->>'volume_cbm')::numeric <= 0 or (p_details->>'volume_cbm')::numeric > 10000 then
      raise exception 'invalid volume_cbm' using errcode = '22023'; end if;
  end if;
  if coalesce(p_details->>'category', '') <> '' and (p_details->>'category') not in
     ('general', 'equipment', 'spare_parts', 'provisions', 'documents', 'dangerous_goods', 'other') then
    raise exception 'invalid category' using errcode = '22023'; end if;
  if coalesce(p_details->>'handling', '') <> '' and char_length(p_details->>'handling') > 200 then raise exception 'invalid handling' using errcode = '22023'; end if;
  if coalesce(p_details->>'hazardous', '') <> '' and (p_details->>'hazardous') not in ('true', 'false') then raise exception 'invalid hazardous flag' using errcode = '22023'; end if;
 else
  if coalesce(p_details->>'time', '') <> '' and (p_details->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'invalid time' using errcode = '22023'; end if;
  if coalesce(p_details->>'passengers', '') <> '' and (p_details->>'passengers') !~ '^[1-9][0-9]{0,3}$' then raise exception 'invalid passengers' using errcode = '22023'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_key::text, 1));
 select * into v_existing from public.transfer_requests where created_by = auth.uid() and request_key = p_key;
 if found then
  if v_existing.details <> p_details or v_existing.kind <> p_kind or v_existing.organization_id <> p_org then raise exception 'payload_mismatch' using errcode = '22023'; end if;
  return v_existing.id;
 end if;
 insert into public.transfer_requests (organization_id, created_by, request_key, kind, details) values (p_org, auth.uid(), p_key, p_kind, p_details) returning id into v_id;
 insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (v_id, 'pending_review', '', auth.uid());
 return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 2. Safety review (every material request) and review decisions
-- ---------------------------------------------------------------------------
create or replace function public.record_material_safety_review(p_request_id uuid, p_decision text, p_reference text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype; v_reason text;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  if p_decision is null or p_decision not in ('accepted', 'refused') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found or v_r.kind <> 'materials' then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status not in ('pending_review', 'clarification_required', 'reviewed_for_planning') then raise exception 'invalid_transition' using errcode = '55000'; end if;
  -- Declared/dangerous goods need a documented permit/approval reference.
  if p_decision = 'accepted' and v_r.declared_hazardous and nullif(btrim(p_reference), '') is null then
    raise exception 'permit_reference_required: hazardous or dangerous goods need a recorded approval reference' using errcode = '22023'; end if;
  update public.transfer_requests set safety_decision = p_decision, safety_reference = nullif(btrim(p_reference), ''),
    safety_reviewed_by = auth.uid(), safety_reviewed_at = now(), updated_at = now() where id = p_request_id;
  insert into public.transfer_request_events (request_id, status, reason, actor_user_id)
  values (p_request_id, case when p_decision = 'accepted' then 'safety_accepted' else 'safety_refused' end, v_reason, auth.uid());
  return p_decision;
end; $$;

create or replace function public.review_transfer_request(p_id uuid, p_revision integer, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_request public.transfer_requests%rowtype;
begin
 perform 1 from public.profiles where id = auth.uid() for share;
 perform 1 from public.role_assignments where user_id = auth.uid() and organization_id is null for share;
 if not public.has_platform_role('{super_admin,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
 if p_status is null or p_status not in ('clarification_required', 'reviewed_for_planning', 'approved', 'rejected')
    or nullif(btrim(p_reason), '') is null or char_length(p_reason) > 500 then raise exception 'invalid decision' using errcode = '22023'; end if;
 select * into v_request from public.transfer_requests where id = p_id for update;
 if not found then raise exception 'not found' using errcode = 'P0002'; end if;
 if v_request.revision = p_revision + 1 and v_request.status = p_status and exists (select 1 from public.transfer_request_events
    where request_id = p_id and status = p_status and reason = btrim(p_reason) and actor_user_id = auth.uid()) then return 'unchanged'; end if;
 if p_revision is null or v_request.revision <> p_revision or v_request.status not in ('pending_review', 'clarification_required', 'reviewed_for_planning') then
   raise exception 'invalid_transition' using errcode = '55000'; end if;
 if p_status = 'approved' and v_request.kind = 'materials' and v_request.safety_decision <> 'accepted' then
   raise exception 'safety_review_required: record an accepted safety review before approval' using errcode = '55000'; end if;
 update public.transfer_requests set status = p_status, revision = revision + 1, updated_at = now() where id = p_id;
 insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_id, p_status, btrim(p_reason), auth.uid());
 return 'recorded';
end; $$;

create or replace function public.cancel_transfer_request(p_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype; v_staff boolean; v_reason text;
begin
  v_reason := public._valid_reason(p_reason);
  select * into v_r from public.transfer_requests where id = p_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  v_staff := public.has_platform_role('{super_admin,operations}');
  if not (v_staff or v_r.created_by = auth.uid() or public.has_org_role(v_r.organization_id, '{company_admin}')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_r.status in ('cancelled', 'rejected', 'delivered', 'completed') then raise exception 'invalid_transition' using errcode = '55000'; end if;
  if not v_staff and v_r.status in ('scheduled', 'confirmed') then raise exception 'change_window_closed: contact ATCO operations' using errcode = '55000'; end if;
  if v_r.kind = 'materials' and v_r.status = 'scheduled' then
    update public.sailings s set payload_booked_kg = greatest(0, s.payload_booked_kg - a.weight_kg)
      from public.material_assignments a where a.request_id = p_id and a.sailing_id = s.id;
    delete from public.material_assignments where request_id = p_id;
  end if;
  delete from public.charter_allocations where request_id = p_id;
  update public.transfer_requests set status = 'cancelled', revision = revision + 1, updated_at = now() where id = p_id;
  insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_id, 'cancelled', v_reason, auth.uid());
  return 'cancelled';
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Parameterised material tariffs and quotes
-- ---------------------------------------------------------------------------
alter table public.material_tariffs
  add column if not exists category text,
  add column if not exists destination text,
  add column if not exists handling text,
  add column if not exists min_charge_halala bigint not null default 0 check (min_charge_halala >= 0),
  add column if not exists max_weight_kg integer,
  add column if not exists approval_status text not null default 'provisional'
    constraint material_tariffs_approval_check check (approval_status in ('provisional', 'approved', 'retired')),
  add column if not exists vat_mode text not null default 'not_configured'
    constraint material_tariffs_vat_mode_check check (vat_mode in ('not_configured', 'exclusive', 'inclusive', 'exempt', 'zero_rated')),
  add column if not exists vat_rate_bp integer not null default 0;
revoke insert, update, delete on public.material_tariffs from authenticated;

create or replace function public.publish_material_tariff(p_code text, p_basis text, p_rate_halala bigint, p_min_charge_halala bigint,
  p_category text, p_destination text, p_handling text, p_max_weight_kg integer, p_vat_mode text, p_vat_rate_bp integer, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._require_staff('{super_admin,finance}');
  if nullif(btrim(p_code), '') is null or p_basis not in ('per_kg', 'per_cbm', 'per_item', 'flat') or p_rate_halala is null or p_rate_halala < 0
     or coalesce(p_min_charge_halala, 0) < 0 or p_vat_mode not in ('not_configured', 'exclusive', 'inclusive', 'exempt', 'zero_rated')
     or (p_vat_mode in ('exclusive', 'inclusive') and coalesce(p_vat_rate_bp, 0) not between 1 and 10000) then
    raise exception 'invalid tariff' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  insert into public.material_tariffs (code, basis, rate_halala, currency, active, created_by, category, destination, handling,
    min_charge_halala, max_weight_kg, vat_mode, vat_rate_bp)
  values (btrim(p_code), p_basis, p_rate_halala, 'SAR', true, auth.uid(), nullif(btrim(p_category), ''), nullif(btrim(p_destination), ''),
    nullif(btrim(p_handling), ''), coalesce(p_min_charge_halala, 0), p_max_weight_kg, p_vat_mode,
    case when p_vat_mode in ('exclusive', 'inclusive') then p_vat_rate_bp else 0 end)
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.set_material_tariff_status(p_id uuid, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_creator uuid;
begin
  perform public._require_staff('{super_admin,finance}');
  if p_status not in ('approved', 'retired') then raise exception 'invalid status' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  select created_by into v_creator from public.material_tariffs where id = p_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_status = 'approved' and v_creator = auth.uid() then raise exception 'four_eyes_required' using errcode = '42501'; end if;
  update public.material_tariffs set approval_status = p_status, active = (p_status = 'approved') where id = p_id;
  return p_status;
end; $$;

create table if not exists public.material_quotes (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.transfer_requests (id) on delete cascade,
  tariff_id    uuid not null references public.material_tariffs (id),
  basis        text not null,
  quantity     numeric(12,3) not null,
  net_halala   bigint not null check (net_halala >= 0),
  vat_halala   bigint not null check (vat_halala >= 0),
  total_halala bigint not null check (total_halala >= 0),
  status       text not null default 'indicative' constraint material_quotes_status_check check (status in ('indicative', 'approved', 'superseded')),
  created_by   uuid references auth.users (id),
  approved_by  uuid references auth.users (id),
  created_at   timestamptz not null default now()
);
create unique index if not exists material_quotes_one_current on public.material_quotes (request_id) where status <> 'superseded';
alter table public.material_quotes enable row level security;
drop policy if exists material_quotes_select on public.material_quotes;
create policy material_quotes_select on public.material_quotes for select to authenticated
  using (exists (select 1 from public.transfer_requests r where r.id = material_quotes.request_id));
revoke all on public.material_quotes from public, anon, authenticated, service_role;
grant select on public.material_quotes to authenticated;

create or replace function public.quote_material_request(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype; v_t public.material_tariffs%rowtype; v_qty numeric; v_amount bigint; v_x record; v_id uuid;
begin
  perform public._require_staff('{super_admin,operations,finance}');
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found or v_r.kind <> 'materials' then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status in ('rejected', 'cancelled', 'delivered') then raise exception 'invalid_transition' using errcode = '55000'; end if;
  select * into v_t from public.material_tariffs t
   where t.active and t.approval_status in ('approved', 'provisional')
     and (t.category is null or t.category = v_r.details ->> 'category')
     and (t.destination is null or lower(t.destination) = lower(v_r.details ->> 'destination'))
     and (t.handling is null or lower(t.handling) = lower(v_r.details ->> 'handling'))
     and (t.max_weight_kg is null or v_r.weight_kg is null or v_r.weight_kg <= t.max_weight_kg)
   order by (t.approval_status = 'approved') desc,
            ((t.category is not null)::int + (t.destination is not null)::int + (t.handling is not null)::int) desc, t.created_at desc
   limit 1;
  if not found then raise exception 'no_matching_tariff' using errcode = 'P0001'; end if;
  v_qty := case v_t.basis
    when 'per_kg' then v_r.weight_kg
    when 'per_cbm' then case when coalesce(v_r.details ->> 'volume_cbm', '') <> '' then (v_r.details ->> 'volume_cbm')::numeric end
    when 'per_item' then case when coalesce(v_r.details ->> 'quantity', '') <> '' then (v_r.details ->> 'quantity')::numeric end
    else 1 end;
  if v_qty is null then raise exception 'quote_input_missing: weight, volume or quantity is required for this tariff basis' using errcode = '22023'; end if;
  v_amount := greatest(ceil(v_qty * v_t.rate_halala)::bigint, v_t.min_charge_halala);
  select * into v_x from public.vat_breakdown(v_amount, v_t.vat_mode, v_t.vat_rate_bp);
  update public.material_quotes set status = 'superseded' where request_id = p_request_id and status <> 'superseded';
  insert into public.material_quotes (request_id, tariff_id, basis, quantity, net_halala, vat_halala, total_halala, created_by)
  values (p_request_id, v_t.id, v_t.basis, v_qty, v_x.net_halala, v_x.vat_halala, v_x.gross_halala, auth.uid()) returning id into v_id;
  insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_request_id, 'quoted', 'Quote ' || v_x.gross_halala || ' halala (' || v_t.code || ')', auth.uid());
  return v_id;
end; $$;

create or replace function public.approve_material_quote(p_quote_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_q public.material_quotes%rowtype; v_tstatus text;
begin
  perform public._require_staff('{super_admin,finance}');
  perform public._valid_reason(p_reason);
  select * into v_q from public.material_quotes where id = p_quote_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_q.status = 'approved' then return 'unchanged'; end if;
  if v_q.status <> 'indicative' then raise exception 'invalid_transition' using errcode = '55000'; end if;
  select approval_status into v_tstatus from public.material_tariffs where id = v_q.tariff_id;
  if v_tstatus <> 'approved' then raise exception 'tariff_not_approved: material tariffs need ATCO approval before quotes are binding' using errcode = '55000'; end if;
  update public.material_quotes set status = 'approved', approved_by = auth.uid() where id = p_quote_id;
  return 'approved';
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Payload-checked assignment, manifest, delivery
-- ---------------------------------------------------------------------------
create table if not exists public.material_assignments (
  request_id  uuid primary key references public.transfer_requests (id) on delete cascade,
  sailing_id  uuid not null references public.sailings (id),
  weight_kg   integer not null check (weight_kg > 0),
  assigned_by uuid references auth.users (id),
  assigned_at timestamptz not null default now()
);
alter table public.material_assignments enable row level security;
drop policy if exists material_assignments_select on public.material_assignments;
create policy material_assignments_select on public.material_assignments for select to authenticated
  using (public.has_platform_role('{super_admin,operations,boarding_staff}')
         or exists (select 1 from public.transfer_requests r where r.id = material_assignments.request_id));
revoke all on public.material_assignments from public, anon, authenticated, service_role;
grant select on public.material_assignments to authenticated;

create or replace function public.assign_material_to_sailing(p_request_id uuid, p_sailing_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype; v_s record; v_cap integer; v_allow integer; v_reason text;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found or v_r.kind <> 'materials' then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'approved' then raise exception 'invalid_transition: approve the request first' using errcode = '55000'; end if;
  if v_r.safety_decision <> 'accepted' then raise exception 'safety_review_required' using errcode = '55000'; end if;
  if v_r.weight_kg is null then raise exception 'weight_required' using errcode = '22023'; end if;
  select s.id, s.status, s.departs_at, s.seats_booked, s.payload_booked_kg, coalesce(s.payload_capacity_kg, v.payload_capacity_kg) as cap
    into v_s from public.sailings s join public.vessels v on v.id = s.vessel_id where s.id = p_sailing_id for update of s;
  if not found or v_s.status <> 'open' or v_s.departs_at <= now() then raise exception 'sailing_unavailable' using errcode = 'P0001'; end if;
  if v_s.cap is null then raise exception 'payload_capacity_unknown: record the vessel or sailing payload limit first' using errcode = '55000'; end if;
  v_allow := coalesce(public.setting_int('payload.passenger_allowance_kg', null), 0);
  if v_s.payload_booked_kg + v_r.weight_kg + v_s.seats_booked * v_allow > v_s.cap then raise exception 'payload_exceeded' using errcode = 'P0001'; end if;
  update public.sailings set payload_booked_kg = payload_booked_kg + v_r.weight_kg where id = p_sailing_id;
  insert into public.material_assignments (request_id, sailing_id, weight_kg, assigned_by) values (p_request_id, p_sailing_id, v_r.weight_kg, auth.uid());
  update public.transfer_requests set status = 'scheduled', revision = revision + 1, updated_at = now() where id = p_request_id;
  insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_request_id, 'scheduled', v_reason, auth.uid());
  return 'scheduled';
end; $$;

create or replace function public.set_payload_capacity(p_vessel_id uuid, p_sailing_id uuid, p_capacity_kg integer, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_staff('{super_admin,operations}');
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  if p_capacity_kg is not null and (p_capacity_kg < 0 or p_capacity_kg > 1000000) then raise exception 'invalid capacity' using errcode = '22023'; end if;
  if p_sailing_id is not null then
    if exists (select 1 from public.sailings where id = p_sailing_id and payload_booked_kg > coalesce(p_capacity_kg, 2147483647)) then
      raise exception 'invalid capacity: below already assigned payload' using errcode = '22023'; end if;
    update public.sailings set payload_capacity_kg = p_capacity_kg where id = p_sailing_id;
  elsif p_vessel_id is not null then
    update public.vessels set payload_capacity_kg = p_capacity_kg where id = p_vessel_id;
  else raise exception 'invalid input' using errcode = '22023'; end if;
  return 'updated';
end; $$;

create or replace function public.material_manifest(p_sailing_id uuid)
returns table (request_reference text, organization text, description text, category text, weight_kg integer,
               declared_hazardous boolean, safety_reference text, handling text, receiver text, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select r.reference, o.display_name, r.details ->> 'description', r.details ->> 'category', a.weight_kg,
      r.declared_hazardous, r.safety_reference, r.details ->> 'handling', r.details ->> 'receiver', r.status
    from public.material_assignments a join public.transfer_requests r on r.id = a.request_id
    join public.organizations o on o.id = r.organization_id
   where a.sailing_id = p_sailing_id order by r.reference;
end; $$;

-- Proof of delivery follows the materials_safety policy (default: signature or photo).
create or replace function public.record_delivery(p_request_id uuid, p_receiver_name text, p_signature_ref text, p_photo_urls text[], p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; u text; v_r public.transfer_requests%rowtype; v_proof text;
begin
  if p_request_id is null then raise exception 'invalid request' using errcode = '22023'; end if;
  perform public._require_staff('{super_admin,operations}');
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.kind = 'materials' and v_r.status <> 'scheduled' then raise exception 'invalid_transition: only scheduled materials can be delivered' using errcode = '55000'; end if;
  if p_receiver_name is null or char_length(btrim(p_receiver_name)) < 1 or char_length(btrim(p_receiver_name)) > 120 then
    raise exception 'invalid receiver name' using errcode = '22023'; end if;
  if p_signature_ref is not null and char_length(p_signature_ref) > 256 then raise exception 'invalid signature reference' using errcode = '22023'; end if;
  if p_notes is not null and char_length(p_notes) > 1000 then raise exception 'invalid notes' using errcode = '22023'; end if;
  if p_photo_urls is not null then
    if cardinality(p_photo_urls) > 10 then raise exception 'too many photos' using errcode = '22023'; end if;
    foreach u in array p_photo_urls loop
      if u is null or char_length(u) > 2048 or not (u ~ '^https://' or u ~ ('^storage://material-attachments/' || v_r.organization_id || '/' || p_request_id || '/')) then
        raise exception 'invalid photo reference' using errcode = '22023'; end if;
    end loop;
  end if;
  select coalesce((select sp.content ->> 'delivery_proof' from public.service_policies sp where sp.policy_type = 'materials_safety'
                    and sp.status in ('approved', 'provisional') order by (sp.status = 'approved') desc, sp.effective_from desc limit 1), 'signature_or_photo') into v_proof;
  if v_proof in ('signature', 'signature_and_photo') and nullif(btrim(p_signature_ref), '') is null then raise exception 'signature_required' using errcode = '22023'; end if;
  if v_proof in ('photo', 'signature_and_photo') and coalesce(cardinality(p_photo_urls), 0) = 0 then raise exception 'photo_required' using errcode = '22023'; end if;
  if v_proof = 'signature_or_photo' and nullif(btrim(p_signature_ref), '') is null and coalesce(cardinality(p_photo_urls), 0) = 0 then
    raise exception 'proof_required: a signature reference or photo is required' using errcode = '22023'; end if;
  insert into public.delivery_records (request_id, receiver_name, signature_ref, photo_urls, notes, created_by)
  values (p_request_id, btrim(p_receiver_name), nullif(btrim(p_signature_ref), ''), coalesce(p_photo_urls, '{}'), nullif(btrim(p_notes), ''), auth.uid())
  returning id into v_id;
  if v_r.kind = 'materials' then
    update public.transfer_requests set status = 'delivered', revision = revision + 1, updated_at = now() where id = p_request_id;
    insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_request_id, 'delivered', 'Delivered to ' || btrim(p_receiver_name), auth.uid());
  end if;
  return v_id;
end; $$;

insert into public.service_policies (policy_type, version, content, status) values
  ('materials_safety', 'v1-provisional', '{"delivery_proof": "signature_or_photo", "every_request_needs_safety_review": true,
    "dangerous_goods": "Accepted only with a recorded permit/approval reference after ATCO operational review.",
    "note": "Provisional. Insurance, permits and carriage limits pending ATCO confirmation."}', 'provisional')
on conflict (policy_type, version) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Private attachments (Supabase Storage), registered and validated
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    -- The storage service owns this schema; older schema versions lack "public" (all private).
    if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public') then
      execute $q$insert into storage.buckets (id, name, public) values ('material-attachments', 'material-attachments', false)
        on conflict (id) do update set public = false$q$;
    else
      insert into storage.buckets (id, name) values ('material-attachments', 'material-attachments') on conflict (id) do nothing;
    end if;
    -- Newer storage schemas enforce limits server-side as well.
    if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
      execute $q$update storage.buckets set file_size_limit = 10485760,
        allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] where id = 'material-attachments'$q$;
    end if;
  end if;
end $$;

create table if not exists public.transfer_request_attachments (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.transfer_requests (id) on delete cascade,
  object_path text not null unique constraint transfer_request_attachments_path_length check (char_length(object_path) <= 512),
  mime_type   text not null constraint transfer_request_attachments_mime_check check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes  integer not null constraint transfer_request_attachments_size_check check (size_bytes between 1 and 10485760),
  sha256      text constraint transfer_request_attachments_sha_format check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid references auth.users (id),
  created_at  timestamptz not null default now()
);
alter table public.transfer_request_attachments enable row level security;
drop policy if exists transfer_request_attachments_select on public.transfer_request_attachments;
create policy transfer_request_attachments_select on public.transfer_request_attachments for select to authenticated
  using (exists (select 1 from public.transfer_requests r where r.id = transfer_request_attachments.request_id));
revoke all on public.transfer_request_attachments from public, anon, authenticated, service_role;
grant select on public.transfer_request_attachments to authenticated;

-- Path convention: <organization_id>/<request_id>/<uuid>.<ext>
create or replace function public.can_write_request_object(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.transfer_requests r
    where array_length(string_to_array(p_name, '/'), 1) = 3
      and r.organization_id::text = split_part(p_name, '/', 1) and r.id::text = split_part(p_name, '/', 2)
      and r.status in ('pending_review', 'clarification_required')
      and (r.created_by = auth.uid() or public.has_org_role(r.organization_id, '{company_admin}'))
      and split_part(p_name, '/', 3) ~ '^[0-9a-f-]{36}[.](jpg|jpeg|png|webp|pdf)$')
$$;
create or replace function public.can_read_request_object(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.transfer_requests r
    where r.organization_id::text = split_part(p_name, '/', 1) and r.id::text = split_part(p_name, '/', 2)
      and public.can_read_transfer(r.organization_id, r.created_by))
$$;
revoke all on function public.can_write_request_object(text), public.can_read_request_object(text) from public, anon;
grant execute on function public.can_write_request_object(text), public.can_read_request_object(text) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists gm_material_attachments_insert on storage.objects';
    execute 'drop policy if exists gm_material_attachments_select on storage.objects';
    execute $p$create policy gm_material_attachments_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'material-attachments' and public.can_write_request_object(name))$p$;
    execute $p$create policy gm_material_attachments_select on storage.objects for select to authenticated
      using (bucket_id = 'material-attachments' and public.can_read_request_object(name))$p$;
  end if;
end $$;

create or replace function public.register_request_attachment(p_request_id uuid, p_object_path text, p_mime_type text, p_size_bytes integer, p_sha256 text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not public.can_write_request_object(p_object_path) or split_part(p_object_path, '/', 2) <> p_request_id::text then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then raise exception 'unsupported file type' using errcode = '22023'; end if;
  if (p_mime_type = 'application/pdf') <> (p_object_path ~ '[.]pdf$') then raise exception 'file extension does not match type' using errcode = '22023'; end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then raise exception 'file too large (max 10 MB)' using errcode = '22023'; end if;
  if p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid checksum' using errcode = '22023'; end if;
  if (select count(*) from public.transfer_request_attachments where request_id = p_request_id) >= 10 then raise exception 'too many attachments (max 10)' using errcode = '22023'; end if;
  insert into public.transfer_request_attachments (request_id, object_path, mime_type, size_bytes, sha256, uploaded_by)
  values (p_request_id, p_object_path, p_mime_type, p_size_bytes, p_sha256, auth.uid()) returning id into v_id;
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Charters: confirmed only with a conflict-free allocation
-- ---------------------------------------------------------------------------
create table if not exists public.charter_allocations (
  request_id          uuid primary key references public.transfer_requests (id) on delete cascade,
  vessel_id           uuid not null references public.vessels (id),
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  quoted_total_halala bigint check (quoted_total_halala is null or quoted_total_halala >= 0),
  notes               text check (notes is null or char_length(notes) <= 1000),
  allocated_by        uuid references auth.users (id),
  created_at          timestamptz not null default now(),
  constraint charter_allocations_window check (ends_at > starts_at and ends_at - starts_at <= interval '72 hours')
);
alter table public.charter_allocations enable row level security;
drop policy if exists charter_allocations_select on public.charter_allocations;
create policy charter_allocations_select on public.charter_allocations for select to authenticated
  using (exists (select 1 from public.transfer_requests r where r.id = charter_allocations.request_id));
revoke all on public.charter_allocations from public, anon, authenticated, service_role;
grant select on public.charter_allocations to authenticated;

create or replace function public.allocate_charter(p_request_id uuid, p_vessel_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
  p_quoted_total_halala bigint, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype; v_reason text;
begin
  perform public._require_staff('{super_admin,operations}');
  v_reason := public._valid_reason(p_reason);
  if p_vessel_id is null or p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at or p_starts_at <= now()
     or p_ends_at - p_starts_at > interval '72 hours' then raise exception 'invalid window' using errcode = '22023'; end if;
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found or v_r.kind <> 'charter' then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'approved' then raise exception 'invalid_transition: approve the charter request first' using errcode = '55000'; end if;
  perform 1 from public.vessels where id = p_vessel_id and status = 'active' for update;
  if not found then raise exception 'invalid vessel' using errcode = '22023'; end if;
  -- Conflicts: any non-cancelled sailing of the vessel within the window (+/- 1 h turnaround) or another charter.
  if exists (select 1 from public.sailings s where s.vessel_id = p_vessel_id and s.status <> 'cancelled'
             and s.departs_at between p_starts_at - interval '1 hour' and p_ends_at + interval '1 hour')
     or exists (select 1 from public.charter_allocations a where a.vessel_id = p_vessel_id
             and tstzrange(a.starts_at, a.ends_at) && tstzrange(p_starts_at, p_ends_at)) then
    raise exception 'vessel_conflict: the vessel is not free in this window' using errcode = 'P0001'; end if;
  insert into public.charter_allocations (request_id, vessel_id, starts_at, ends_at, quoted_total_halala, notes, allocated_by)
  values (p_request_id, p_vessel_id, p_starts_at, p_ends_at, p_quoted_total_halala, v_reason, auth.uid());
  update public.transfer_requests set status = 'confirmed', revision = revision + 1, updated_at = now() where id = p_request_id;
  insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_request_id, 'confirmed', v_reason, auth.uid());
  return 'confirmed';
end; $$;

create or replace function public.complete_charter(p_request_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.transfer_requests%rowtype;
begin
  perform public._require_staff('{super_admin,operations}');
  select * into v_r from public.transfer_requests where id = p_request_id for update;
  if not found or v_r.kind <> 'charter' then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'confirmed' then raise exception 'invalid_transition' using errcode = '55000'; end if;
  update public.transfer_requests set status = 'completed', revision = revision + 1, updated_at = now() where id = p_request_id;
  insert into public.transfer_request_events (request_id, status, reason, actor_user_id) values (p_request_id, 'completed', public._valid_reason(p_reason), auth.uid());
  return 'completed';
end; $$;

do $$
declare f text;
begin
  foreach f in array array['record_material_safety_review(uuid, text, text, text)', 'cancel_transfer_request(uuid, text)',
    'publish_material_tariff(text, text, bigint, bigint, text, text, text, integer, text, integer, text)',
    'set_material_tariff_status(uuid, text, text)', 'quote_material_request(uuid)', 'approve_material_quote(uuid, text)',
    'assign_material_to_sailing(uuid, uuid, text)', 'set_payload_capacity(uuid, uuid, integer, text)', 'material_manifest(uuid)',
    'register_request_attachment(uuid, text, text, integer, text)', 'allocate_charter(uuid, uuid, timestamptz, timestamptz, bigint, text)',
    'complete_charter(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
