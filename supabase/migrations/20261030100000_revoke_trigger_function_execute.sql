-- Phase 6 hardening: least privilege for trigger functions and dead write policies.
--
-- FINDING (Phase 6 review): five trigger functions created in the Phase 1 migrations
-- still carried PostgreSQL's default EXECUTE grant to PUBLIC (and therefore to anon,
-- authenticated and service_role). Trigger functions return `trigger` and PostgreSQL
-- refuses to run them outside a trigger context, and PostgREST does not expose them at
-- all (POST /rest/v1/rpc/<name> returns PGRST202), so this was NOT exploitable. It is
-- still a real least-privilege gap and inconsistent with every later trigger function
-- in this schema (guard_profile_status, guard_sailing_write, stamp_actor_columns,
-- issue_leg_tickets, notify_operational_event, check_invitation_acceptance), which all
-- revoke EXECUTE explicitly. Nothing may call these functions directly.
revoke execute on function public.guard_organizations_insert_by_user() from public, anon, authenticated, service_role;
revoke execute on function public.guard_role_hierarchy()                from public, anon, authenticated, service_role;
revoke execute on function public.log_organization_status_changes()     from public, anon, authenticated, service_role;
revoke execute on function public.set_updated_at()                      from public, anon, authenticated, service_role;
revoke execute on function public.stamp_organization_approval_metadata() from public, anon, authenticated, service_role;

-- The Phase 5 migration revoked INSERT/UPDATE/DELETE on organization_memberships from
-- authenticated (invitations must go through the audited, consent-based RPCs), which left
-- four write policies with no grant behind them. They are inert today, but re-adding a
-- write grant later would silently re-open a path that bypasses invitation consent and the
-- membership audit trail. Drop them so the intent is explicit; membership writes happen
-- only inside SECURITY DEFINER RPCs, which do not consult these policies.
drop policy if exists memberships_insert_any_company_role_super_admin on public.organization_memberships;
drop policy if exists memberships_insert_booker_by_admin on public.organization_memberships;
drop policy if exists memberships_update_super_admin_only on public.organization_memberships;
drop policy if exists memberships_delete_admin_or_super on public.organization_memberships;
