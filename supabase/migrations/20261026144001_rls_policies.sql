-- ==========================================================================
-- Gulf Mover — Phase 1 (Module 1) — Row Level Security, helpers, policies
-- File: 0002_rls_policies.sql
--
-- STATUS: DRAFT FOR REVIEW. This file has NOT been applied to any database.
--
-- Security goals (review doc §2):
--   1. No self-granted ATCO staff / super_admin privileges.
--   2. No cross-company data visibility.
--   3. No self-approval of organizations by company users.
--   4. Approval events are append-only; no UPDATE/DELETE policy exists.
--   5. Identity/roles/approval state are never trusted from the browser.
--
-- DEFAULT-DENY: every table below has RLS ENABLED but NO permissive policy
-- beyond the explicit grants in this file. A new, careless policy cannot
-- silently open data; the empty state is "no access at all".
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. Enable Row Level Security on all exposed tables (default deny)
-- --------------------------------------------------------------------------
alter table public.profiles                enable row level security;
alter table public.organizations           enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.role_assignments        enable row level security;
alter table public.approval_events         enable row level security;
alter table public.platform_settings       enable row level security;

-- --------------------------------------------------------------------------
-- 1. SECURITY DEFINER helpers (RLS recursion avoidance)
--
-- Policies that query the *same* table they protect can loop (classic
-- recursion trap on membership tables). Solution used by Supabase docs and
-- the standard enterprise pattern: all cross-table checks run here, in
-- functions that bypass RLS and are therefore read-exactly-what-we-say.
--
--   * All are SECURITY DEFINER with `set search_path = ''` so unqualified
--     names fail fast instead of resolving through something sneaky.
--   * All are STABLE (no data modification).
--   * EXECUTE is revoked from public/anon and granted to authenticated only
--     (least privilege on function calls too).
--
-- The browser authenticates via a JWT unguessable token (auth.uid()) — it
-- never gets to *assert* its own permissions.
-- --------------------------------------------------------------------------

create function public.active_org_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.organization_id
  from public.organization_memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and exists (
      select 1 from public.organizations o
      where o.id = m.organization_id
        and ( -- within an approved org, or the org is your own pending one
              o.status = 'approved'
           or exists (select 1 from public.organization_memberships m2
                      where m2.organization_id = o.id
                        and m2.status = 'active'
                        and m2.membership_role = 'company_admin')
        )
    );
$$;

create function public.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.membership_role = any(p_roles)
  );
$$;

create function public.has_platform_role(p_roles text[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.role_assignments ra
    where ra.user_id = (select auth.uid())
      and ra.organization_id is null          -- platform-wide only
      and ra.role = any(p_roles)
      and ra.status = 'active'
  );
$$;

-- Function hardening (blueprint §6 "SQL function privileges"):
revoke execute on function public.active_org_ids()           from public, anon;
revoke execute on function public.has_org_role(uuid, text[]) from public, anon;
revoke execute on function public.has_platform_role(text[])  from public, anon;
grant  execute on function public.active_org_ids()           to authenticated;
grant  execute on function public.has_org_role(uuid, text[]) to authenticated;
grant  execute on function public.has_platform_role(text[])  to authenticated;

-- --------------------------------------------------------------------------
-- 2. Table privileges (baseline grants; RLS still rows-filtering on top)
-- --------------------------------------------------------------------------
-- Explicit > implicit. authenticated receives exactly these objects' verbs;
-- anon receives nothing (sign-up flows do not need these tables directly).
grant usage on schema public to authenticated;

grant select, insert, update           on public.profiles                 to authenticated;
grant select, insert, update           on public.organizations            to authenticated;
-- update above enables the ATCO approval workflow; RLS keeps it super_admin-only.
grant select, insert, update, delete   on public.organization_memberships to authenticated;
grant select                           on public.role_assignments         to authenticated;
grant select                           on public.approval_events          to authenticated;
grant select                           on public.platform_settings        to authenticated;
-- Deliberately ABSENT (each is a recorded decision, not an error to hide):
--   * approval_events: INSERT / UPDATE / DELETE — append-only (A6, A14); the
--     audit trigger in 0001 is the only producer.
--   * role_assignments: INSERT / UPDATE / DELETE — read-only app rows until a
--     real staff-management workflow exists (A11).
--   * platform_settings: UPDATE / INSERT / DELETE — the corporate-approval
--     value stays stored configuration; console writes only (A13).

-- --------------------------------------------------------------------------
-- 3. profiles
-- --------------------------------------------------------------------------
create policy profiles_select_self_or_super
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.has_platform_role('{super_admin}')
  );

create policy profiles_insert_self
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_self_or_super
  on public.profiles for update to authenticated
  using (
    id = (select auth.uid())
    or public.has_platform_role('{super_admin}')
  )
  with check (
    id = (select auth.uid())
    or public.has_platform_role('{super_admin}')
  );
-- Status column changes by non-super users are additionally blocked by
-- guard_profile_status() in 0001 (row-level policies cannot be column-scoped).

-- --------------------------------------------------------------------------
-- 4. organizations
-- --------------------------------------------------------------------------
create policy organizations_select_staff_or_members
  on public.organizations for select to authenticated
  using (
    public.has_platform_role('{super_admin, operations}')
    or id in (select public.active_org_ids())
  );
-- Finance is deliberately NOT granted organization visibility (blueprint §6:
-- finance reviews payments, not unrestricted identity data).

