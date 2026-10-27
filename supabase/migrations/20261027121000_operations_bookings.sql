-- ===========================================================================
-- 20261027121000 — Vessels, routes, sailings and bookings (core booking journey)
-- ===========================================================================
-- Phase 3. Additive: no earlier migration is edited.
--
-- SCOPE (deliberately minimal):
--   vessels, routes, sailings  — ATCO-controlled operational data.
--   bookings, booking_legs     — passenger seat reservations on sailings.
-- NOT modelled (no confirmed ATCO rule): fares/prices, VAT, payments, refunds,
-- cancellations, no-shows, tickets/QR, boarding, permits, materials, charters.
-- No column here claims a booking is paid or operationally approved.
--
-- WHO MAY DO WHAT (narrowest defensible reading; see phase3 doc / pending rules):
--   * read vessels/routes/sailings: any signed-in user (published schedule data;
--     no personal data). anon: nothing.
--   * write vessels/routes/sailings: platform roles super_admin, operations — via
--     RLS + column-level grants (seats_booked is never client-writable). No DELETE.
--   * create bookings: ONLY create_booking(); caller must be an ACTIVE
--     company_admin/company_booker member of an APPROVED organisation and must
--     not have a suspended profile. Individual (non-company) booking is not
--     enabled: whether checkout requires an account is an open ATCO decision.
--   * read bookings: the creator; company_admin of that organisation (active
--     membership, organisation approved or pending); super_admin/operations.
--     company_booker sees only bookings they created. finance/boarding: none yet.
--
-- CAPACITY: sailings.seats_booked is changed only inside create_booking() under
-- SELECT ... FOR UPDATE row locks (taken in id order to avoid deadlocks), and the
-- CHECK sailings_no_oversell (seats_booked <= seat_capacity) makes an oversell
-- impossible even if application logic were wrong. seat_capacity is entered by
-- ATCO staff per sailing (never assumed); if the vessel has a recorded
-- passenger_capacity the sailing may not exceed it.
--
-- IDEMPOTENCY: create_booking() takes a client-generated request key, unique per
-- creator. A retry with the same key and the same normalised payload returns the
-- existing booking (outcome 'replayed'); the same key with a different payload is
-- 'payload_mismatch'. A transaction-scoped advisory lock on (user, key) serialises
-- concurrent retries.
--
-- Grants follow 20261026150240: revoke everything app roles received from the
-- default privileges, then grant exactly what is needed. EXECUTE on new functions
-- is revoked from public, anon AND service_role (default privileges grant it).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Shared trigger: server-side created_by / updated_by stamping.
-- ---------------------------------------------------------------------------
create or replace function public.stamp_actor_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    new.created_by := old.created_by;  -- immutable after insert
    -- A seat-count change made by create_booking() is not a staff edit: keep the
    -- last staff editor rather than recording the booking customer.
    if (to_jsonb(new) - 'seats_booked' - 'updated_at' - 'updated_by')
       = (to_jsonb(old) - 'seats_booked' - 'updated_at' - 'updated_by') then
      new.updated_by := old.updated_by;
      return new;
    end if;
  end if;
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- vessels
-- ---------------------------------------------------------------------------
create table public.vessels (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null
                     constraint vessels_name_length check (char_length(btrim(name)) between 1 and 120),
  -- Recorded only when ATCO supplies it; NULL means "not recorded", never "unlimited".
  passenger_capacity integer
                     constraint vessels_capacity_range check (passenger_capacity between 1 and 1000),
  status             text not null default 'active'
                     constraint vessels_status_check check (status in ('active', 'inactive')),
  created_by         uuid references auth.users (id),
  updated_by         uuid references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index vessels_name_uidx on public.vessels (lower(btrim(name)));

create trigger trg_vessels_updated_at before update on public.vessels
  for each row execute function public.set_updated_at();
create trigger trg_vessels_actor before insert or update on public.vessels
  for each row execute function public.stamp_actor_columns();

comment on table public.vessels is
  'ATCO vessels. Written by super_admin/operations only (RLS). passenger_capacity NULL = not recorded.';

-- ---------------------------------------------------------------------------
-- routes (one direction each; a return journey uses the reverse route)
-- ---------------------------------------------------------------------------
create table public.routes (
  id          uuid primary key default gen_random_uuid(),
  origin      text not null
              constraint routes_origin_length check (char_length(btrim(origin)) between 1 and 120),
  destination text not null
              constraint routes_destination_length check (char_length(btrim(destination)) between 1 and 120),
  status      text not null default 'active'
              constraint routes_status_check check (status in ('active', 'inactive')),
  created_by  uuid references auth.users (id),
  updated_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint routes_distinct_ends check (lower(btrim(origin)) <> lower(btrim(destination)))
);
create unique index routes_pair_uidx on public.routes (lower(btrim(origin)), lower(btrim(destination)));

create trigger trg_routes_updated_at before update on public.routes
  for each row execute function public.set_updated_at();
create trigger trg_routes_actor before insert or update on public.routes
  for each row execute function public.stamp_actor_columns();

comment on table public.routes is
  'One-directional transport legs (origin -> destination). Names are entered by ATCO staff; none are seeded.';

-- ---------------------------------------------------------------------------
-- sailings
-- ---------------------------------------------------------------------------
create table public.sailings (
  id            uuid primary key default gen_random_uuid(),
  route_id      uuid not null references public.routes (id),
  vessel_id     uuid not null references public.vessels (id),
  departs_at    timestamptz not null,
  seat_capacity integer not null
                constraint sailings_capacity_range check (seat_capacity between 1 and 1000),
  seats_booked  integer not null default 0
                constraint sailings_seats_booked_nonnegative check (seats_booked >= 0),
  status        text not null default 'open'
                constraint sailings_status_check check (status in ('open', 'closed', 'cancelled')),
  created_by    uuid references auth.users (id),
  updated_by    uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint sailings_no_oversell check (seats_booked <= seat_capacity),
  constraint sailings_vessel_departure_uniq unique (vessel_id, departs_at)
);
create index sailings_status_departs_idx on public.sailings (status, departs_at);
create index sailings_route_idx on public.sailings (route_id);

comment on column public.sailings.seats_booked is
  'Maintained only by create_booking() under a row lock; never client-writable. CHECK sailings_no_oversell.';
comment on column public.sailings.status is
  'open = accepting bookings; closed = no new bookings; cancelled = terminal. '
  'Operational sailing approval/clearance is a separate ATCO decision NOT modelled here.';

create trigger trg_sailings_updated_at before update on public.sailings
  for each row execute function public.set_updated_at();
create trigger trg_sailings_actor before insert or update on public.sailings
  for each row execute function public.stamp_actor_columns();

-- Integrity rules that need other tables (definer: reads vessels/routes regardless of RLS).
create or replace function public.guard_sailing_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vessel record;
  v_route_status text;
begin
  if tg_op = 'UPDATE' and old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'invalid_transition: a cancelled sailing cannot be reopened' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.seats_booked > 0
     and (new.route_id <> old.route_id or new.departs_at <> old.departs_at) then
    raise exception 'sailing_has_bookings: route and departure time cannot change once seats are booked'
      using errcode = '55000';
  end if;

  select v.status, v.passenger_capacity into v_vessel from public.vessels as v where v.id = new.vessel_id;
  if tg_op = 'INSERT' or new.vessel_id <> old.vessel_id then
    if v_vessel.status <> 'active' then
      raise exception 'invalid vessel: vessel is inactive' using errcode = '22023';
    end if;
  end if;
  if v_vessel.passenger_capacity is not null and new.seat_capacity > v_vessel.passenger_capacity then
    raise exception 'invalid seat capacity: exceeds the vessel''s recorded passenger capacity' using errcode = '22023';
  end if;

  if tg_op = 'INSERT' or new.route_id <> old.route_id then
    select r.status into v_route_status from public.routes as r where r.id = new.route_id;
    if v_route_status <> 'active' then
      raise exception 'invalid route: route is inactive' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'INSERT' and new.departs_at <= now() then
    raise exception 'invalid departure: must be in the future' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger trg_sailings_guard before insert or update on public.sailings
  for each row execute function public.guard_sailing_write();

-- ---------------------------------------------------------------------------
-- bookings + booking_legs
-- ---------------------------------------------------------------------------
create table public.bookings (
  id              uuid primary key default gen_random_uuid(),
  reference       text not null
                  constraint bookings_reference_key unique
                  constraint bookings_reference_format check (reference ~ '^GM-[0-9A-F]{8}$'),
  organization_id uuid not null references public.organizations (id),
  created_by      uuid not null references auth.users (id),
  request_key     uuid not null,
  request_hash    text not null,
  -- 'reserved' = seats held on the sailing(s). It does NOT mean paid, ticketed,
  -- cleared for port access or boarded. No other state exists yet (no confirmed
  -- cancellation/refund policy).
  status          text not null default 'reserved'
                  constraint bookings_status_check check (status in ('reserved')),
  passenger_count integer not null
                  constraint bookings_passenger_count_range check (passenger_count between 1 and 1000),
  contact_name    text not null constraint bookings_contact_name_length check (char_length(contact_name) between 1 and 120),
  contact_email   text not null constraint bookings_contact_email_length check (char_length(contact_email) <= 254),
  contact_phone   text not null constraint bookings_contact_phone_length check (char_length(contact_phone) <= 20),
  passenger_names text[] not null
                  constraint bookings_passenger_names_count check (cardinality(passenger_names) between 1 and passenger_count),
  po_reference    text constraint bookings_po_length check (char_length(po_reference) <= 64),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint bookings_creator_request_key unique (created_by, request_key)
);
create index bookings_org_idx on public.bookings (organization_id, created_at desc);
create index bookings_creator_idx on public.bookings (created_by, created_at desc);

create trigger trg_bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

comment on table public.bookings is
  'Seat reservations. Created ONLY by create_booking(). No payment, ticket, clearance or boarding state.';

create table public.booking_legs (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  sailing_id uuid not null references public.sailings (id),
  leg        text not null constraint booking_legs_leg_check check (leg in ('outbound', 'return')),
  passengers integer not null constraint booking_legs_passengers_range check (passengers between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint booking_legs_one_per_direction unique (booking_id, leg)
);
create index booking_legs_sailing_idx on public.booking_legs (sailing_id);

comment on table public.booking_legs is
  'Outbound and return are separate legs on separate sailings, each holding its own seats.';

-- ---------------------------------------------------------------------------
-- create_booking()
-- ---------------------------------------------------------------------------
create or replace function public.create_booking(
  p_request_key         uuid,
  p_organization_id     uuid,
  p_outbound_sailing_id uuid,
  p_passenger_count     integer,
  p_contact_name        text,
  p_contact_email       text,
  p_contact_phone       text,
  p_passenger_names     text[] default null, -- optional extra names; the lead is p_contact_name
  p_return_sailing_id   uuid default null,
  p_po_reference        text default null
)
returns table (booking_id uuid, reference text, status text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid;
  v_name      text;
  v_email     text;
  v_phone     text;
  v_po        text;
  v_names     text[];
  v_extra     text;
  v_hash      text;
  v_existing  record;
  v_profile   text;
  v_org       text;
  v_out       record;
  v_ret       record;
  v_ref       text;
  v_id        uuid;
  v_attempt   integer := 0;
  v_constraint text;
begin
  -- 1. Identity -------------------------------------------------------------
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- 2. Input validation (normalise once; reused for hash and insert) ---------
  if p_request_key is null then
    raise exception 'invalid request key' using errcode = '22023';
  end if;
  if p_organization_id is null then
    raise exception 'invalid organization id' using errcode = '22023';
  end if;
  if p_outbound_sailing_id is null then
    raise exception 'invalid outbound sailing' using errcode = '22023';
  end if;
  if p_return_sailing_id is not null and p_return_sailing_id = p_outbound_sailing_id then
    raise exception 'invalid return sailing: must differ from the outbound sailing' using errcode = '22023';
  end if;
  if p_passenger_count is null or p_passenger_count < 1 or p_passenger_count > 1000 then
    raise exception 'invalid passenger count' using errcode = '22023';
  end if;

  v_name  := nullif(btrim(p_contact_name), '');
  v_email := nullif(lower(btrim(p_contact_email)), '');
  v_phone := nullif(btrim(p_contact_phone), '');
  v_po    := nullif(btrim(p_po_reference), '');
  if v_name is null or char_length(v_name) > 120 then
    raise exception 'invalid contact name (required, <= 120 chars)' using errcode = '22023';
  end if;
  if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid contact email' using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^\+?[0-9 ()-]{7,20}$' then
    raise exception 'invalid contact phone' using errcode = '22023';
  end if;
  if v_po is not null and char_length(v_po) > 64 then
    raise exception 'invalid po reference (<= 64 chars)' using errcode = '22023';
  end if;

  v_names := array[v_name];
  if p_passenger_names is not null then
    foreach v_extra in array p_passenger_names loop
      v_extra := nullif(btrim(v_extra), '');
      if v_extra is not null then
        if char_length(v_extra) > 120 then
          raise exception 'invalid passenger name (<= 120 chars)' using errcode = '22023';
        end if;
        v_names := v_names || v_extra;
      end if;
    end loop;
  end if;
  if cardinality(v_names) > p_passenger_count then
    raise exception 'invalid passenger names: more names than passengers' using errcode = '22023';
  end if;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'organization_id', p_organization_id,
    'outbound', p_outbound_sailing_id,
    'return', p_return_sailing_id,
    'passengers', p_passenger_count,
    'contact_name', v_name,
    'contact_email', v_email,
    'contact_phone', v_phone,
    'names', to_jsonb(v_names),
    'po', v_po)::text, 'sha256'), 'hex');

  -- 3. Serialise retries of the same request, then replay if already done ----
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_request_key::text, 0));

  select b.id, b.reference, b.status, b.request_hash into v_existing
    from public.bookings as b
   where b.created_by = v_uid and b.request_key = p_request_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      raise exception 'payload_mismatch: this request key was already used with different details'
        using errcode = '22023';
    end if;
    return query select v_existing.id, v_existing.reference, v_existing.status, 'replayed'::text;
    return;
  end if;

  -- 4. Authority: active, non-suspended profile; active member of APPROVED org --
  select p.status into v_profile from public.profiles as p where p.id = v_uid for share;
  if found and v_profile = 'suspended' then
    raise exception 'profile_suspended: suspended accounts may not book' using errcode = '28000';
  end if;

  if not exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = v_uid
          and m.status = 'active'
          and m.membership_role in ('company_admin', 'company_booker')) then
    raise exception 'not_a_member: you are not an active booker for this organization'
      using errcode = '42501';
  end if;

  select o.status into v_org from public.organizations as o where o.id = p_organization_id for share;
  if v_org is distinct from 'approved' then
    raise exception 'organization_not_approved: only ATCO-approved organizations can book'
      using errcode = '42501';
  end if;

  -- 5. Lock the sailing rows in a fixed (id) order, then validate -------------
  perform 1 from public.sailings as s
   where s.id in (p_outbound_sailing_id, p_return_sailing_id)
   order by s.id
     for update;

  select s.id, s.status, s.departs_at, s.seat_capacity, s.seats_booked, r.origin, r.destination
    into v_out
    from public.sailings as s join public.routes as r on r.id = s.route_id
   where s.id = p_outbound_sailing_id;
  if not found or v_out.status <> 'open' or v_out.departs_at <= now() then
    raise exception 'sailing_unavailable: the outbound sailing is not open for booking' using errcode = 'P0001';
  end if;
  if v_out.seats_booked + p_passenger_count > v_out.seat_capacity then
    raise exception 'sailing_full: not enough seats on the outbound sailing' using errcode = 'P0001';
  end if;

  if p_return_sailing_id is not null then
    select s.id, s.status, s.departs_at, s.seat_capacity, s.seats_booked, r.origin, r.destination
      into v_ret
      from public.sailings as s join public.routes as r on r.id = s.route_id
     where s.id = p_return_sailing_id;
    if not found or v_ret.status <> 'open' or v_ret.departs_at <= now() then
      raise exception 'sailing_unavailable: the return sailing is not open for booking' using errcode = 'P0001';
    end if;
    if lower(btrim(v_ret.origin)) <> lower(btrim(v_out.destination))
       or lower(btrim(v_ret.destination)) <> lower(btrim(v_out.origin)) then
      raise exception 'invalid return sailing: it must run the reverse route' using errcode = '22023';
    end if;
    if v_ret.departs_at <= v_out.departs_at then
      raise exception 'invalid return sailing: it must depart after the outbound sailing' using errcode = '22023';
    end if;
    if v_ret.seats_booked + p_passenger_count > v_ret.seat_capacity then
      raise exception 'sailing_full: not enough seats on the return sailing' using errcode = 'P0001';
    end if;
  end if;

  -- 6. Reserve: seats, booking (server reference), legs — one transaction ----
  update public.sailings as s
     set seats_booked = s.seats_booked + p_passenger_count
   where s.id in (p_outbound_sailing_id, p_return_sailing_id);

  loop
    v_attempt := v_attempt + 1;
    v_ref := 'GM-' || upper(encode(extensions.gen_random_bytes(4), 'hex'));
    begin
      insert into public.bookings as b
        (reference, organization_id, created_by, request_key, request_hash, status,
         passenger_count, contact_name, contact_email, contact_phone, passenger_names, po_reference)
      values
        (v_ref, p_organization_id, v_uid, p_request_key, v_hash, 'reserved',
         p_passenger_count, v_name, v_email, v_phone, v_names, v_po)
      returning b.id into v_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bookings_reference_key' or v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.booking_legs (booking_id, sailing_id, leg, passengers)
  values (v_id, p_outbound_sailing_id, 'outbound', p_passenger_count);
  if p_return_sailing_id is not null then
    insert into public.booking_legs (booking_id, sailing_id, leg, passengers)
    values (v_id, p_return_sailing_id, 'return', p_passenger_count);
  end if;

  return query select v_id, v_ref, 'reserved'::text, 'created'::text;
  return;
