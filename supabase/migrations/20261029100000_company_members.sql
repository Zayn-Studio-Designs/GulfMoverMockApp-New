-- Company admins may invite bookers only. In-app invitations; NO email delivery.
-- Expiry: provisional technical safety window 7 days, pending ATCO confirmation.
create table public.company_invitations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 email text not null check(email=lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email)<=254),
 status text not null default 'pending' check(status in ('pending','accepted','revoked')),
 expires_at timestamptz not null default now()+interval '7 days',
 created_by uuid not null references auth.users(id), accepted_by uuid references auth.users(id),
 created_at timestamptz not null default now()
);
create unique index invitations_pending on public.company_invitations(organization_id,email) where status='pending';
create table public.membership_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 invitation_id uuid references public.company_invitations(id), member_id uuid references public.organization_memberships(id),
 action text not null check(action in ('invited','accepted','invitation_revoked','membership_revoked')),
 actor_user_id uuid not null references auth.users(id), occurred_at timestamptz not null default now()
);
-- Serialize administrative mutations on the company and check CURRENT authority.
create function public.lock_company_admin(p_org uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.organizations where id=p_org and status='approved' for update;
 if not found then raise exception 'organization_not_approved' using errcode='42501'; end if;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform 1 from public.organization_memberships where organization_id=p_org and user_id=auth.uid() for share;
 if not public.has_org_role(p_org,'{company_admin}') then raise exception 'not authorized' using errcode='42501'; end if;
end; $$;
revoke all on function public.lock_company_admin(uuid) from public,anon,authenticated,service_role;

create function public.my_invitation_email() returns text language sql stable security definer set search_path='' as $$
 select lower(u.email) from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null
 and not exists(select 1 from public.profiles p where p.id=auth.uid() and p.status='suspended');
$$;
revoke all on function public.my_invitation_email() from public,anon,service_role;
grant execute on function public.my_invitation_email() to authenticated;
alter table public.company_invitations enable row level security;
alter table public.membership_events enable row level security;
create policy invitation_visibility on public.company_invitations for select to authenticated using (
 public.has_org_role(organization_id,'{company_admin}') or email=public.my_invitation_email());
create policy member_event_visibility on public.membership_events for select to authenticated using(public.has_org_role(organization_id,'{company_admin}'));
revoke all on public.company_invitations,public.membership_events from public,anon,authenticated;
grant select on public.company_invitations,public.membership_events to authenticated;
-- Old direct writes bypass invitation recipient consent and audit; close them.
revoke insert,update,delete on public.organization_memberships from authenticated;

create function public.invite_company_member(p_org uuid,p_email text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_email text:=lower(btrim(p_email)); v_inv public.company_invitations%rowtype;
begin
 perform public.lock_company_admin(p_org);
 if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email)>254 or v_email=public.my_invitation_email() then
 raise exception 'invalid email' using errcode='22023'; end if;
 select * into v_inv from public.company_invitations where organization_id=p_org and email=v_email and status='pending' for update;
 if found then
  if v_inv.expires_at>now() then return v_inv.id; end if;
  update public.company_invitations set status='revoked' where id=v_inv.id;
  insert into public.membership_events(organization_id,invitation_id,action,actor_user_id) values(p_org,v_inv.id,'invitation_revoked',auth.uid());
 end if;
 insert into public.company_invitations(organization_id,email,created_by) values(p_org,v_email,auth.uid()) returning * into v_inv;
 insert into public.membership_events(organization_id,invitation_id,action,actor_user_id) values(p_org,v_inv.id,'invited',auth.uid());
 return v_inv.id;
end; $$;
create function public.cancel_company_invitation(p_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_status text;
begin
 select organization_id into v_org from public.company_invitations where id=p_id;
 perform public.lock_company_admin(v_org);
 select status into v_status from public.company_invitations where id=p_id for update;
 if v_status='revoked' then return 'unchanged'; end if;
 if v_status is distinct from 'pending' then raise exception 'invalid_transition' using errcode='55000'; end if;
 update public.company_invitations set status='revoked' where id=p_id;
 insert into public.membership_events(organization_id,invitation_id,action,actor_user_id) values(v_org,p_id,'invitation_revoked',auth.uid());
 return 'recorded';
end; $$;
create function public.accept_company_invitation(p_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare v_inv public.company_invitations%rowtype; v_org uuid; v_member uuid; v_role text;
begin
 select organization_id into v_org from public.company_invitations where id=p_id;
 perform 1 from public.organizations where id=v_org and status='approved' for update;
 if not found then raise exception 'not authorized' using errcode='42501'; end if;
 perform 1 from public.profiles where id=auth.uid() for share;
 select * into v_inv from public.company_invitations where id=p_id for update;
 if v_inv.email is distinct from public.my_invitation_email() then raise exception 'not authorized' using errcode='42501'; end if;
 if v_inv.status='accepted' and v_inv.accepted_by=auth.uid() then return 'unchanged'; end if;
 if v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'invalid_transition' using errcode='55000'; end if;
 select membership_role into v_role from public.organization_memberships where organization_id=v_org and user_id=auth.uid() for update;
 if found and v_role<>'company_booker' then raise exception 'invalid_transition' using errcode='55000'; end if;
 insert into public.organization_memberships(organization_id,user_id,membership_role,status,invited_by)
 values(v_org,auth.uid(),'company_booker','active',v_inv.created_by)
 on conflict(organization_id,user_id) do update set status='active',invited_by=excluded.invited_by returning id into v_member;
 update public.company_invitations set status='accepted',accepted_by=auth.uid() where id=p_id;
 insert into public.membership_events(organization_id,invitation_id,member_id,action,actor_user_id) values(v_org,p_id,v_member,'accepted',auth.uid());
 return 'recorded';
end; $$;
create function public.revoke_company_member(p_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare v_m public.organization_memberships%rowtype;
begin
 select * into v_m from public.organization_memberships where id=p_id;
 perform public.lock_company_admin(v_m.organization_id);
 select * into v_m from public.organization_memberships where id=p_id for update;
 if v_m.membership_role<>'company_booker' or v_m.user_id=auth.uid() then raise exception 'not authorized' using errcode='42501'; end if;
 if v_m.status='suspended' then return 'unchanged'; end if;
 update public.organization_memberships set status='suspended' where id=p_id;
 insert into public.membership_events(organization_id,member_id,action,actor_user_id) values(v_m.organization_id,p_id,'membership_revoked',auth.uid());
 return 'recorded';
end; $$;
create function public.list_company_members(p_org uuid)
returns table(id uuid,display_name text,email text,membership_role text,status text)
language plpgsql security definer set search_path='' as $$
begin
 if not public.has_org_role(p_org,'{company_admin}') then raise exception 'not authorized' using errcode='42501'; end if;
 return query select m.id,p.display_name,u.email::text,m.membership_role,m.status from public.organization_memberships m
 join auth.users u on u.id=m.user_id left join public.profiles p on p.id=m.user_id where m.organization_id=p_org order by m.created_at;
end; $$;
revoke all on function public.invite_company_member(uuid,text),public.cancel_company_invitation(uuid),public.accept_company_invitation(uuid),public.revoke_company_member(uuid),public.list_company_members(uuid) from public,anon,service_role;
grant execute on function public.invite_company_member(uuid,text),public.cancel_company_invitation(uuid),public.accept_company_invitation(uuid),public.revoke_company_member(uuid),public.list_company_members(uuid) to authenticated;
