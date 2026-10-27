-- Phase 4 checkpoint: tickets represent seat reservations, NOT verified payment,
-- port permission, identity verification or a legal marine clearance.
-- No historical migration or create_booking signature is changed. An AFTER INSERT
-- leg trigger issues tickets in the same transaction as the existing booking RPC.

alter table public.sailings add column readiness_status text not null default 'pending'
  check (readiness_status in ('pending','ready','blocked'));
grant select(readiness_status) on public.sailings to authenticated;

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  booking_leg_id uuid not null references public.booking_legs(id),
  sailing_id uuid not null references public.sailings(id),
  passenger_index integer not null check (passenger_index between 1 and 1000),
  passenger_name text, -- NULL when no name was collected; never invent one
  reference text not null unique default ('TK-' || upper(encode(extensions.gen_random_bytes(12),'hex'))),
  qr_token text not null unique default encode(extensions.gen_random_bytes(32),'hex'),
  status text not null default 'valid' check (status in ('valid','boarded','cancelled')),
  created_at timestamptz not null default now(),
  boarded_at timestamptz,
  unique(booking_leg_id, passenger_index),
  check ((status = 'boarded') = (boarded_at is not null))
);
create index tickets_booking_idx on public.tickets(booking_id);
create index tickets_sailing_idx on public.tickets(sailing_id);

create table public.boarding_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references public.tickets(id),
  sailing_id uuid not null references public.sailings(id),
  actor_user_id uuid not null references auth.users(id),
  occurred_at timestamptz not null default now()
);
create table public.sailing_readiness_events (
  id uuid primary key default gen_random_uuid(),
  sailing_id uuid not null references public.sailings(id),
  previous_status text not null,
  status text not null check(status in ('pending','ready','blocked')),
  reason text not null check(char_length(btrim(reason)) between 1 and 500),
  actor_user_id uuid not null references auth.users(id),
  occurred_at timestamptz not null default now()
);
create index readiness_events_sailing_idx on public.sailing_readiness_events(sailing_id,occurred_at);

-- Creator-only ticket access, not the broader booking company-admin visibility.
-- Operational personnel use a narrowly scoped manifest RPC without contact e-mails,
-- phone numbers, QR secrets or booking creator IDs.
alter table public.tickets enable row level security;
alter table public.boarding_events enable row level security;
alter table public.sailing_readiness_events enable row level security;
create policy tickets_owner on public.tickets for select to authenticated using (
  exists(select 1 from public.bookings b where b.id = tickets.booking_id and b.created_by = auth.uid())
  and not exists(select 1 from public.profiles p where p.id = auth.uid() and p.status = 'suspended')
);
create policy boarding_audit_staff on public.boarding_events for select to authenticated
  using(public.has_platform_role('{super_admin,operations,boarding_staff}'));
create policy readiness_audit_staff on public.sailing_readiness_events for select to authenticated
  using(public.has_platform_role('{super_admin,operations}'));
revoke all on public.tickets, public.boarding_events, public.sailing_readiness_events from public, anon, authenticated;
grant select(id,booking_id,booking_leg_id,sailing_id,passenger_index,passenger_name,reference,status,created_at,boarded_at)
  on public.tickets to authenticated;
grant select on public.boarding_events, public.sailing_readiness_events to authenticated;

create function public.issue_leg_tickets()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tickets(booking_id,booking_leg_id,sailing_id,passenger_index,passenger_name)
    select new.booking_id,new.id,new.sailing_id,i,b.passenger_names[i]
      from public.bookings b cross join generate_series(1,new.passengers) i
     where b.id = new.booking_id and b.status = 'reserved'
    on conflict(booking_leg_id,passenger_index) do nothing;
  return new;
end;
$$;
revoke execute on function public.issue_leg_tickets() from public,anon,authenticated,service_role;
create trigger trg_leg_tickets after insert on public.booking_legs
  for each row execute function public.issue_leg_tickets();
-- Existing valid reservations also get one ticket per passenger per one-way leg.
insert into public.tickets(booking_id,booking_leg_id,sailing_id,passenger_index,passenger_name)
  select b.id,l.id,l.sailing_id,i,b.passenger_names[i]
    from public.booking_legs l join public.bookings b on b.id=l.booking_id
    cross join generate_series(1,l.passengers) i where b.status='reserved'
  on conflict(booking_leg_id,passenger_index) do nothing;

