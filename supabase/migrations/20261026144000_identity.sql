-- ==========================================================================
-- Gulf Mover — Phase 1 (Module 1) — Identity, Organizations, Approvals
-- File: 0001_identity.sql   (schema only)
--
-- STATUS: DRAFT FOR REVIEW. This file has NOT been applied to any database.
--         No Supabase project exists; models for application-auth
-- Source: "Gulf Mover — Backend Blueprint v1.0", sections 3 (module 1),
--         4 (identity and organizations), 6 (authorization & security),
--         7 (role matrix), 14 (decisions still required).
--
-- Design rules kept from the blueprint:
--   * UUID primary keys, created_at/updated_at, foreign keys,
--     unique constraints, explicit statuses.
--   * Browser-supplied values are never trusted for permissions; roles are
--     read from internal tables by SECURITY DEFINER helpers (file 0002).
--   * Corporate approval policy is DATA (platform_settings), not code.
--   * All timestamps are UTC (timestamptz).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. Conventions
-- --------------------------------------------------------------------------
-- updated_at maintenance via one shared trigger.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- 1. platform_settings — configurable business policy switches
-- --------------------------------------------------------------------------
-- Purpose: keeps "decisions still required" (blueprint §14) configurable.
-- Adding/reading rows here changes behaviour without touching code or table
-- structure. Write access is restricted to super_admin (file 0002).
create table public.platform_settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,  -- set by super_admin; validated in app logic, never trusted from browser
  constraint settings_updated_at_shape check (jsonb_typeof(value) = 'object')
);

-- Corporate approval policy (blueprint: approval policy is configurable).
-- mode          : 'manual_review' (default) — ATCO staff approve new organizations.
-- auto_approve  : must stay false until ATCO explicitly changes the policy.
-- Placeholder values below are DEMO defaults and marked for ATCO confirmation.
comment on table public.platform_settings is
  'Configurable business policy switches (e.g. corporate approval mode). ATCO-confirmed values required before production.';

-- --------------------------------------------------------------------------
-- 2. profiles — one row per authenticated person (blueprint §4)
-- --------------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key,  -- id == auth.users.id (Supabase Auth)
  display_name       text not null,
  phone              text,              -- minimal; no identity numbers stored
  preferred_language text not null default 'en'
                     check (preferred_language in ('en', 'ar')),
  status             text not null default 'active'
                     check (status in ('active', 'suspended')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (id) references auth.users (id) on delete cascade
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Guard: a user cannot change their own status or id; only super_admin may
-- change a profile status (e.g. suspending an account). Prevents self-harm
-- escalation AND keeps the check server-side.
create function public.guard_profile_status()
returns trigger
language plpgsql
security definer                      -- reads role_assignments safely
set search_path = ''                  -- hardened: unqualified names fail
as $$
begin
  if new.id <> old.id then
    raise exception 'Gulf Mover: profile id is immutable';
  end if;
  if new.status <> old.status
     and new.id = (select auth.uid())
     and not exists (
       select 1 from public.role_assignments ra
       where ra.user_id = (select auth.uid())
         and ra.organization_id is null
         and ra.role = 'super_admin'
         and ra.status = 'active'
     )
  then
    raise exception 'Gulf Mover: only ATCO super_admin may change account status';
  end if;
  return new;
end;
$$;

create trigger trg_profiles_guard_status
  before update on public.profiles
  for each row execute function public.guard_profile_status();

comment on table public.profiles is
  'Application view of a Supabase Auth user. Sensitive identity fields are minimized per blueprint §4.';

-- --------------------------------------------------------------------------
-- 3. organizations — corporate customers awaiting or holding ATCO approval
-- --------------------------------------------------------------------------
create table public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  legal_name          text not null,
  display_name        text,
  registration_number text,
  billing_contact     text,
  contact_email       text,
  contact_phone       text,
  -- Blueprint-approved organization lifecycle (§4):
  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'suspended')),
  approved_by         uuid references public.profiles (id),  -- set by approval flow, never by browser
  approved_at         timestamptz,
  rejection_reason    text,
  created_by          uuid not null references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_organizations_status on public.organizations (status);
