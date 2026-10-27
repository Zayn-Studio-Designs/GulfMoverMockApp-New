-- Phase 4: additive security fix. Suspension removes derived company/staff privileges
-- immediately on the next statement, even with a still-valid Auth JWT.
create or replace function public.has_platform_role(p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'suspended')
    and exists (select 1 from public.role_assignments r where r.user_id = auth.uid()
      and r.organization_id is null and r.status = 'active' and r.role = any(p_roles));
$$;
create or replace function public.has_org_role(p_org uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'suspended')
    and exists (select 1 from public.organization_memberships m where m.user_id = auth.uid()
      and m.organization_id = p_org and m.status = 'active' and m.membership_role = any(p_roles));
$$;
create or replace function public.active_org_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.organization_id from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = auth.uid() and m.status = 'active' and o.status in ('approved', 'pending')
     and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'suspended');
$$;
revoke execute on function public.has_platform_role(text[]), public.has_org_role(uuid,text[]), public.active_org_ids()
  from public, anon, service_role;
grant execute on function public.has_platform_role(text[]), public.has_org_role(uuid,text[]), public.active_org_ids()
  to authenticated;

-- The original profile trigger queried raw roles, allowing a suspended super_admin
-- to reactivate their own profile. Use the suspension-aware helper instead.
create or replace function public.guard_profile_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.id is distinct from old.id then raise exception 'profile id is immutable' using errcode = '42501'; end if;
  if new.status is distinct from old.status and auth.uid() is not null
     and not public.has_platform_role('{super_admin}') then
    raise exception 'not authorized to change account status' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_profile_status() from public, anon, authenticated, service_role;

-- Published scheduling data has no need to disclose staff Auth IDs. Existing
-- services already explicitly select only these columns (including embedded joins).
revoke select on public.vessels, public.routes, public.sailings from authenticated;
grant select(id,name,passenger_capacity,status,created_at,updated_at) on public.vessels to authenticated;
grant select(id,origin,destination,status,created_at,updated_at) on public.routes to authenticated;
grant select(id,route_id,vessel_id,departs_at,seat_capacity,seats_booked,status,created_at,updated_at)
  on public.sailings to authenticated;
