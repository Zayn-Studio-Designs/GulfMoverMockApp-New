-- ==========================================================================
-- Gulf Mover — Phase 1 (Module 1) — Table privilege hardening
-- File: 20261026150240_privilege_hardening.sql
--
-- STATUS: DRAFT FOR REVIEW. Not applied anywhere. Tables in this file were
--         created by the two earlier migrations; THIS file only changes
--         table-level SQL privileges. No table, column, policy, function,
--         trigger or RLS state is created, altered or removed here.
--
-- WHY THIS EXISTS (T0 finding, 2026-10-26):
--   Postgres default privileges for the table-owning roles (postgres /
--   supabase_admin) inside schema public auto-grant the FULL privilege set
--   (a r w d D x t m = INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
--   REFERENCES, TRIGGER, MAINTAIN) to anon, authenticated and service_role
--   on every newly created public table. That matches Supabase cloud's
--   default exposure, and it materialized as direct ACL entries on all six
--   Phase-1 tables. Consequences found by T0:
--     * TRUNCATE is live for anon/authenticated. RLS NEVER applies to
--       TRUNCATE and PostgREST does not expose TRUNCATE, but a direct
--       connection with the anon/authenticated credential could wipe
--       approval_events (the append-only audit log) or role_assignments in
--       one statement. The review's "update/delete impossible for everyone"
--       invariant was not physically true at the grant layer.
--     * Write grants on approval_events, role_assignments and
--       platform_settings made T8–T11 fail at the RLS layer instead of the
--       SQL privilege layer — same "denied" outcome, wrong documented
--       mechanism.
--     * REFERENCES/TRIGGER/MAINTAIN grants (able to attach triggers, FKs and
--       maintenance operations on the audit log) exceeded the design.
--
-- WHAT THIS FILE DOES INTENTIONALLY:
--   1. Revokes EVERY table privilege anon and authenticated hold on the six
--      Module-1 tables (clears TRUNCATE, REFERENCES, TRIGGER, MAINTAIN and
--      anything else the defaults added).
--   2. Re-grants the exact minimal verbs per the approved matrix:
--        profiles                   authenticated: SELECT, INSERT, UPDATE
--        organizations              authenticated: SELECT, INSERT, UPDATE
--        organization_memberships   authenticated: SELECT, INSERT, UPDATE, DELETE
--        role_assignments           authenticated: SELECT only
--        approval_events            authenticated: SELECT only
--        platform_settings          authenticated: SELECT only
--      anon: NOTHING on any of the six tables.
--   3. Leaves service_role, the owning role postgres, function EXECUTE
--      grants, schema USAGE and every RLS policy untouched.
--
-- WHAT THIS FILE DOES NOT CHANGE:
--   * No REVOKE touches service_role or postgres (break-glass/console paths).
--   * RLS stays enabled on all six tables and all 14 policies are preserved.
--   * No PUBLIC grant exists on these tables today (verified T0, 2026-10-26:
--     aclexplode shows only postgres/anon/authenticated/service_role), so no
--     PUBLIC grant is revoked.
--
-- KNOWN LIMITATION, for the next module's migration author(s):
--   Default privileges in schema public are NOT altered here (out of scope
--   per review boundary). Every future migration creating new public tables
--   must carry its own explicit REVOKE/GRANT block like this one, or the
--   auto-grant will re-expose the new tables. Decision recorded for YZ.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. Clear everything anon and authenticated currently hold on the six
--    tables (including TRUNCATE / REFERENCES / TRIGGER / MAINTAIN).
--    Owned role postgres and service_role are deliberately not touched.
-- --------------------------------------------------------------------------
revoke all privileges on public.profiles                from anon, authenticated;
revoke all privileges on public.organizations           from anon, authenticated;
revoke all privileges on public.organization_memberships from anon, authenticated;
revoke all privileges on public.role_assignments        from anon, authenticated;
revoke all privileges on public.approval_events         from anon, authenticated;
revoke all privileges on public.platform_settings       from anon, authenticated;

-- --------------------------------------------------------------------------
-- 2. Re-grant the approved minimums to authenticated only.
-- --------------------------------------------------------------------------

-- profiles: a user reads and updates their own row; rows arrive at sign-up
-- (app path, Stage D) or via seed. INSERT policy profiles_insert_self applies.
grant select, insert, update on public.profiles to authenticated;

-- organizations: company staff create their own pending organization and the
-- super_admin lifecycle UPDATE policy does the rest. The organizations
-- UPDATE grant is the one the approval workflow explicitly needs.
grant select, insert, update on public.organizations to authenticated;

-- organization_memberships: admins add/remove company bookers; the
-- members_insert_* / memberships_delete_admin_or_super policies bind scope.
grant select, insert, update, delete on public.organization_memberships to authenticated;

-- role_assignments: READ-ONLY through the application (A11). The table's
-- only policy is roles_select_own_or_super; provisioning happens as the
-- owning role (seed / console), which does not need these grants.
grant select on public.role_assignments to authenticated;

-- approval_events: READ-ONLY through the application (A14). The audit
-- trigger runs as the table owner and needs nothing from these roles.
grant select on public.approval_events to authenticated;

-- platform_settings: READ-ONLY through the application (A13). The console
-- (owner role) flips values directly.
grant select on public.platform_settings to authenticated;

-- --------------------------------------------------------------------------
-- 3. anon keeps no table privileges on Module-1 tables. RLS-era expectations
--    for anon (T14: zero rows everywhere) are now enforced at BOTH layers:
--    no grant at all, and (as before) no anon policies.
-- --------------------------------------------------------------------------

comment on table public.approval_events is
  'Append-only decision log for application roles: anon holds NO privileges on this table
  at all, and authenticated holds SELECT only — no INSERT/UPDATE/DELETE grants (and no
  policies exist for those verbs either), and no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
  (RLS never applies to TRUNCATE, so grants are the only wall there). At application
  runtime the SECURITY DEFINER audit trigger log_organization_status_changes() (owned
  by postgres) is the normal producer of approval event rows; privileged development
  seeding may also insert historical events. The owning role postgres and service_role
  keep their console-level access. Hardened 2026-10-26 by revoking the Supabase
  default-privilege blanket grants from anon/authenticated; owner, service-role and
  trigger capabilities remain unchanged.';