create trigger trg_organizations_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- Guard: browser users can create organizations only in 'pending' state.
-- The status column is guarded later by RLS (0002): only super_admin may move
-- an organization through the lifecycle, and every state change produces an
-- approval event through the audit trigger below.
create function public.guard_organizations_insert_by_user()
returns trigger
language plpgsql
as $$
begin
  if new.created_by <> (select coalesce(auth.uid(), new.created_by)) then
    -- auth.uid() is trusted; mismatch would be a forged value
    raise exception 'Gulf Mover: organization creator must be the signed-in user';
  end if;
  return new;
end;
$$;

create trigger trg_organizations_guard_creator
  before insert on public.organizations
  for each row execute function public.guard_organizations_insert_by_user();

-- Guard: appending approval events on status transitions (append-only log).
-- Runs as SECURITY DEFINER (executes as the migration/owner role, which owns
-- approval_events): RLS does not apply to the table owner, so audit inserts
-- always succeed regardless of the acting role's privileges.
create function public.log_organization_status_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    -- A 'submitted' event records a real submission. An organization that
    -- exists already approved (imported or dev-seeded) invents no submission
    -- it never made; its history belongs to whatever inserted it — see
    -- phase1-review assumption A10.
    insert into public.approval_events
      (subject_type, subject_id, decision, reason, actor_user_id)
    values
      ('organization', new.id, 'submitted', null, new.created_by);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- Provisional lifecycle mapping — NOT confirmed by ATCO (assumptions
    -- A16–A18 in phase1-review §4.1): a return to pending is audited as a
    -- fresh 'submitted' event (resubmission), coming back from suspension
    -- straight into approval is 'reinstated', and every other transition
    -- keeps the state's own decision word. This mapping is what keeps the
    -- event inside the approval_events.decision check vocabulary for
    -- transitions to pending, without adding 'pending' to that check.
    insert into public.approval_events
      (subject_type, subject_id, decision, reason, actor_user_id,
       before_state, after_state)
    values
      ('organization', new.id,
       case
         when new.status = 'pending' then 'submitted'
         when old.status = 'suspended' and new.status = 'approved' then 'reinstated'
         else new.status
       end,
       case
         when new.status = 'pending'
           then 'Returned to pending from ' || old.status
         when new.status = 'rejected' then new.rejection_reason
       end,
       (select auth.uid()),
       jsonb_build_object('status', old.status),
       jsonb_build_object('status', new.status));
    -- Metadata semantics (provisional, A18): approved_by/approved_at are the
    -- most recent SUCCESSFUL approval — stamped only when the organization
    -- transitions INTO 'approved' (including reinstatement from suspended),
    -- and never overwritten by a rejection, suspension or return to pending.
    if new.status = 'approved' then
      new.approved_by := (select auth.uid());
      new.approved_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_organizations_audit
  before insert or update on public.organizations
  for each row execute function public.log_organization_status_changes();

-- Blueprint keeps the column names approved_by/approved_at; their MEANING is
-- defined here because rejections/suspensions must not overwrite them
-- (provisional semantics, pending ATCO confirmation — A18):
comment on column public.organizations.approved_by is
  'ATCO actor of the most recent successful approval: set by the audit trigger
  when status transitions into approved (including reinstatement from
  suspended); a rejection, suspension or return to pending leaves this value
  untouched. Provisional meaning, pending ATCO confirmation (A18).';
comment on column public.organizations.approved_at is
  'When the most recent successful approval happened: stamped together with
  approved_by by the audit trigger; never overwritten by a rejection,
  suspension or return to pending. Provisional meaning, pending ATCO
  confirmation (A18).';

comment on table public.organizations is
  'Corporate customer organizations. Creating is allowed for signed-in users with status pending; lifecycle changes are super_admin only. Return to pending is provisionally audited as a fresh submitted event; suspended-to-approved is provisionally a reinstated event (A16/A17, not yet ATCO-confirmed).';

