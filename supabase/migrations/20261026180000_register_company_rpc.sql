-- ===========================================================================
-- register_company RPC — first-company-admin provisioning (backend/phase1)
-- ===========================================================================
-- FILENAME: 20261026180000_register_company_rpc.sql
--
-- Ordering: the timestamp 20261026180000 sorts strictly AFTER every existing
-- applied migration (latest applied head is 20261026170000_split_org_audit_
-- triggers). Supabase CLI applies migrations in lexicographic filename order,
-- so this file runs last and its history row records 20261026180000.
--
-- TRANSACTION: no explicit BEGIN/COMMIT; the Supabase local migration runner
-- wraps every migration in one transaction by default. All statements below
-- therefore commit atomically: there is no window where the function exists
-- with PUBLIC execute before the revoked grants, or where the columns exist
-- before the paired-nullability constraint.
--
-- ASSUMPTIONS (documented, verified read-only against the local stack):
-- 1. Function ownership: the migration runner creates functions as the local
--    postgres role (same owner as the existing SECURITY DEFINER helpers),
--    which owns public.organizations and public.approval_events. The definer
--    RPC therefore holds owner privileges: it may insert into organizations
--    regardless of RLS, and the audit trigger (SECURITY DEFINER, postgres,
--    search_path='') can insert its approval event.
-- 2. Trigger execution inside the RPC: trg_organizations_guard_creator is a
--    SECURITY INVOKER trigger function that only compares new.created_by to
--    auth.uid(); inside the definer RPC it runs with the RPC's current role
--    (postgres) but auth.uid() still resolves from the caller's JWT, so the
--    creator invariant is enforced, not bypassed. trg_organizations_audit_
--    stamp is BEFORE UPDATE only (inert on INSERT); trg_organizations_audit_
--    events is AFTER INSERT OR UPDATE and produces exactly one 'submitted'
--    event per winning organisation INSERT.
-- 3. RLS bypass: only via definer/owner semantics, unchanged from the
--    existing helpers; no policy is added or weakened. The only policy
--    removed is organizations_insert_pending_only, because direct
--    authenticated INSERT is revoked below.
-- 4. auth.uid() is the sole identity source; no caller-supplied user id,
--    role, status or approval field exists in the signature.
--
-- PROVISIONAL INPUT LENGTH CAPS — REQUIRE EXPLICIT ACCEPTANCE.
-- The current schema (text columns, no length constraints) and the frontend
-- impose none of these caps; they are server-side choices awaiting ATCO
-- sign-off: legal_name 200 · profile_display_name 80 · display_name 200 ·
-- registration_number 64 · billing_contact 200. Email and phone carry no
-- length cap beyond their pattern (phone's pattern bounds it to 20).
--
-- PROVISIONAL BUSINESS RULES (pending ATCO confirmation):
-- - One user may register more than one company (keyed by attempt, not user).
-- - billing_contact is a free-text remark, not an email address.
-- - A suspended profile may not call this RPC at all (first registration or
--   replay). Enforced via SELECT ... FOR SHARE: a suspension committed or
--   in-flight before the RPC's profile read is never missed; a registration
--   that commits before a later suspension becomes visible is a legitimate
--   historical state and is not retroactively denied.
-- - A replayed key with a different payload is a hard RPC error
--   ('payload_mismatch'), never a silent success or a new registration.
-- ===========================================================================

alter table public.organizations
  add column registration_key uuid null;

alter table public.organizations
  add column registration_payload_hash text null;

comment on column public.organizations.registration_key is
  'Client-generated UUID distinguishing one registration attempt. Written only by
  register_company() (authenticated RPC). NULL for pre-existing rows; uniqueness
  is enforced by organizations_registration_key_uidx (partial).';

comment on column public.organizations.registration_payload_hash is
  'SHA-256 hex (extensions.digest) of the canonical normalised JSONB of all nine
  RPC inputs (key, legal_name, profile_display_name, display_name,
  registration_number, billing_contact, contact_email lowercased,
  contact_phone, language). Compared with IS DISTINCT FROM on replay to reject
  payload_mismatch. Only the digest is stored — the full payload is not.';

-- Paired nullability: a key row always carries its fingerprint and vice versa.
-- Existing seeded rows are NULL/NULL and satisfy this constraint unchanged.
alter table public.organizations
  add constraint organizations_registration_key_hash_paired
  check ((registration_key is null) = (registration_payload_hash is null));

-- Partial unique index: the RPC's arbiter is
--   on conflict (registration_key) where registration_key is not null
-- whose predicate matches this index's predicate exactly.
create unique index organizations_registration_key_uidx
  on public.organizations (registration_key)
  where registration_key is not null;

-- ---------------------------------------------------------------------------
-- register_company(...)
-- ---------------------------------------------------------------------------
-- PostgREST RPC. Executable by authenticated only (see grants below).
-- Returns id/legal_name/status of the organisation plus outcome = 'created'
-- on the winning insert or 'replayed' when the same key resolves to the
-- existing organisation. Any error aborts the whole call: organisation,
-- profile writes, membership and the fired 'submitted' audit event roll back
-- together (one transaction).
create or replace function public.register_company(
  p_registration_key      uuid,                  -- required; one attempt
  p_legal_name            text,                  -- required; organizations.legal_name
  p_profile_display_name  text,                  -- REQUIRED ON EVERY CALL (even when an
                          -- existing profile will not be updated); feeds
                          -- profiles.display_name only when the profile is
                          -- missing, and the fingerprint always.
  p_display_name          text default null,     -- organizations.display_name (company field)
  p_registration_number   text default null,     -- organizations.registration_number
  p_billing_contact       text default null,     -- organizations.billing_contact (free text)
  p_contact_email         text default null,     -- organizations.contact_email
  p_contact_phone         text default null,     -- organizations.contact_phone
  p_language              text default 'en'      -- profiles.preferred_language ONLY when the
                                                 -- profile is missing ('en' | 'ar')
)
returns table (id uuid, legal_name text, status text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid;      -- auth.uid(); sole identity source
  n_key            uuid;
  n_legal          text;
  n_profile_nm     text;
  n_disp           text;
  n_regnum         text;
  n_billing        text;
  n_email          text;
  n_phone          text;
  n_lang           text;
  v_payload        jsonb;     -- canonical normalised payload (null = real absence)
  v_hash           text;
  v_rec            record;
  v_profile_status text;      -- scalar; profiles.status ('active' | 'suspended')
begin
  -- -------------------------------------------------------------------------
  -- 1. Identity + input validation (runs on every call, before any write).
  --    Normalisation happens exactly once, here; the normalised variables are
  --    reused for both the fingerprint and the actual inserts, so the stored
  --    hash and the recomputed hash can never drift.
  -- -------------------------------------------------------------------------
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  if p_registration_key is null then
    raise exception 'invalid registration key'
      using errcode = '22023';
  end if;
  n_key := p_registration_key;

  -- Normalised inputs: trimming; blank string == absent (null); email lowercased.
  n_legal      := nullif(btrim(p_legal_name), '');
  n_profile_nm := nullif(btrim(p_profile_display_name), '');
  n_disp       := nullif(btrim(p_display_name), '');
  n_regnum     := nullif(btrim(p_registration_number), '');
  n_billing    := nullif(btrim(p_billing_contact), '');
  n_email      := nullif(lower(btrim(p_contact_email)), '');
  n_phone      := nullif(btrim(p_contact_phone), '');
  n_lang       := nullif(btrim(p_language), '');

  -- p_profile_display_name contract: required on EVERY call, validated
  -- unconditionally and before any organisation insert.
  if n_profile_nm is null or length(n_profile_nm) > 80 then
    raise exception 'invalid profile display name (required, <= 80 chars)'
      using errcode = '22023';
  end if;

  -- PROVISIONAL length caps (see file header) — explicit acceptance required.
  if n_legal is null or length(n_legal) > 200 then
    raise exception 'invalid legal name (required, <= 200 chars)'
      using errcode = '22023';
  end if;
  if n_disp is not null and length(n_disp) > 200 then
    raise exception 'invalid display name (<= 200 chars)'
      using errcode = '22023';
  end if;
  if n_regnum is not null and length(n_regnum) > 64 then
    raise exception 'invalid registration number (<= 64 chars)'
      using errcode = '22023';
  end if;
  if n_billing is not null and length(n_billing) > 200 then
    raise exception 'invalid billing contact (<= 200 chars)'
      using errcode = '22023';
  end if;
  if n_email is not null and n_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid contact email'
      using errcode = '22023';
  end if;
  if n_phone is not null and n_phone !~ '^\+?[0-9 ()-]{7,20}$' then
    raise exception 'invalid contact phone'
      using errcode = '22023';
  end if;
  if n_lang is null or n_lang not in ('en', 'ar') then
    raise exception 'invalid language (en or ar)'
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Canonical fingerprint: SHA-256 over the canonical JSONB of all nine
  --    normalised inputs. jsonb_build_object always emits all keys (absent
  --    values are JSON null, preserved distinctly from real values), and the
  --    text serialisation of jsonb is deterministic for identical inputs.
  --    NOTE: extensions.digest — pgcrypto's digest lives in the 'extensions'
  --    schema, and search_path is '', so a bare digest() would not resolve.
  -- -------------------------------------------------------------------------
  v_payload := jsonb_build_object(
    'key',                  n_key,
    'legal_name',           n_legal,
    'profile_display_name', n_profile_nm,
    'display_name',         n_disp,
    'registration_number',  n_regnum,
    'billing_contact',      n_billing,
    'contact_email',        n_email,
    'contact_phone',        n_phone,
    'language',             n_lang);
  v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

  -- -------------------------------------------------------------------------
  -- 3. Suspended-profile guard — BEFORE any organisation write and before any
  --    replay return. SELECT ... FOR SHARE under READ COMMITTED: if a
  --    suspension is committed or in-flight before this read, the read waits,
  --    re-reads the committed version and sees 'suspended' — never missed.
  --    A registration that commits before a later suspension becomes visible
  --    is a legitimate historical state (documented policy boundary).
  --    PROVISIONAL RULE, pending ATCO confirmation.
  -- -------------------------------------------------------------------------
  select p.status
    into v_profile_status
    from public.profiles as p
   where p.id = v_uid
     for share;

  if found and v_profile_status = 'suspended' then
    raise exception 'profile_suspended: suspended accounts may not register a company'
      using errcode = '28000';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Atomic winning INSERT. Arbiter: the partial unique index
  --    organizations_registration_key_uidx, matched by explicit predicate.
  --    The insert carries 'pending' (server-forced) and created_by = auth.uid().
  --    Returning columns are fully table-aliased (o.) — the RETURNS TABLE
  --    output parameters (id, legal_name, status, outcome) would otherwise
  --    shadow unqualified column references.
  -- -------------------------------------------------------------------------
  insert into public.organizations as o
    (legal_name, display_name, registration_number, billing_contact,
     contact_email, contact_phone, registration_key, registration_payload_hash,
     status, created_by)
  values (n_legal, n_disp, n_regnum, n_billing, n_email, n_phone,
          n_key, v_hash, 'pending', v_uid)
  on conflict (registration_key) where registration_key is not null
    do nothing
  returning o.id, o.legal_name, o.status into v_rec;

  if found then
    -- ---------------------------------------------------------------------
    -- 5. NEW-REGISTRATION branch: profile + membership in the same
    --    transaction. Profile insert is concurrent-safe; an existing profile
    --    row (including its phone or preferred_language) is never modified.
    --    The membership insert has NO ON CONFLICT: any conflict or failure
    --    raises and rolls back the organisation insert and its audit event.
    -- ---------------------------------------------------------------------
    insert into public.profiles
      (id, display_name, phone, preferred_language, status)
    values
      (v_uid, n_profile_nm, null, n_lang, 'active')
    on conflict (id) do nothing;

    insert into public.organization_memberships
      (organization_id, user_id, membership_role, status, invited_by)
    values
      (v_rec.id, v_uid, 'company_admin', 'active', null);

    return query select v_rec.id, v_rec.legal_name, v_rec.status, 'created'::text;
    return;  -- explicit RETURN: RETURN QUERY does not terminate a PL/pgSQL function

  else
    -- ---------------------------------------------------------------------
    -- 6. REPLAY branch: re-read the committed winner (visible: the conflicting
    --    transaction committed first), verify ownership and full payload by
    --    hash, and return — zero writes, no membership re-insert, no audit
    --    event. The suspended-profile guard in step 3 already covered replays.
    -- ---------------------------------------------------------------------
    select ro.id, ro.legal_name, ro.status,
           ro.registration_payload_hash, ro.created_by
      into v_rec
      from public.organizations as ro
     where ro.registration_key = n_key;

    if v_rec.id is null then
      -- Defensive: the lost-race commit should always be visible; if it is
      -- not, fail clearly and retryably rather than proceeding.
      raise exception 'registration attempt lost during conflict — retry'
        using errcode = '40001', detail = 'retryable_conflict';
    end if;

    if v_rec.created_by <> v_uid then
      raise exception 'registration key belongs to another user'
        using errcode = '42501';
    end if;

    if v_rec.registration_payload_hash is distinct from v_hash then
      raise exception 'payload_mismatch: payload differs from the original registration for this key'
        using errcode = '22023';
    end if;

    return query select v_rec.id, v_rec.legal_name, v_rec.status, 'replayed'::text;
    return;  -- explicit RETURN: control cannot fall through into any write
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: authenticated-only EXECUTE, no service_role grant
-- (no concrete requirement established). Executed in the same migration
-- transaction as the CREATE, so no PUBLIC-executable window exists.
-- ---------------------------------------------------------------------------
revoke execute on function public.register_company(
  uuid, text, text, text, text, text, text, text, text) from public;
revoke execute on function public.register_company(
  uuid, text, text, text, text, text, text, text, text) from anon;
grant execute on function public.register_company(
  uuid, text, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Close the direct company-creation door: register_company() is now the only
-- path for application users to create organisations. This removes the
-- orphan vector (a user creating an organisation they can never join).
-- Owner/service-role capabilities unchanged; RLS and all other policies
-- untouched.
-- ---------------------------------------------------------------------------
revoke insert on public.organizations from authenticated;
drop policy organizations_insert_pending_only on public.organizations;

-- ---------------------------------------------------------------------------
-- Table comment: reflect the new creation path (direct INSERT no longer
-- available to application roles).
-- ---------------------------------------------------------------------------
comment on table public.organizations is
  'Corporate customer organizations. Application users create organisations ONLY
  through register_company() (authenticated RPC; created_by is auth.uid(),
  status starts pending, one company_admin membership is provisioned
  atomically). Direct INSERT for authenticated was removed 2026-10-26. Lifecycle
  changes remain super_admin only. Return to pending is provisionally audited as
  a fresh submitted event; suspended-to-approved is provisionally a reinstated
  event (A16/A17, not ATCO-confirmed). Provisional rules in register_company
  (multi-company per user, suspended-profile denial, provisional length caps)
  are pending ATCO confirmation.';
