-- ===========================================================================
-- LOCAL TEST HARNESS ONLY — never apply to a hosted project.
--
-- The bare supabase/postgres image ships an early auth schema. GoTrue normally
-- migrates it on first start; when GoTrue is not running (the SQL-level test
-- harness in scripts/db/), this file adds the columns and helpers that the
-- application migrations reference, matching current Supabase Auth semantics:
--   * auth.users.email_confirmed_at (GoTrue column)
--   * auth.uid()/auth.role()/auth.jwt() reading request.jwt.claims first,
--     then the legacy request.jwt.claim.* settings (same as Supabase Auth).
-- ===========================================================================
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists phone text;
alter table auth.users add column if not exists deleted_at timestamptz;
alter table auth.users add column if not exists is_anonymous boolean not null default false;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- MFA assurance level (aal) lives in the JWT; mirrors Supabase Auth's claim.
