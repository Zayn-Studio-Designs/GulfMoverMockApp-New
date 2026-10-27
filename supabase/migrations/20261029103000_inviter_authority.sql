-- A pending invitation cannot retain authority after its issuing admin is suspended.
create function public.check_invitation_acceptance() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='accepted' and old.status='pending' then
  perform 1 from public.profiles where id=old.created_by for share;
  perform 1 from public.organization_memberships where organization_id=old.organization_id and user_id=old.created_by
   and membership_role='company_admin' and status='active' for share;
  if not found or exists(select 1 from public.profiles where id=old.created_by and status='suspended') then
   raise exception 'not authorized' using errcode='42501';
  end if;
 end if;
 return new;
end; $$;
revoke all on function public.check_invitation_acceptance() from public,anon,authenticated,service_role;
create trigger guard_invitation_acceptance before update on public.company_invitations for each row execute function public.check_invitation_acceptance();