-- --------------------------------------------------------------------------
-- 4. organization_memberships — who acts on behalf of which company
-- --------------------------------------------------------------------------
create table public.organization_memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- Only COMPANY-side roles exist here. ATCO staff roles never live in this
  -- table (structural anti-escalation: no path can make you staff here).
  membership_role text not null check (membership_role in ('company_admin', 'company_booker')),
  status          text not null default 'active'
                  check (status in ('active', 'invited', 'suspended')),
  invited_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index idx_memberships_user on public.organization_memberships (user_id);
create index idx_memberships_org on public.organization_memberships (organization_id);
create trigger trg_memberships_updated_at
  before update on public.organization_memberships
  for each row execute function public.set_updated_at();

comment on table public.organization_memberships is
  'Per-company active membership. The role vocabulary is intentionally limited to company-side roles.';

-- --------------------------------------------------------------------------
-- 5. role_assignments — the ONLY source of ATCO/platform roles
-- --------------------------------------------------------------------------
create table public.role_assignments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- NULL organization = platform-wide (ATCO staff). NOT NULL = company-scoped.
  organization_id uuid references public.organizations (id) on delete cascade,
  role            text not null check (role in (
                    'super_admin', 'operations', 'finance', 'boarding_staff',
                    'company_admin', 'company_booker', 'agent',
                    'individual_customer', 'crew_viewer')),
  status          text not null default 'active'
                  check (status in ('active', 'suspended')),
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Structural rules from the blueprint role matrix (§7):
  constraint role_scope_shape check (
    ( organization_id is null and role in (
        'super_admin', 'operations', 'finance', 'boarding_staff',
        'individual_customer', 'crew_viewer') )
    or
    ( organization_id is not null and role in ('company_admin', 'company_booker', 'agent') )
  )
);

-- Uniqueness craft (Postgres treats NULLs as distinct in unique constraints):
create unique index idx_role_platform_unique
  on public.role_assignments (user_id, role) where organization_id is null;
create unique index idx_role_org_unique
  on public.role_assignments (user_id, organization_id, role)
  where organization_id is not null;
create index idx_role_user on public.role_assignments (user_id);
create trigger trg_roles_updated_at
  before update on public.role_assignments
  for each row execute function public.set_updated_at();

-- Guard: hierarchy protection (security requirement #1).
--   * No (authenticated) user, including an existing super_admin, may CREATE,
--     CHANGE, or DELETE a 'super_admin' row from the application. super_admin
--     rows are provisioned by migrations/seed or by the service_role console
--     workflow — a deliberate break-glass choice documented in the review.
--   * Ordinary users never reach write policies anyway (see 0002); this guard
--     is defence in depth, not the primary wall.
create function public.guard_role_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_caller uuid := (select auth.uid());
begin
  if tg_op in ('INSERT') then
    if new.role = 'super_admin' and v_caller is not null then
      raise exception 'Gulf Mover: super_admin rows are provisioned out-of-band only';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and v_caller is not null then
    -- everyone who *can* write roles must record themselves
    new.created_by := coalesce(new.created_by, v_caller);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if (old.role = 'super_admin') then
      raise exception 'Gulf Mover: super_admin rows are immutable from the application';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger trg_roles_guard_hierarchy
  before insert or update or delete on public.role_assignments
  for each row execute function public.guard_role_hierarchy();

comment on table public.role_assignments is
  'Authoritative role store. Writes restricted to super_admin (per 0002). No policy grants other users any write path.';

-- --------------------------------------------------------------------------
-- 6. approval_events — append-only decision log (security requirement #4)
-- --------------------------------------------------------------------------
create table public.approval_events (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type in ('organization','role_assignment','membership')),
  subject_id    uuid not null,
  decision      text not null check (decision in ('submitted','approved','rejected','suspended','reinstated')),
  reason        text,
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  occurred_at   timestamptz not null default now(),
  before_state  jsonb,
  after_state   jsonb
);

create index idx_approval_subject on public.approval_events (subject_type, subject_id, occurred_at);

comment on table public.approval_events is
  'Append-only by policy: NO UPDATE/DELETE policies are ever granted; log rows are immutable to application roles.';

-- --------------------------------------------------------------------------
-- Done. RLS + helper functions + policies are in 0002_rls_policies.sql.
-- Seed (fictional dev data) is in seed_demo.sql and is applied separately.
-- ==========================================================================
