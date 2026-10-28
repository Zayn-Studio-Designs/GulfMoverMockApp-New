# Security RPC matrix (verified 2026-10-28)

Source of truth: `supabase/migrations/*.sql` at `feature/phase10-launch-hardening`
(28th migration: `20261102000000_phase10_security_hardening.sql`).
Hosted exposure cross-checked against the Supabase security advisor for
`GulfMover-Demo` (2 INFO + 1 anon WARN + ~110 authenticated WARNs, all generic
“can execute SECURITY DEFINER” lints with no per-function authorization
analysis).

Grant convention used throughout the codebase (verified by grep):
`revoke … from public, anon, service_role` (or all four incl. `authenticated`
for internals) followed by a narrow `grant execute … to authenticated` and/or
`service_role`. TheAdvisor WARNs are therefore expected noise for guarded
functions — this matrix records the *intended* grant and the *in-function*
authorization for each one. Principle enforced in review: `to authenticated`
is never treated as authorization; every mutating RPC re-checks identity
(`auth.uid()`), platform roles (`has_platform_role`), org roles
(`has_org_role`/`lock_company_admin`), or ownership inside the body.
Caller-supplied user IDs are never trusted as identity.

## A. Anon-reachable (1 function — intentional, tested)

| Function | Grantees | Why it stays public | Evidence |
|---|---|---|---|
| `health_ping()` | anon, authenticated, service_role | Static liveness probe: `status ok`, `db_time`, schema version. No parameters, no PII, no mutation. | `20261101100005…:470-476`; asserted as the *only* anon-callable function by `src/tests/db/phase8.operations.db.test.ts:258,268` |

## B. Service-role only (server/edge-function surface, never browsers)

`_apply_payment_result`, `apply_payment_result`, `attach_provider_checkout`,
`apply_refund_result`, `claim_outbox_batch`, `complete_outbox_delivery`,
`record_message_status`. All revoked from public/anon/authenticated; granted
to `service_role` only. Used by the payments webhook handler and the
`notifications-dispatch` edge function. A browser caller gets 403; there is
no client-side path to forge provider results. (Verified: no `src/` caller
invokes these except through the edge-function URL with the webhook secret.)

## C. Internal helpers — no client execution (fully revoked)

Every `public._*` helper (pricing, terms lookup, refund plumbing, invoice/
credit-note issuance, credit position, hold expiry engine, trigger guards,
`_valid_reason`, `_require_staff`, `_riyadh_date`, `_zatca_initial_pih`,
`_reserve_booking*`) is now revoked from public/anon/authenticated (and from
`service_role` except where the server itself needs it). Phase 10 closed the
last three gaps (`_reserve_booking_terms`, `_riyadh_date`,
`_zatca_initial_pih`) in `20261102000000_phase10_security_hardening.sql`.
Enforced by `src/tests/securityGrants.test.ts` (parses all migrations;
fails if any `_*` helper is client-reachable). Internal SQL calls from
`SECURITY DEFINER` functions run as owner and are unaffected.

## D. Authenticated client RPCs with in-function authorization

All revoked from public/anon; granted to `authenticated` (plus `service_role`
where noted). Identity always derives from `auth.uid()`.

**Booking & tickets (ownership or company-admin scoped)**

| Function | Authorization |
|---|---|
| `register_company` | Any signed-in user may register *one* company; identity = `auth.uid()`; idempotent replay key; suspended users rejected (`20261026180000…:98+`) |
| `create_organization_booking`, `create_agent_booking`, `create_individual_booking` | Approved-company membership (`company_admin`/`company_booker`) or eligible individual; capacity checked in-transaction; idempotency key prevents duplicates |
| `amend_booking`, `cancel_booking`, `reschedule_booking_leg` | Creator or company_admin of the booking org; state-transition guards (e.g. only unpaid bookings amendable) |
| `begin_checkout`, `sandbox_simulate_payment`, `initiate_payment` | Booking creator or company_admin; server prices the payment — the browser never submits amounts |
| `verify_payment` | Staff-only (`super_admin,operations,finance`) — sandbox verification path, not a client success callback |
| `request_refund` | Staff-only (`super_admin,finance`); customer-initiated refund UX is intentionally absent (see ATCO decisions) |
| `get_ticket_qr`, `ticket_manifest` | Booking creator (`created_by = auth.uid()`); company admins do *not* get other members' QR secrets |
| `board_ticket`, `set_sailing_readiness`, `revoke_ticket` | Staff roles (`super_admin,operations[,boarding_staff]`); boarding additionally evaluates the sailing gate server-side |
| `sailing_boarding_gate`, `sailing_commercial_status`, `sailing_minimum_status` | Read-only; gate/commercial state computed server-side, never trusted from the client |

