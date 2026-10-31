-- =============================================================================
-- Performance (production-readiness audit, area 10).
--
-- 1. Every foreign key gets a supporting index (Supabase performance-advisor rule
--    "unindexed foreign keys"). The load test found the booking page's history
--    query (booking_events by booking) averaging ~186 ms per call at 1,000 users
--    because booking_events had no index on booking_id; the same gap existed for
--    credit notes, refunds, invoices by organisation (credit checks), request
--    history/attachments, and every audit column (slow user erasure).
-- 2. Four row-level-security policies called auth.uid() per row; wrapping it in
--    (select auth.uid()) lets Postgres evaluate it once per query (Supabase advisor
--    "auth_rls_initplan"). Same meaning, same results.
--
-- On a large production table, prefer CREATE INDEX CONCURRENTLY run outside a
-- transaction during a quiet period; at launch-size data these are instant.
-- =============================================================================

alter policy tickets_owner on public.tickets using (
  exists (select 1 from public.bookings b where b.id = tickets.booking_id and b.created_by = (select auth.uid()))
  and not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'suspended'));
alter policy notification_owner on public.notifications using (user_id = (select auth.uid()));
alter policy notification_preferences_own on public.notification_preferences using (user_id = (select auth.uid()));
alter policy privacy_requests_select on public.privacy_requests using (user_id = (select auth.uid()) or public.has_platform_role('{super_admin}'));

