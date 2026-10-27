-- ===========================================================================
-- TRUSTED, OUT-OF-BAND provisioning of an ATCO platform role (NOT a migration).
-- ===========================================================================
-- The application has NO path that grants platform roles: role_assignments is
-- read-only to `authenticated`, and guard_role_hierarchy() refuses any
-- super_admin insert made with an application identity (auth.uid() not null).
-- This template is therefore run by the project owner, as the database owner
-- (Supabase SQL editor or psql as `postgres`), after verifying the person's
-- identity and authority with ATCO. Record who approved it and when.
--
-- Steps:
--   1. The person signs up in the app and confirms their e-mail address.
--   2. Look up their auth user id (by e-mail) — check it is the right person.
--   3. Run this file with the three variables set, e.g. with psql:
--        psql "$DB_URL" -v user_email='person@atco.example' \
--             -v display_name='Full Name' -v role='super_admin' \
--             -f supabase/scripts/provision_platform_role.sql
--      role is one of: super_admin | operations | finance | boarding_staff
--   4. Ask the person to sign out and in again; the ATCO screens appear only
--      when the database confirms the role.
--
-- A profile row is required for reviewers (organizations.approved_by references
-- public.profiles); review_company() refuses accounts without one.
-- Revocation: update public.role_assignments set status = 'suspended' ... (owner
-- session; super_admin rows are immutable from the application by design).
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- Fail loudly (division by zero aborts the transaction) unless exactly one
-- confirmed auth user matches. psql variables are not expanded inside $$ blocks,
-- hence a plain query.
select 1 / (case when count(*) = 1 then 1 else 0 end) as exactly_one_confirmed_user
  from auth.users
 where lower(email) = lower(:'user_email') and email_confirmed_at is not null;

insert into public.profiles (id, display_name, preferred_language, status)
select u.id, :'display_name', 'en', 'active'
  from auth.users as u
 where lower(u.email) = lower(:'user_email')
on conflict (id) do nothing;

insert into public.role_assignments (user_id, role, status)
select u.id, :'role', 'active'
  from auth.users as u
 where lower(u.email) = lower(:'user_email');

select ra.user_id, ra.role, ra.status, ra.created_at
  from public.role_assignments as ra
  join auth.users as u on u.id = ra.user_id
 where lower(u.email) = lower(:'user_email');

commit;
