-- ==========================================================================
-- Gulf Mover — Phase 1 (Module 1) — active_org_ids() visibility correction
-- File: 20261026162000_active_org_ids_visibility.sql
--
-- STATUS: **DRAFT, NOT APPLIED.** Written 2026-10-26 for review; apply only
--         after approval, via `supabase migration up --local`.
--
-- WHY THIS EXISTS (static finding, 2026-10-26 — no behaviour was executed):
--   The deployed `active_org_ids()` (created by 20261026144001) keeps an
--   organisation inside the helper's output whenever *any active
--   company_admin membership exists in it* — regardless of the
--   organisation's status. Because virtually every functioning company has
--   an admin member, that second arm functionally bypasses the status
--   filter: members could still read organisations (their memberships and
--   the organisation's audit events too) while those organisations were
--   **rejected or suspended**. It also reads as *not caller-specific*,
--   contradicting the function's own design comment, AND it is too narrow
--   the other way: the submitter of a `pending` company with no admin
--   member (seeded Company B) could not see their own organisation at all.
--
-- APPROVED PROVISIONAL RULE (development assumption, NOT confirmed by ATCO):
--   * Members can see APPROVED organisations they belong to (active
--     membership).
--   * Members can see THEIR OWN pending organisation (their active
--     membership makes it "their own" — no admin-exists escape hatch).
--   * REJECTED and SUSPENDED organisations are hidden from company members.
--   * ATCO staff (super_admin/operations) keep their authorised access
--     unchanged — they are governed by their own platform-role policy
--     arms, not by this helper.
--   This supersedes the in-code comment of the 0002 draft ("within an
--   approved org, or the org is your own pending one"), whose previous
--   implementation approximated the second case with an admin-exists
--   subquery instead of caller scoping. Recorded as review-doc assumption
--   A20 with its own regression tests (T2b–T2e).
--
-- WHAT THIS FILE DOES INTENTIONALLY:
--   *One* statement: `create or replace function public.active_org_ids()`
--   with the same signature and attributes as deployed —
--   `returns setof uuid / language sql / stable / security definer /
--   set search_path = ''` — so every existing call site
--   (organizations_select_staff_or_members line 158,
--   memberships_select_relevant line 188,
--   approval_events_select_relevant line 254) keeps working with the
--   corrected row set, and the existing EXECUTE grants
--   (anon revoked, authenticated granted) are untouched because
--   CREATE OR REPLACE preserves function ACLs. No grant, policy, table or
--   ownership is touched; the two already-applied migrations are NOT edited
--   (this builds on them in migration order).
--
-- NOTE: organisations that transition back to `pending` (return-to-pending)
--   likewise become visible again to their active members under this rule —
--   the status check is unconditional on history.
-- ==========================================================================

create or replace function public.active_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_memberships m
  where m.user_id = (select auth.uid())      -- caller-scoped: YOUR active memberships
    and m.status = 'active'
    and exists (
      select 1 from public.organizations o
      where o.id = m.organization_id
        -- Provisional visibility: approved while usable; pending while
        -- awaiting ATCO (it is "your own" because you hold the active
        -- membership above); rejected/suspended are hidden from company
        -- members. ATCO staff access is separate (platform-role policy
        -- arms) and unchanged by this helper. NOT yet confirmed by ATCO
        -- (development assumption, phase1-review A20, tests T2b–T2e).
        and o.status in ('approved', 'pending')
    );
$$;