create policy organizations_insert_pending_only
  on public.organizations for insert to authenticated
  with check (
    status = 'pending'                          -- no self-approval (req #3)
    and created_by = (select auth.uid())        -- cannot create "as someone else"
  );
-- The audit trigger in 0001 records the 'submitted' event automatically.

create policy organizations_update_super_admin_only
  on public.organizations for update to authenticated
  using (public.has_platform_role('{super_admin}'))
  with check (public.has_platform_role('{super_admin}'));
-- Lifecycle transitions are super_admin-only; each transition is written to
-- approval_events by the audit trigger in 0001 (append-only log).

-- (No DELETE policy: organizations are cancelled by status change, keeping
--  history intact — blueprint §6 "retain original records".)

-- --------------------------------------------------------------------------
-- 5. organization_memberships
-- --------------------------------------------------------------------------
create policy memberships_select_relevant
  on public.organization_memberships for select to authenticated
  using (
    user_id = (select auth.uid())                                   -- own memberships
    or organization_id in (select public.active_org_ids())          -- same company
    or public.has_platform_role('{super_admin, operations}')        -- ATCO staff
  );

create policy memberships_insert_booker_by_admin
  on public.organization_memberships for insert to authenticated
  with check (
    membership_role = 'company_booker'
    and status in ('active', 'invited')
    and public.has_org_role(organization_id, '{company_admin}')
    and user_id <> (select auth.uid())            -- admin can't add *themselves* (already member; prevents self-elevation paths)
    and invited_by = (select auth.uid())
  );

create policy memberships_insert_any_company_role_super_admin
  on public.organization_memberships for insert to authenticated
  with check (public.has_platform_role('{super_admin}'));

-- (Company users cannot insert company_admin memberships, and no path can
--  create ATCO staff rows at all — see the table constraint in 0001. Promotions
--  and other provisioning happen by seed/console while role writes are
--  console-only; review doc A11.)

create policy memberships_update_super_admin_only
  on public.organization_memberships for update to authenticated
  using (public.has_platform_role('{super_admin}'))
  with check (public.has_platform_role('{super_admin}'));

create policy memberships_delete_admin_or_super
  on public.organization_memberships for delete to authenticated
  using (
    ( membership_role = 'company_booker'
      and public.has_org_role(organization_id, '{company_admin}') )
    or public.has_platform_role('{super_admin}')
  );
-- company_admin can remove their company's bookers only; other admins and
-- themselves are out of reach. super_admin can remove anyone.

-- --------------------------------------------------------------------------
-- 6. role_assignments — the gate between customers and ATCO roles
-- --------------------------------------------------------------------------
create policy roles_select_own_or_super
  on public.role_assignments for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.has_platform_role('{super_admin}')
  );

-- role_assignments is READ-ONLY through the authenticated app in Phase 1:
-- no insert/update/delete policy and no such grant exist. Platform roles are
-- provisioned by migrations/seed or the console workflow only (review doc A11).
-- An app-path staff-management workflow is deferred until it exists; when it
-- is built, its write policies will be added *with* the grant and will keep
-- this double wall: policies gated on has_platform_role('super_admin') and
-- role <> 'super_admin', backed by the hierarchy guard trigger in 0001
-- (which rejects super_admin rows even from a super_admin session).

-- --------------------------------------------------------------------------
-- 7. approval_events — read widely inside parties, written ONLY by the
--    audit trigger, NEVER edited
-- --------------------------------------------------------------------------
create policy approval_events_select_relevant
  on public.approval_events for select to authenticated
  using (
    public.has_platform_role('{super_admin, operations, finance}')
    or (subject_type = 'organization'
        and subject_id in (select public.active_org_ids()))
  );

-- There is NO INSERT policy and NO INSERT grant: the only producer of
-- approval_events is the audit trigger in 0001. That trigger is SECURITY
-- DEFINER — it executes as the function's owner (the migration role that owns
-- approval_events), RLS does not apply to the table owner, and its inserts
-- therefore always succeed. Its actor_user_id is server-derived
-- (auth.uid() of the acting approver), so recorded history cannot be forged.
-- Direct app-side inserts are deferred until a workflow exists (A14) rather
-- than kept as unused write surface. There are also no UPDATE/DELETE policies
-- and no such grants — security requirement #4, on purpose.

-- --------------------------------------------------------------------------
-- 8. platform_settings — readable policy switches; console-only writes in
--    Phase 1
-- --------------------------------------------------------------------------
create policy settings_select_authenticated
  on public.platform_settings for select to authenticated
  using (true);
-- Read-only to the company app so the UI can reflect the correct approval
-- mode (e.g. tell the company "under review"). Contains no secrets.
-- anon access is intentionally absent in this draft — see review doc A7.

-- No UPDATE policy and NO UPDATE grant in Phase 1: corporate approval remains
-- *stored configuration* (review doc A13). ATCO changes values in the console
-- (the SQL editor runs as the owner; RLS does not apply to it). A settings
-- screen, and any app logic that actually reads/enforces the value, is Stage D.
-- No INSERT/DELETE policy or grant either: keys are provisioned by
-- migrations/seed only.

-- --------------------------------------------------------------------------
-- 9. Done. Nothing here trusts the browser:
--    roles  → role_assignments + memberships, read by definer helpers
--    status → organizations.status, writable only by super_admin
--    actor  → auth.uid() (server-verified identity)
-- --------------------------------------------------------------------------
