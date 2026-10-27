-- ---------------------------------------------------------------------------
-- 20261026190000 — Corrective grant hygiene for register_company()
--
-- Context: the local Supabase stack carries default privileges
-- (pg_default_acl for role postgres in schema public) that grant EXECUTE on
-- every newly created function to anon, authenticated AND service_role.
-- When migration 20261026180000 created register_company(), those defaults
-- materialised as role-specific ACL entries. The migration's
-- `REVOKE EXECUTE ... FROM public` could not remove them (a revoke from the
-- PUBLIC pseudo-role does not touch role-specific entries), and only the
-- anon entry was explicitly revoked — leaving an unintended service_role
-- EXECUTE grant.
--
-- This corrective migration restores the documented contract: EXECUTE on
-- register_company belongs to `authenticated` only. This is consistency, not
-- a new security boundary — service_role already holds direct INSERT on
-- organizations and bypasses RLS — but the approved design states no
-- service_role grant exists, so the ACL must match it exactly.
--
-- Approved as ROUTE A (append-only; the applied migration 20261026180000 is
-- not modified). Verified 2026-10-26 against local Supabase (PG 17.11).
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.register_company(
  uuid, text, text, text, text, text, text, text, text)
FROM service_role;
