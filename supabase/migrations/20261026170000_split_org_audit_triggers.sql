-- ==========================================================================
-- Gulf Mover — Phase 1 — split organisation audit trigger (idempotency fix)
-- STATUS: DRAFT — approved for local development by the user (2026-10-26),
--         NOT APPLIED. Nothing in this file has executed.
--
-- BUG FIXED (Stage-C seed idempotency test, 2026-10-26):
--   Running seed_demo.sql twice logged a duplicate Jannah (Demo) `submitted`
--   approval event (id b758ee4c-769b-4f23-b440-0f8b58f96a8f) even though the
--   seed's organisation INSERT is `on conflict (id) do nothing` and the rerun
--   reported INSERT 0 0. Root cause, by PostgreSQL definition: row-level
--   BEFORE INSERT triggers fire even for rows that ON CONFLICT DO NOTHING
--   later skips; row-level AFTER triggers fire only for rows actually
--   inserted. trg_organizations_audit was BEFORE INSERT OR UPDATE, so every
--   no-op re-seed of a pending organisation logged a phantom `submitted`
--   event through the SECURITY DEFINER path.
--
-- FIX (smallest robust correction):
--   Split the one trigger/function into its two distinct responsibilities:
--   * trg_organizations_audit_events    AFTER INSERT OR UPDATE — event
--     logging, unchanged mapping/reasons/snapshots/actor attribution. AFTER
--     triggers never fire for conflict-skipped rows, so the bug class is
--     structurally impossible.
--   * trg_organizations_audit_stamp     BEFORE UPDATE — approval metadata
--     stamping. Must stay BEFORE because only a BEFORE trigger can write
--     NEW into the stored row. The INSERT leg is deliberately dropped:
--     fresh INSERTs have never stamped approved_by/approved_at (the draft
--     seed supplies Company A's metadata explicitly).
--
-- ORDERING: the old trigger is DROPPED FIRST, before any function body is
--   replaced, so no intermediate state exists in which a BEFORE trigger
--   calls an AFTER-style function. In practice the Supabase migration
--   runner wraps each migration in its own transaction (in-file
--   begin/commit is deliberately NOT used), making the whole file atomic;
--   drop-first keeps the file safe even against a runner change.
--
-- Preserved exactly, per review:
--   - event decisions: insert-pending -> 'submitted' (actor new.created_by);
--     updates -> 'pending'->'submitted' with reason 'Returned to pending
--     from <old status>', 'suspended'->'approved'->'reinstated', else the
--     new status word — pending ATCO confirmation (A16–A19)
--   - before/after {status:...} snapshots and auth.uid() actor attribution
--   - SECURITY DEFINER + set search_path = '' on both functions
--   - existing function permissions (create or replace preserves ACLs; the
--     new stamp function is trigger-invoked only)
--   - column comments and the approval_events table comment keep referring
--     to log_organization_status_changes(), whose name is retained.
--
-- TIMESTAMP NOTE: 20261026170000 is deliberately LATER than the last applied
--   migration version, 20261026162000 (which was itself forward-dated past
--   the wall clock when it was created). The wall clock read 2026-10-26
--   15:58 UTC at authoring time, so this filename is future-dated to keep
--   lexicographic == chronological migration ordering, matching the
--   convention already set by 20261026162000.
--
-- NOT IN THIS MIGRATION (separately approved step): deleting the confirmed
--   duplicate event b758ee4c-769b-4f23-b440-0f8b58f96a8f. That single-row
--   cleanup requires explicit user approval AFTER this file is applied.
--
-- The two applied schema migrations are NOT edited. This builds on them.
-- ==========================================================================

-- 0) Drop the old combined trigger FIRST: no state can exist in which a
--    BEFORE INSERT trigger would call the new AFTER-style logging function.
drop trigger if exists trg_organizations_audit on public.organizations;

-- 1) Approval-metadata stamping — BEFORE UPDATE only (stamping needs NEW).
create or replace function public.stamp_organization_approval_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'approved'
     and new.status is distinct from old.status then
    -- A18 semantics (provisional, NOT ATCO-confirmed): approved_by/approved_at
    -- are the most recent SUCCESSFUL approval — stamped only when status
    -- transitions INTO 'approved' (including reinstatement from suspended),
    -- never overwritten by rejection, suspension or return to pending.
    new.approved_by := (select auth.uid());
    new.approved_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_organizations_audit_stamp
  before update on public.organizations
  for each row execute function public.stamp_organization_approval_metadata();

-- 2) Event logging — unchanged logic, now AFTER INSERT or UPDATE so that
--    rows skipped by ON CONFLICT DO NOTHING produce no event.
create or replace function public.log_organization_status_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    -- A10 (provisional): a 'submitted' event records a real submission; an
    -- organisation inserted already approved invents no submission.
    insert into public.approval_events
      (subject_type, subject_id, decision, reason, actor_user_id)
    values
      ('organization', new.id, 'submitted', null, new.created_by);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- A16/A17 provisional mapping (not ATCO-confirmed): return-to-pending is
    -- audited as 'submitted' (resubmission), suspended->approved as
    -- 'reinstated', every other transition keeps its own decision word —
    -- 'pending' still never enters the decision vocabulary.
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
  end if;
  return null;  -- AFTER trigger: return value ignored
end;
$$;

create trigger trg_organizations_audit_events
  after insert or update on public.organizations
  for each row execute function public.log_organization_status_changes();

comment on trigger trg_organizations_audit_events on public.organizations is
  'AFTER row trigger (split from the original BEFORE INSERT OR UPDATE by migration
  20261026170000): PostgreSQL fires AFTER row triggers only for rows actually
  inserted, so rows skipped by ON CONFLICT DO NOTHING — the cause of the Stage-C
  seed duplicate `submitted` event — can never log an event. Event mapping,
  reasons, snapshots and actor attribution are unchanged from migration 0001
  (provisional: A10/A16/A17, NOT confirmed by ATCO). Metadata stamping lives in
  trg_organizations_audit_stamp (BEFORE UPDATE).';

comment on trigger trg_organizations_audit_stamp on public.organizations is
  'BEFORE UPDATE trigger (split from the original BEFORE INSERT OR UPDATE by
  migration 20261026170000): stamps approved_by/approved_at only when an UPDATE
  transitions INTO approved (A18, provisional). Kept BEFORE because only a
  BEFORE trigger can write NEW into the stored row. Event logging lives in
  trg_organizations_audit_events (AFTER).';
