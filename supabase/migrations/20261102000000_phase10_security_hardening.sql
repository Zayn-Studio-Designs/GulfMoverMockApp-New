-- Phase 10 security hardening: close the client-execution gap on the
-- internal terms-lookup helper.
--
-- `public._reserve_booking_terms(boolean, text)` is an internal building
-- block called only by the `SECURITY DEFINER` booking engine (which runs as
-- the owner, so this revoke does not change booking behaviour). Phase 7
-- revoked it from `public, anon, service_role` but not from `authenticated`,
-- unlike every other `public._*` helper, leaving it directly callable via
-- PostgREST. It is read-only and discloses only the current provisional
-- terms version (otherwise readable via service policies), so severity is
-- low — but least privilege requires closing it.
--
-- Forward-only: earlier migrations are untouched.

revoke all on function public._reserve_booking_terms(boolean, text) from authenticated;

-- Same treatment for the two remaining `_*` helpers that never received an
-- explicit grant statement (and therefore keep the PostgreSQL default of
-- executable-by-PUBLIC). Both are pure/immutable with no data access, so
-- severity is negligible, but the `_`-internal convention is deny-by-default:
--   * `public._riyadh_date(timestamptz)` is used only inside SECURITY DEFINER
--     report functions (owner context is unaffected by this revoke).
--   * `public._zatca_initial_pih()` is used only by the fully-revoked
--     `public._last_document_hash()` helper.
revoke all on function public._riyadh_date(timestamptz) from public, anon, authenticated;
revoke all on function public._zatca_initial_pih() from public, anon, authenticated;
