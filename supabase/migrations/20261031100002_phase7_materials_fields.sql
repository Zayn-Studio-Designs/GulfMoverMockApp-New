-- ===========================================================================
-- 20261031100002 - Phase 7: ATCO materials fields (additive only)
-- Extends submit_transfer_request details validation to the ATCO-required
-- fields. Restricted/hazardous materials are never auto-approved: the review
-- workflow is unchanged (planning-only decisions, staff-gated).
-- ===========================================================================
create or replace function public.submit_transfer_request(p_org uuid, p_kind text, p_key uuid, p_details jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_existing public.transfer_requests%rowtype; v_id uuid; k text; v text; allowed text[];
  u text; n numeric;
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
   'dimensions', 'sender', 'receiver', 'handling', 'photo_urls', 'hazardous', 'notes']
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
  if coalesce(p_details->>'quantity', '') <> '' and (p_details->>'quantity') !~ '^[1-9][0-9]{0,5}$' then
    raise exception 'invalid quantity' using errcode = '22023'; end if;
  if coalesce(p_details->>'weight_kg', '') <> '' then
    begin n := (p_details->>'weight_kg')::numeric;
      if n <= 0 or n > 1000000 then raise exception 'invalid weight_kg' using errcode = '22023'; end if;
    exception when invalid_text_representation then raise exception 'invalid weight_kg' using errcode = '22023'; end;
  end if;
  if coalesce(p_details->>'hazardous', '') <> '' and (p_details->>'hazardous') not in ('true', 'false') then
    raise exception 'invalid hazardous flag' using errcode = '22023'; end if;
 else
  if coalesce(p_details->>'time', '') <> '' and (p_details->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'invalid time' using errcode = '22023'; end if;
  if coalesce(p_details->>'passengers', '') <> '' and (p_details->>'passengers') !~ '^[1-9][0-9]{0,3}$' then
    raise exception 'invalid passengers' using errcode = '22023'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_key::text, 1));
 select * into v_existing from public.transfer_requests where created_by = auth.uid() and request_key = p_key;
 if found then
  if v_existing.details <> p_details or v_existing.kind <> p_kind or v_existing.organization_id <> p_org then
    raise exception 'payload_mismatch' using errcode = '22023'; end if;
  return v_existing.id;
 end if;
 insert into public.transfer_requests (organization_id, created_by, request_key, kind, details)
 values (p_org, auth.uid(), p_key, p_kind, p_details) returning id into v_id;
 insert into public.transfer_request_events (request_id, status, reason, actor_user_id)
 values (v_id, 'pending_review', '', auth.uid());
 return v_id;
end; $$;
