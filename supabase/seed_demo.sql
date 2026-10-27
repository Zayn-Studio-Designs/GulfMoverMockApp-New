-- ==========================================================================
-- Gulf Mover — Phase 1 — FICTIONAL development seed (seed_demo.sql)
-- STATUS: corrected draft (approved Phase 1 decisions applied 2026-10-26).
--         Not applied anywhere. No real people, companies, emails or phone
--         numbers exist in this file — every value is invented for
--         development testing only.
--
-- HOW TO USE (when a dev Supabase project exists, after approval):
--   1. Create five test users in the Supabase dashboard Auth page (the
--      supported way to create auth users). Use ANY locally disposable
--      emails you like; the table below joins on them:
--        atco-admin@dev.invalid        -> super_admin (approves Company A)
--        atco-ops@dev.invalid          -> operations
--        company-a-admin@dev.invalid   -> company admin, Company A
--        company-a-booker@dev.invalid  -> company booker, Company A
--        company-b-booker@dev.invalid  -> company booker, Company B
--      (the ".invalid" domain is reserved and cannot ever be emailed).
--   2. Run this file in the SQL editor. It runs as the migration/owner role;
--      owner privileges (RLS does not apply to the owner) are what allow
--      dev seeding despite Row Level Security.
--   3. Running twice is safe: every write is guarded by on-conflict
--      do-nothing or a not-exists check.
--
-- Company A is fictionally an organization that was submitted about 30 days
-- ago and approved about 27 days ago: the 'submitted' and 'approved' events
-- written below depict that story and are consistent with its approved
-- status. This is DEMO DATA ONLY — it does not define a production
-- "imported / pre-approved organization" workflow. Whether such a workflow
-- exists at all, and what events it should record, is an open question
-- (review doc assumption A10).
-- ==========================================================================

begin;

-- --------------------------------------------------------------------------
-- 1. Configurable corporate approval policy — STORED CONFIGURATION ONLY.
--    Nothing reads or enforces it in Phase 1; ATCO flips values in the
--    console. A settings/enforcement workflow is deferred (review doc A13).
-- --------------------------------------------------------------------------
insert into public.platform_settings (key, value, description)
values
  ('corporate_approval',
   '{"mode": "manual_review",
     "auto_approve": false,
     "booking_allowed_for_statuses": ["approved"],
     "note": "DEMO default. Pending ATCO policy confirmation (blueprint §14)."}'::jsonb,
   'Stored configuration only in Phase 1 (no enforcement). ATCO must confirm the production rule before go-live; a settings workflow is deferred (review doc A13).')
on conflict (key) do nothing;

-- --------------------------------------------------------------------------
-- 2. Profiles for the five fictional users.
--    The sign-up auto-provisioning flow is UNRESOLVED (review doc A12): no
--    trigger creates profiles automatically. The seed supplies app-side rows
--    so profile tests and approval metadata have something to point at.
-- --------------------------------------------------------------------------
insert into public.profiles (id, display_name)
select u.id, v.display_name
from (values
  ('atco-admin@dev.invalid',       'Atco Demo Administrator (Fictional)'),
  ('atco-ops@dev.invalid',         'Atco Demo Operations (Fictional)'),
  ('company-a-admin@dev.invalid',  'Demo Admin — Sea Horizon (Fictional)'),
  ('company-a-booker@dev.invalid', 'Demo Booker — Sea Horizon (Fictional)'),
  ('company-b-booker@dev.invalid', 'Demo Booker — Jannah (Fictional)')
) as v(email, display_name)
join auth.users u on u.email = v.email
on conflict (id) do nothing;

-- --------------------------------------------------------------------------
-- 3. Fictional organizations (two, so cross-company tests have a contrast).
--    created_by is NOT NULL and points at a real (fictional) auth user.
--    Company A carries approval metadata consistent with its approved
--    status; approved_by references the profile seeded above.
-- --------------------------------------------------------------------------
insert into public.organizations
  (id, legal_name, display_name, registration_number, contact_email, status,
   created_by, approved_by, approved_at, created_at)