end;
$$;

comment on function public.create_booking(uuid, uuid, uuid, integer, text, text, text, text[], uuid, text) is
  'The only booking writer. Approved-organisation members only; atomic, locked, idempotent per (user, request key).';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.vessels      enable row level security;
alter table public.routes       enable row level security;
alter table public.sailings     enable row level security;
alter table public.bookings     enable row level security;
alter table public.booking_legs enable row level security;

create policy vessels_select_authenticated on public.vessels for select to authenticated using (true);
create policy vessels_insert_ops on public.vessels for insert to authenticated
  with check (public.has_platform_role('{super_admin, operations}'));
create policy vessels_update_ops on public.vessels for update to authenticated
  using (public.has_platform_role('{super_admin, operations}'))
  with check (public.has_platform_role('{super_admin, operations}'));

create policy routes_select_authenticated on public.routes for select to authenticated using (true);
create policy routes_insert_ops on public.routes for insert to authenticated
  with check (public.has_platform_role('{super_admin, operations}'));
create policy routes_update_ops on public.routes for update to authenticated
  using (public.has_platform_role('{super_admin, operations}'))
  with check (public.has_platform_role('{super_admin, operations}'));

create policy sailings_select_authenticated on public.sailings for select to authenticated using (true);
create policy sailings_insert_ops on public.sailings for insert to authenticated
  with check (public.has_platform_role('{super_admin, operations}'));
