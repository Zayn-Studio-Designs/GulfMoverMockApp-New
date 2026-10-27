-- ===========================================================================
-- 20261026191000 — Corrective fix: register_company profiles-INSERT ambiguity
-- ===========================================================================
-- DEFECT FOUND BY TEST T1 (Phase B behaviour suite, 2026-10-26):
-- 20261026180000's RETURN TABLE output variable "id" collides with the bare
-- "id" in the profiles INSERT's ON CONFLICT (id) arbiter. PL/pgSQL rejects
-- the ambiguity at statement planning ("column reference \"id\" is
-- ambiguous"), so EVERY new registration fails and rolls back entirely.
--
-- FIX (single statement change, verified 1:1 against the applied function):
--   on conflict (id) do nothing   ->   on conflict do nothing
-- Targetless inference still arbitrates on profiles_pkey — "id" is the only
-- inserted column, so the PK arbiter is the only possible conflict and the
-- semantics are unchanged.
--
-- ROUTE A (append-only): the applied migration 20261026180000 is NOT edited.
-- CREATE OR REPLACE preserves the function's owner, language, SECURITY
-- DEFINER, SET search_path = '' and its EXECUTE ACLs (authenticated-only,
-- service_role revoked in 20261026190000). Grants are re-verified read-only
-- after apply.
-- ===========================================================================

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
    on conflict do nothing;

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