values
  ('11111111-1111-4111-8111-111111111111',
   'Sea Horizon Logistics (Demo) FZE', 'Sea Horizon (Demo)', 'SEED-REG-0001',
   'ops@seed-a.invalid', 'approved',
   (select id from auth.users where email = 'company-a-admin@dev.invalid'),
   (select id from auth.users where email = 'atco-admin@dev.invalid'),
   now() - interval '27 days',
   now() - interval '30 days'),
  ('22222222-2222-4222-8222-222222222222',
   'Jannah Freight Services (Demo)', 'Jannah (Demo)', 'SEED-REG-0002',
   'ops@seed-b.invalid', 'pending',
   (select id from auth.users where email = 'company-b-booker@dev.invalid'),
   null, null,
   now() - interval '2 days')
on conflict (id) do nothing;

-- --------------------------------------------------------------------------
-- 4. Company A approval history — FICTIONAL, BACKDATED, DEVELOPMENT ONLY.
--    The audit trigger (0001) writes a 'submitted' event only when a
--    genuinely PENDING organization is inserted, so the already-approved
--    Company A produces no automatic event and invents none here — its
--    history is written explicitly to match its approved status
--    (review doc A10). Company B's 'submitted' event is written
--    automatically by the trigger during the insert above.
-- --------------------------------------------------------------------------
insert into public.approval_events
  (subject_type, subject_id, decision, reason, actor_user_id, occurred_at)
select 'organization', o.id, 'submitted', null,
       (select id from auth.users where email = 'company-a-admin@dev.invalid'),
       now() - interval '30 days'
from public.organizations o
where o.id = '11111111-1111-4111-8111-111111111111'
  and not exists (
    select 1 from public.approval_events e
    where e.subject_type = 'organization' and e.subject_id = o.id
      and e.decision = 'submitted');

insert into public.approval_events
  (subject_type, subject_id, decision, reason, actor_user_id, occurred_at,
   before_state, after_state)
select 'organization', o.id, 'approved', null,
       (select id from auth.users where email = 'atco-admin@dev.invalid'),
       now() - interval '27 days',
       jsonb_build_object('status', 'pending'),
       jsonb_build_object('status', 'approved')
from public.organizations o
where o.id = '11111111-1111-4111-8111-111111111111'
  and not exists (
    select 1 from public.approval_events e
    where e.subject_type = 'organization' and e.subject_id = o.id
      and e.decision = 'approved');

-- --------------------------------------------------------------------------
-- 5. Memberships and roles.
--    Lookups fail loudly if a user is missing, which is intentional.
--    role_assignments is READ-ONLY through the authenticated app in Phase 1;
--    this seed (run as the owner) is one of the intended provisioning paths
--    (review doc A11).
-- --------------------------------------------------------------------------
insert into public.organization_memberships (organization_id, user_id, membership_role, status)
values
  ('11111111-1111-4111-8111-111111111111',
   (select id from auth.users where email = 'company-a-admin@dev.invalid'),
   'company_admin', 'active'),
  ('22222222-2222-4222-8222-222222222222',
   (select id from auth.users where email = 'company-b-booker@dev.invalid'),
   'company_booker', 'active')
on conflict (organization_id, user_id) do nothing;

insert into public.role_assignments (user_id, organization_id, role, status)
values
  ((select id from auth.users where email = 'atco-admin@dev.invalid'), null, 'super_admin', 'active'),
  ((select id from auth.users where email = 'atco-ops@dev.invalid'),   null, 'operations',  'active')
on conflict (user_id, role) where organization_id is null do nothing;

-- --------------------------------------------------------------------------
-- 6. A second Company A member as a booker — used in denial tests where a
--    non-admin company user should be unable to manage colleagues.
-- --------------------------------------------------------------------------
insert into public.organization_memberships (organization_id, user_id, membership_role, status)
values
  ('11111111-1111-4111-8111-111111111111',
   (select id from auth.users where email = 'company-a-booker@dev.invalid'),
   'company_booker', 'active')
on conflict (organization_id, user_id) do nothing;

commit;

-- ==========================================================================
-- Reminder: this file is development-only, fictional, and must never be run
-- against production. Blueprint §11.4 is followed exactly.
-- ==========================================================================