create policy sailings_update_ops on public.sailings for update to authenticated
  using (public.has_platform_role('{super_admin, operations}'))
  with check (public.has_platform_role('{super_admin, operations}'));

create policy bookings_select_relevant on public.bookings for select to authenticated
  using (
    created_by = (select auth.uid())
    or (public.has_org_role(organization_id, '{company_admin}')
        and organization_id in (select public.active_org_ids()))
    or public.has_platform_role('{super_admin, operations}')
  );

-- A leg is visible exactly when its booking is (the subquery runs under bookings' RLS).
create policy booking_legs_select_via_booking on public.booking_legs for select to authenticated
  using (exists (select 1 from public.bookings as b where b.id = booking_legs.booking_id));

-- No INSERT/UPDATE/DELETE policies on bookings / booking_legs: create_booking() only.

-- ---------------------------------------------------------------------------
-- Grants (explicit minimums; default-privilege grants removed first)
-- ---------------------------------------------------------------------------
revoke all privileges on public.vessels, public.routes, public.sailings,
                         public.bookings, public.booking_legs
  from anon, authenticated;

grant select on public.vessels, public.routes, public.sailings,
               public.bookings, public.booking_legs to authenticated;

grant insert (name, passenger_capacity, status)                        on public.vessels  to authenticated;
grant update (name, passenger_capacity, status)                        on public.vessels  to authenticated;
grant insert (origin, destination, status)                             on public.routes   to authenticated;
grant update (origin, destination, status)                             on public.routes   to authenticated;
grant insert (route_id, vessel_id, departs_at, seat_capacity, status)  on public.sailings to authenticated;
grant update (route_id, vessel_id, departs_at, seat_capacity, status)  on public.sailings to authenticated;

revoke execute on function public.create_booking(uuid, uuid, uuid, integer, text, text, text, text[], uuid, text)
  from public, anon, service_role;
grant  execute on function public.create_booking(uuid, uuid, uuid, integer, text, text, text, text[], uuid, text)
  to authenticated;

-- Trigger-only functions: nobody calls them directly.
revoke execute on function public.stamp_actor_columns() from public, anon, authenticated, service_role;
revoke execute on function public.guard_sailing_write() from public, anon, authenticated, service_role;