**Company memberships & invitations**

`invite_company_member`, `cancel_company_invitation`, `accept_company_invitation`,
`revoke_company_member`, `list_company_members`, `my_invitation_email`:
inviter must hold `company_admin` (`lock_company_admin`); acceptance requires
the signed-in user's email to match the invitation; ATCO-admin promotion is
impossible (roles come from `role_assignments`, never caller input).

**Materials, charters, delivery**

`submit_transfer_request`, `review_transfer_request`, `cancel_transfer_request`,
`quote_material_request`, `approve_material_quote`, `assign_material_to_sailing`,
`record_delivery`, `record_safety_review`, `allocate_charter`: requester must be
an active member of an approved org; all approvals/recordings require
`super_admin,operations[,finance]`; restricted materials are never
auto-approved (kind/status allowlist in the function body).

**Tariffs, policies, settings, schedule**

`publish_tariff`, `approve_tariff`, `retire_tariff`, `quote_passenger_fare`,
`applicable_tariff`, `publish_policy`, `set_policy_status`,
`update_platform_setting`, `upsert_schedule_template`, `generate_sailings`,
`expire_stale_holds`: staff-only with role separation (finance for tariffs,
operations for sailings/schedule; `approve_commission_rule` additionally
enforces four-eyes: proposer ≠ approver). `expire_stale_holds` also accepts
`service_role` (cron) — same guard. Read helpers (`applicable_tariff`,
`quote_passenger_fare`, `setting_int/text/bool`, `zatca_tlv`,
`zatca_qr_tlv`, `vat_breakdown`) are pure/read-only.

**Credit, settlements, finance**

`set_organization_account_type`, `set_organization_credit`, `set_credit_status`,
`organization_credit_position`, `generate_settlement`, `decide_settlement`,
`adjust_settlement`, `propose_commission_rule`, `decide_refund`,
`refund_payment`, `record_account_payment`, `report_*` (occupancy, revenue,
reconciliation, outstanding): staff-only (`super_admin,finance` except
`organization_credit_position`, which additionally allows the owning org's
admin to view its own position). Users can never change their own limits:
every writer checks `has_platform_role`, never org membership.

**Privacy, retention, diagnostics**

`submit_privacy_request`, `export_my_data` (self-scoped via `auth.uid()`),
`decide_privacy_request`, `set_legal_hold`, `set_retention_policy`,
`apply_retention` (all `super_admin`, retention dry-run allowed same role),
`my_security_posture` (self), `system_diagnostics`
(`super_admin,it_support`), `notification_delivery_issues`,
`set_notification_preference/channel`, `mark_notification_read` (self-scoped),
`has_platform_role`, `has_org_role`, `active_org_ids` (caller's own roles only).

## E. RLS-without-policy tables (intentional deny-by-default)

`document_counters`, `notification_outbox`: RLS enabled, zero policies, no
grants to client roles. Only `SECURITY DEFINER` server functions (invoice
numbering, outbox enqueue/claim) touch them. The 2 INFO lints describe the
intended posture; no change.

## F. Residual advisor noise (acknowledged, no action)

- ~110 `authenticated_security_definer_function_executable` WARNs = the
  category-D functions above. Each has an in-body guard; revoking `authenticated`
  would break booking, operations, and reporting. Re-check on every migration
  via the grants test + this matrix.
- RLS performance WARNs (`auth.uid()` re-evaluated per row) and
  multiple-permissive-policy notes on `tariffs`/`service_policies`/
  `material_tariffs`: read paths are small reference tables; the permissive
  policies are complementary (public read + staff write), not overlapping
  grants. No index/policy churn without measured production load.
- Leaked-password protection is OFF on hosted (default). Action for the
  production project owner: Auth → Providers → Email → enable
  “Leaked password protection”. Cannot be verified from read-only access;
  not claimed as done.