create function public.get_ticket_qr(p_ticket_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select t.qr_token into v_token from public.tickets t join public.bookings b on b.id=t.booking_id
   where t.id=p_ticket_id and b.created_by=auth.uid()
     and not exists(select 1 from public.profiles p where p.id=auth.uid() and p.status='suspended');
  if not found then raise exception 'ticket not found' using errcode='P0002'; end if;
  return 'GMT1:' || v_token;
end;
$$;

create function public.ticket_manifest(p_sailing_id uuid)
returns table(ticket_id uuid,reference text,booking_reference text,passenger_index integer,
  passenger_name text,status text,boarded_at timestamptz,leg text)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  return query select t.id,t.reference,b.reference,t.passenger_index,t.passenger_name,t.status,t.boarded_at,l.leg
    from public.tickets t join public.bookings b on b.id=t.booking_id
      join public.booking_legs l on l.id=t.booking_leg_id
    where t.sailing_id=p_sailing_id order by b.reference,t.passenger_index;
end;
$$;

create function public.set_sailing_readiness(p_sailing_id uuid,p_status text,p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_old text; v_sailing_status text;
begin
  if not public.has_platform_role('{super_admin,operations}') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  -- Row-share locks serialise this operation against account/role suspension.
  perform 1 from public.profiles where id=auth.uid() for share;
  perform 1 from public.role_assignments where user_id=auth.uid() and organization_id is null for share;
  if not public.has_platform_role('{super_admin,operations}') then raise exception 'not authorized' using errcode='42501'; end if;
  if p_status is null or p_status not in ('pending','ready','blocked') or
     nullif(btrim(p_reason),'') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'invalid readiness decision' using errcode='22023';
  end if;
  select s.readiness_status,s.status into v_old,v_sailing_status from public.sailings s where s.id=p_sailing_id for update;
  if not found then raise exception 'sailing not found' using errcode='P0002'; end if;
  if v_sailing_status='cancelled' then raise exception 'invalid_transition: cancelled sailing' using errcode='55000'; end if;
  if v_old=p_status then return 'unchanged'; end if;
  update public.sailings set readiness_status=p_status where id=p_sailing_id;
  insert into public.sailing_readiness_events(sailing_id,previous_status,status,reason,actor_user_id)
    values(p_sailing_id,v_old,p_status,btrim(p_reason),auth.uid());
  return 'recorded';
end;
$$;

create function public.board_ticket(p_code text,p_sailing_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype; v_sailing public.sailings%rowtype;
begin
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  perform 1 from public.profiles where id=auth.uid() for share;
  perform 1 from public.role_assignments where user_id=auth.uid() and organization_id is null for share;
  if not public.has_platform_role('{super_admin,operations,boarding_staff}') then raise exception 'not authorized' using errcode='42501'; end if;
  if p_sailing_id is null or p_code is null or char_length(p_code)>100 then raise exception 'invalid ticket lookup' using errcode='22023'; end if;
  -- Sailing first, then ticket: serialises against readiness/cancellation updates
  -- and concurrent scans. No check occurs solely in the browser.
  select * into v_sailing from public.sailings where id=p_sailing_id for update;
  if not found then return 'not_found'; end if;
  select * into v_ticket from public.tickets
   where (reference=btrim(p_code) and p_code like 'TK-%')
      or (qr_token=substring(btrim(p_code) from 6) and btrim(p_code) ~ '^GMT1:[0-9a-f]{64}$')
   for update;
  if not found then return 'not_found'; end if;
  if v_ticket.sailing_id<>p_sailing_id then return 'wrong_sailing'; end if;
  if v_sailing.status='cancelled' then return 'sailing_cancelled'; end if;
  if v_ticket.status='cancelled' then return 'cancelled'; end if;
  if v_ticket.status='boarded' then return 'already_boarded'; end if;
  if v_sailing.readiness_status<>'ready' then return 'not_ready'; end if;
  update public.tickets set status='boarded',boarded_at=now() where id=v_ticket.id;
  insert into public.boarding_events(ticket_id,sailing_id,actor_user_id) values(v_ticket.id,p_sailing_id,auth.uid());
  return 'boarded';
end;
$$;
revoke execute on function public.get_ticket_qr(uuid),public.ticket_manifest(uuid),
  public.set_sailing_readiness(uuid,text,text),public.board_ticket(text,uuid) from public,anon,service_role;
grant execute on function public.get_ticket_qr(uuid),public.ticket_manifest(uuid),
  public.set_sailing_readiness(uuid,text,text),public.board_ticket(text,uuid) to authenticated;
comment on column public.sailings.readiness_status is
  'Internal operational tracking only. ready enables boarding; NOT legal or port clearance. Minimum four tickets is a warning only.';
