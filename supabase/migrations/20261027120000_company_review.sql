-- ===========================================================================
-- 20261027120000 — ATCO company review (approve / reject) + member status read
-- ===========================================================================
-- Phase 3. Additive: no earlier migration is edited.
--
-- 1. review_company(p_organization_id, p_decision, p_reason)
--    The ONLY application path that changes an organisation's lifecycle status.
--    * Identity: auth.uid() only; no caller-supplied actor.
--    * Authority: active platform role 'super_admin' (has_platform_role). This
--      matches the Phase 1 permission matrix (docs/backend/phase1-review.md §3:
--      organizations.update = super_admin only). 'operations' can still READ
--      organisations (existing select policy) but cannot decide.
--    * Transitions: pending -> approved, pending -> rejected (reason required).
--      Re-sending the decision already in effect is an idempotent no-op
--      (outcome 'unchanged', no UPDATE, therefore no audit event). Every other
--      transition is refused (SQLSTATE 55000). Suspension/reinstatement are not
--      exposed here (no ATCO-confirmed workflow; suspension has no reason column).
--    * Conflict of interest: a reviewer may not decide on an organisation they
--      created or belong to (any membership status).
--    * Concurrency: SELECT ... FOR UPDATE serialises competing reviews; the
--      loser re-reads the committed state and gets 'unchanged' or a refusal.
--    * Audit: the existing AFTER trigger trg_organizations_audit_events writes
--      exactly one approval_events row per real status change (actor =
--      auth.uid()); the existing BEFORE trigger stamps approved_by/approved_at.
--
-- 2. Direct organisation UPDATE is closed for application roles: the
--    super_admin-only policy and the UPDATE grant are removed so the reviewed,
--    validated RPC above cannot be bypassed with a raw PATCH (which skipped the
--    transition and conflict-of-interest rules). Owner/console access unchanged.
--
-- 3. my_company_memberships()
--    Read-only, caller-scoped: the caller's OWN memberships with each
--    organisation's name and status, so a member of a rejected or suspended
--    company can learn that state (A20 hides those rows from the normal select
--    policy). It returns NO rejection reason, no approval metadata and nothing
--    about organisations the caller is not a member of.
--
-- SECURITY DEFINER functions: owner = migration role, set search_path = '',
-- every reference schema-qualified. EXECUTE: authenticated only — explicitly
-- revoked from public, anon AND service_role, because the local default
-- privileges grant EXECUTE to all three on creation (see 20261026190000).
-- ===========================================================================

create or replace function public.review_company(
  p_organization_id uuid,
  p_decision        text,            -- 'approve' | 'reject'
  p_reason          text default null -- required for 'reject' (<= 500 chars); not accepted for 'approve'
)
returns table (id uuid, status text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid;
  v_reason  text;
  v_target  text;
  v_org     record;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not public.has_platform_role('{super_admin}') then
    raise exception 'not_authorized: only an ATCO super_admin may review companies'
      using errcode = '42501';
  end if;

  -- organizations.approved_by references public.profiles, so a reviewer needs an
  -- ACTIVE profile row. It is created by the same trusted provisioning step that
  -- grants the platform role (docs/backend/phase3-approval-bookings.md); it is never
  -- invented here. A suspended reviewer may not decide.
  select p.status into v_reason from public.profiles as p where p.id = v_uid for share;
  if not found then
    raise exception 'reviewer_profile_missing: provision a profile for this ATCO account before reviewing'
      using errcode = '55000';
  end if;
  if v_reason <> 'active' then
    raise exception 'not_authorized: suspended accounts may not review companies' using errcode = '42501';
  end if;
  v_reason := null;

  if p_organization_id is null then
    raise exception 'invalid organization id' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'invalid decision (approve or reject)' using errcode = '22023';
  end if;

  v_reason := nullif(btrim(p_reason), '');
  if p_decision = 'reject' and (v_reason is null or char_length(v_reason) > 500) then
    raise exception 'invalid rejection reason (required, <= 500 chars)' using errcode = '22023';
  end if;
  if p_decision = 'approve' and v_reason is not null then
    -- There is no column for an approval note; refusing it avoids silently
    -- discarding text the reviewer believes was recorded.
    raise exception 'invalid reason: an approval does not take a reason' using errcode = '22023';
  end if;
  v_target := case p_decision when 'approve' then 'approved' else 'rejected' end;

  select o.id, o.status, o.created_by, o.rejection_reason
    into v_org
    from public.organizations as o
   where o.id = p_organization_id
     for update;

  if not found then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;

  if v_org.created_by = v_uid or exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = v_uid) then
    raise exception 'conflict_of_interest: reviewers may not decide on their own organization'
      using errcode = '42501';
  end if;

  if v_org.status = v_target then
    if v_target = 'rejected' and v_org.rejection_reason is distinct from v_reason then
      raise exception 'invalid_transition: organization was already rejected with a different reason'
        using errcode = '55000';
    end if;
    -- Idempotent retry: the decision is already in effect. No write, no event.
    return query select v_org.id, v_org.status, 'unchanged'::text;
    return;
  end if;

  if v_org.status <> 'pending' then
    raise exception 'invalid_transition: only pending organizations can be reviewed (current status: %)', v_org.status
      using errcode = '55000';
  end if;

  update public.organizations as o
     set status = v_target,
         rejection_reason = case when v_target = 'rejected' then v_reason else null end
   where o.id = p_organization_id;

  return query select p_organization_id, v_target, 'decided'::text;
  return;
end;
$$;

revoke execute on function public.review_company(uuid, text, text) from public, anon, service_role;
grant  execute on function public.review_company(uuid, text, text) to authenticated;

comment on function public.review_company(uuid, text, text) is
  'ATCO company review. super_admin only; pending -> approved | rejected (reason required for rejection); '
  'same decision again = unchanged (no event); reviewers cannot decide on their own organisation. '
  'Audit events are written by trg_organizations_audit_events.';

-- ---------------------------------------------------------------------------
-- Close the raw UPDATE path (the RPC above is now the only lifecycle writer).
-- ---------------------------------------------------------------------------
drop policy if exists organizations_update_super_admin_only on public.organizations;
revoke update on public.organizations from authenticated;

-- ---------------------------------------------------------------------------
-- my_company_memberships(): the caller's own memberships and organisation status
-- ---------------------------------------------------------------------------
create or replace function public.my_company_memberships()
returns table (
  organization_id     uuid,
  legal_name          text,
  display_name        text,
  organization_status text,
  membership_role     text,
  membership_status   text
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id, o.legal_name, o.display_name, o.status,
         m.membership_role, m.status
    from public.organization_memberships as m
    join public.organizations as o on o.id = m.organization_id
   where m.user_id = (select auth.uid())
   order by m.created_at, m.organization_id;
$$;

revoke execute on function public.my_company_memberships() from public, anon, service_role;
grant  execute on function public.my_company_memberships() to authenticated;

comment on function public.my_company_memberships() is
  'Caller-scoped, read-only: own memberships with organisation name and status (including rejected/suspended). '
  'Exposes no rejection reason, approval metadata or other organisations.';
