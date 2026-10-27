-- Requests only: no transport acceptance, tariff, allocation or legal clearance.
create table public.transfer_requests (
 id uuid primary key default gen_random_uuid(), reference text not null unique default ('RQ-'||upper(encode(extensions.gen_random_bytes(8),'hex'))),
 organization_id uuid not null references public.organizations(id),created_by uuid not null references auth.users(id),request_key uuid not null,
 kind text not null check(kind in ('materials','charter')),details jsonb not null,
 status text not null default 'pending_review' check(status in ('pending_review','clarification_required','reviewed_for_planning','rejected')),
 revision integer not null default 0,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(created_by,request_key)
);
create table public.transfer_request_events (
 id uuid primary key default gen_random_uuid(),request_id uuid not null references public.transfer_requests(id),
 status text not null,reason text not null,actor_user_id uuid not null references auth.users(id),created_at timestamptz not null default now()
);
-- Revoked members lose access to these company records, even if they created them.
create function public.can_read_transfer(p_org uuid,p_creator uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select public.has_platform_role('{super_admin,operations}') or
 (exists(select 1 from public.organizations where id=p_org and status='approved') and
 (public.has_org_role(p_org,'{company_admin}') or (p_creator=auth.uid() and public.has_org_role(p_org,'{company_booker}'))));
$$;
revoke all on function public.can_read_transfer(uuid,uuid) from public,anon,service_role;
grant execute on function public.can_read_transfer(uuid,uuid) to authenticated;
alter table public.transfer_requests enable row level security;
alter table public.transfer_request_events enable row level security;
create policy transfer_visibility on public.transfer_requests for select to authenticated using(public.can_read_transfer(organization_id,created_by));
create policy transfer_event_visibility on public.transfer_request_events for select to authenticated using(exists(select 1 from public.transfer_requests r where r.id=request_id));
revoke all on public.transfer_requests,public.transfer_request_events from public,anon,authenticated;
grant select on public.transfer_requests to authenticated;
grant select(id,request_id,status,reason,created_at) on public.transfer_request_events to authenticated;

create function public.submit_transfer_request(p_org uuid,p_kind text,p_key uuid,p_details jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_existing public.transfer_requests%rowtype; v_id uuid; k text; v text; allowed text[];
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 perform 1 from public.organizations where id=p_org and status='approved' for share;
 if not found then raise exception 'organization_not_approved' using errcode='42501';end if;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform 1 from public.organization_memberships where organization_id=p_org and user_id=auth.uid() for share;
 if not public.has_org_role(p_org,'{company_admin,company_booker}') then raise exception 'not_a_member' using errcode='42501';end if;
 if p_key is null or p_kind is null or p_kind not in ('materials','charter') or jsonb_typeof(p_details) is distinct from 'object' then raise exception 'invalid request' using errcode='22023';end if;
 allowed:=case when p_kind='materials' then array['description','destination','date','quantity','weight','dimensions','sender','receiver','notes'] else array['description','destination','date','time','passengers','duration','materials','notes'] end;
 for k,v in select key,value from jsonb_each_text(p_details) loop
  if not k=any(allowed) or jsonb_typeof(p_details->k)<>'string' or char_length(v)>1000 then raise exception 'invalid details' using errcode='22023';end if;
 end loop;
 -- Only the request description is mandatory; operational field requirements await ATCO.
 if nullif(btrim(p_details->>'description'),'') is null then raise exception 'invalid description' using errcode='22023';end if;
 if coalesce(p_details->>'date','')<>'' then
  if (p_details->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid date' using errcode='22023';end if;
  perform (p_details->>'date')::date;
 end if;
 if coalesce(p_details->>'time','')<>'' and (p_details->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'invalid time' using errcode='22023';end if;
 if coalesce(p_details->>'passengers','')<>'' and (p_details->>'passengers') !~ '^[1-9][0-9]{0,3}$' then raise exception 'invalid passengers' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,1));
 select * into v_existing from public.transfer_requests where created_by=auth.uid() and request_key=p_key;
 if found then
  if v_existing.details<>p_details or v_existing.kind<>p_kind or v_existing.organization_id<>p_org then raise exception 'payload_mismatch' using errcode='22023';end if;
  return v_existing.id;
 end if;
 insert into public.transfer_requests(organization_id,created_by,request_key,kind,details) values(p_org,auth.uid(),p_key,p_kind,p_details) returning id into v_id;
 insert into public.transfer_request_events(request_id,status,reason,actor_user_id) values(v_id,'pending_review','',auth.uid());
 return v_id;
end; $$;
create function public.review_transfer_request(p_id uuid,p_revision integer,p_status text,p_reason text) returns text
language plpgsql security definer set search_path='' as $$
declare v_request public.transfer_requests%rowtype;
begin
 perform 1 from public.profiles where id=auth.uid() for share;
 perform 1 from public.role_assignments where user_id=auth.uid() and organization_id is null for share;
 if not public.has_platform_role('{super_admin,operations}') then raise exception 'not authorized' using errcode='42501';end if;
 if p_status is null or p_status not in ('clarification_required','reviewed_for_planning','rejected') or nullif(btrim(p_reason),'') is null or char_length(p_reason)>500 then raise exception 'invalid decision' using errcode='22023';end if;
 select * into v_request from public.transfer_requests where id=p_id for update;
 if not found then raise exception 'not found' using errcode='P0002';end if;
 -- Replay exactly the same decision only, not a changed reason silently discarded.
 if v_request.revision=p_revision+1 and v_request.status=p_status and exists(select 1 from public.transfer_request_events where request_id=p_id and status=p_status and reason=btrim(p_reason) and actor_user_id=auth.uid() order by created_at desc limit 1) then return 'unchanged';end if;
 if p_revision is null or v_request.revision<>p_revision or v_request.status not in ('pending_review','clarification_required') then raise exception 'invalid_transition' using errcode='55000';end if;
 update public.transfer_requests set status=p_status,revision=revision+1,updated_at=now() where id=p_id;
 insert into public.transfer_request_events(request_id,status,reason,actor_user_id) values(p_id,p_status,btrim(p_reason),auth.uid());
 return 'recorded';
end; $$;
revoke all on function public.submit_transfer_request(uuid,text,uuid,jsonb),public.review_transfer_request(uuid,integer,text,text) from public,anon,service_role;
grant execute on function public.submit_transfer_request(uuid,text,uuid,jsonb),public.review_transfer_request(uuid,integer,text,text) to authenticated;
