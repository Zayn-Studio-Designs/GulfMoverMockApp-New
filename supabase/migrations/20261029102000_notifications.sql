-- In-app only. No email/push delivery, no backfill of invented historical events.
create table public.notifications (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 event_key text not null, kind text not null, target text not null,
 created_at timestamptz not null default now(), read_at timestamptz, unique(user_id,event_key)
);
alter table public.notifications enable row level security;
create policy notification_owner on public.notifications for select to authenticated using(user_id=auth.uid());
revoke all on public.notifications from public,anon,authenticated;
grant select(id,kind,target,created_at,read_at) on public.notifications to authenticated;
create function public.mark_notification_read(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.notifications set read_at=coalesce(read_at,now()) where id=p_id and user_id=auth.uid();
 return found;
end; $$;
revoke all on function public.mark_notification_read(uuid) from public,anon,service_role;
grant execute on function public.mark_notification_read(uuid) to authenticated;

create function public.emit_notification(p_user uuid,p_key text,p_kind text,p_target text) returns void
language sql security definer set search_path='' as $$
 insert into public.notifications(user_id,event_key,kind,target) select p_user,p_key,p_kind,p_target where p_user is not null
 on conflict(user_id,event_key) do nothing;
$$;
revoke all on function public.emit_notification(uuid,text,text,text) from public,anon,authenticated,service_role;

create function public.notify_operational_event() returns trigger language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_ref text; v_org uuid; v_target text;
begin
 if tg_table_name='approval_events' then
  if new.subject_type='organization' and new.decision in ('approved','rejected','reinstated','suspended') then
   for v_user in select m.user_id from public.organization_memberships m where m.organization_id=new.subject_id and m.status='active' loop
    perform public.emit_notification(v_user,'approval:'||new.id,'company_decision','/onboarding');
   end loop;
  end if;
 elsif tg_table_name='membership_events' then
  select user_id into v_user from public.organization_memberships where id=new.member_id;
  if v_user is null then select u.id into v_user from auth.users u join public.company_invitations i on lower(u.email)=i.email where i.id=new.invitation_id and u.email_confirmed_at is not null;end if;
  perform public.emit_notification(v_user,'membership:'||new.id,'membership_'||new.action,'/company/members');
  for v_user in select user_id from public.organization_memberships where organization_id=new.organization_id and membership_role='company_admin' and status='active' loop
   perform public.emit_notification(v_user,'membership:'||new.id,'membership_'||new.action,'/company/members');
  end loop;
 elsif tg_table_name='bookings' then
  perform public.emit_notification(new.created_by,'booking:'||new.id,'booking_created','/bookings/'||new.reference);
 elsif tg_table_name='tickets' then
  select b.created_by,b.reference into v_user,v_ref from public.bookings b where b.id=new.booking_id;
  -- One ticket-created notice per booking, not one per passenger/leg.
  perform public.emit_notification(v_user,'tickets:'||new.booking_id,'tickets_created','/bookings/'||v_ref);
 elsif tg_table_name='transfer_request_events' then
  select r.created_by,r.organization_id,case when r.kind='materials' then '/materials' else '/charters' end into v_user,v_org,v_target from public.transfer_requests r where r.id=new.request_id;
  perform public.emit_notification(v_user,'request:'||new.id,'request_'||new.status,v_target);
  if new.status='pending_review' then
   for v_user in select distinct a.user_id from public.role_assignments a where a.organization_id is null and a.status='active' and a.role in ('super_admin','operations') and not exists(select 1 from public.profiles p where p.id=a.user_id and p.status='suspended') loop
    perform public.emit_notification(v_user,'request:'||new.id,'request_pending_review',case when v_target='/materials' then '/admin/materials' else '/admin/charters' end);
   end loop;
  end if;
 elsif tg_table_name='sailing_readiness_events' then
  for v_user in select distinct b.created_by from public.bookings b join public.booking_legs l on l.booking_id=b.id where l.sailing_id=new.sailing_id loop
   perform public.emit_notification(v_user,'readiness:'||new.id,'readiness_changed','/bookings');
  end loop;
 elsif tg_table_name='boarding_events' then
  select b.created_by,b.reference into v_user,v_ref from public.tickets t join public.bookings b on b.id=t.booking_id where t.id=new.ticket_id;
  perform public.emit_notification(v_user,'boarding:'||new.id,'boarding_recorded','/bookings/'||v_ref);
 end if;
 return null;
end; $$;
revoke all on function public.notify_operational_event() from public,anon,authenticated,service_role;
create trigger notify_company after insert on public.approval_events for each row execute function public.notify_operational_event();
create trigger notify_membership after insert on public.membership_events for each row execute function public.notify_operational_event();
create trigger notify_booking after insert on public.bookings for each row execute function public.notify_operational_event();
create trigger notify_ticket after insert on public.tickets for each row execute function public.notify_operational_event();
create trigger notify_request after insert on public.transfer_request_events for each row execute function public.notify_operational_event();
create trigger notify_readiness after insert on public.sailing_readiness_events for each row execute function public.notify_operational_event();
create trigger notify_boarding after insert on public.boarding_events for each row execute function public.notify_operational_event();