create index if not exists agent_commission_rules_agent_organization_id_fkey_idx on public.agent_commission_rules (agent_organization_id);
create index if not exists agent_commission_rules_approved_by_fkey_idx on public.agent_commission_rules (approved_by);
create index if not exists agent_commission_rules_created_by_fkey_idx on public.agent_commission_rules (created_by);
create index if not exists agent_settlement_adjustments_created_by_fkey_idx on public.agent_settlement_adjustments (created_by);
create index if not exists agent_settlement_adjustments_settlement_id_fkey_idx on public.agent_settlement_adjustments (settlement_id);
create index if not exists agent_settlements_approved_by_fkey_idx on public.agent_settlements (approved_by);
create index if not exists agent_settlements_commission_rule_id_fkey_idx on public.agent_settlements (commission_rule_id);
create index if not exists agent_settlements_generated_by_fkey_idx on public.agent_settlements (generated_by);
create index if not exists approval_events_actor_user_id_fkey_idx on public.approval_events (actor_user_id);
create index if not exists boarding_events_actor_user_id_fkey_idx on public.boarding_events (actor_user_id);
create index if not exists boarding_events_sailing_id_fkey_idx on public.boarding_events (sailing_id);
create index if not exists booking_events_actor_user_id_fkey_idx on public.booking_events (actor_user_id);
create index if not exists booking_events_booking_id_fkey_idx on public.booking_events (booking_id);
create index if not exists bookings_agent_organization_id_fkey_idx on public.bookings (agent_organization_id);
create index if not exists bookings_tariff_id_fkey_idx on public.bookings (tariff_id);
create index if not exists charter_allocations_allocated_by_fkey_idx on public.charter_allocations (allocated_by);
create index if not exists charter_allocations_vessel_id_fkey_idx on public.charter_allocations (vessel_id);
create index if not exists company_invitations_accepted_by_fkey_idx on public.company_invitations (accepted_by);
create index if not exists credit_notes_booking_id_fkey_idx on public.credit_notes (booking_id);
create index if not exists credit_notes_created_by_fkey_idx on public.credit_notes (created_by);
create index if not exists credit_notes_invoice_id_fkey_idx on public.credit_notes (invoice_id);
create index if not exists credit_notes_refund_id_fkey_idx on public.credit_notes (refund_id);
create index if not exists data_retention_policies_updated_by_fkey_idx on public.data_retention_policies (updated_by);
create index if not exists delivery_records_created_by_fkey_idx on public.delivery_records (created_by);
create index if not exists delivery_records_request_id_fkey_idx on public.delivery_records (request_id);
create index if not exists invoice_lines_sailing_id_fkey_idx on public.invoice_lines (sailing_id);
create index if not exists invoices_created_by_fkey_idx on public.invoices (created_by);
create index if not exists invoices_organization_id_fkey_idx on public.invoices (organization_id);
create index if not exists invoices_payment_id_fkey_idx on public.invoices (payment_id);
create index if not exists invoices_tariff_id_fkey_idx on public.invoices (tariff_id);
create index if not exists legal_holds_created_by_fkey_idx on public.legal_holds (created_by);
create index if not exists legal_holds_user_id_fkey_idx on public.legal_holds (user_id);
create index if not exists material_assignments_assigned_by_fkey_idx on public.material_assignments (assigned_by);
create index if not exists material_assignments_sailing_id_fkey_idx on public.material_assignments (sailing_id);
create index if not exists material_quotes_approved_by_fkey_idx on public.material_quotes (approved_by);
create index if not exists material_quotes_created_by_fkey_idx on public.material_quotes (created_by);
create index if not exists material_quotes_tariff_id_fkey_idx on public.material_quotes (tariff_id);
create index if not exists material_tariffs_created_by_fkey_idx on public.material_tariffs (created_by);
create index if not exists membership_events_actor_user_id_fkey_idx on public.membership_events (actor_user_id);
create index if not exists membership_events_invitation_id_fkey_idx on public.membership_events (invitation_id);
create index if not exists membership_events_member_id_fkey_idx on public.membership_events (member_id);
create index if not exists membership_events_organization_id_fkey_idx on public.membership_events (organization_id);
create index if not exists notification_outbox_user_id_fkey_idx on public.notification_outbox (user_id);
create index if not exists organization_memberships_invited_by_fkey_idx on public.organization_memberships (invited_by);
create index if not exists organizations_approved_by_fkey_idx on public.organizations (approved_by);
create index if not exists payment_events_actor_user_id_fkey_idx on public.payment_events (actor_user_id);
create index if not exists payment_events_payment_id_fkey_idx on public.payment_events (payment_id);
create index if not exists payment_provider_events_payment_id_fkey_idx on public.payment_provider_events (payment_id);
create index if not exists privacy_requests_decided_by_fkey_idx on public.privacy_requests (decided_by);
create index if not exists privacy_requests_user_id_fkey_idx on public.privacy_requests (user_id);
create index if not exists refunds_booking_id_fkey_idx on public.refunds (booking_id);
create index if not exists refunds_decided_by_fkey_idx on public.refunds (decided_by);
create index if not exists refunds_requested_by_fkey_idx on public.refunds (requested_by);
create index if not exists role_assignments_created_by_fkey_idx on public.role_assignments (created_by);
create index if not exists role_assignments_organization_id_fkey_idx on public.role_assignments (organization_id);
create index if not exists routes_created_by_fkey_idx on public.routes (created_by);
create index if not exists routes_updated_by_fkey_idx on public.routes (updated_by);
create index if not exists sailing_checkpoint_events_actor_user_id_fkey_idx on public.sailing_checkpoint_events (actor_user_id);
create index if not exists sailing_readiness_events_actor_user_id_fkey_idx on public.sailing_readiness_events (actor_user_id);
create index if not exists sailings_created_by_fkey_idx on public.sailings (created_by);
create index if not exists sailings_updated_by_fkey_idx on public.sailings (updated_by);
create index if not exists schedule_templates_created_by_fkey_idx on public.schedule_templates (created_by);
create index if not exists schedule_templates_vessel_id_fkey_idx on public.schedule_templates (vessel_id);
create index if not exists service_policies_created_by_fkey_idx on public.service_policies (created_by);
create index if not exists tariffs_approved_by_fkey_idx on public.tariffs (approved_by);
create index if not exists tariffs_created_by_fkey_idx on public.tariffs (created_by);
create index if not exists tariffs_route_id_fkey_idx on public.tariffs (route_id);
create index if not exists transfer_request_attachments_request_id_fkey_idx on public.transfer_request_attachments (request_id);
create index if not exists transfer_request_attachments_uploaded_by_fkey_idx on public.transfer_request_attachments (uploaded_by);
create index if not exists transfer_request_events_actor_user_id_fkey_idx on public.transfer_request_events (actor_user_id);
create index if not exists transfer_request_events_request_id_fkey_idx on public.transfer_request_events (request_id);
create index if not exists transfer_requests_organization_id_fkey_idx on public.transfer_requests (organization_id);
create index if not exists transfer_requests_safety_reviewed_by_fkey_idx on public.transfer_requests (safety_reviewed_by);
create index if not exists vessels_created_by_fkey_idx on public.vessels (created_by);
create index if not exists vessels_updated_by_fkey_idx on public.vessels (updated_by);
