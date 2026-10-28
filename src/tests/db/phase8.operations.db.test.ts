// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asService, asUser, createOrg, createSailingPair, createStaff, createUser, currentTerms,
  dbConfigured, fails, individualBooking, owner, payInSandbox, q,
} from './pg';

/**
 * Phase 8 — real-database tests for credit control, agent settlements, materials,
 * charters, communications, MFA enforcement, privacy tooling, reports and a
 * privilege sweep over the whole public schema.
 */
const d = dbConfigured ? describe : describe.skip;

d('Phase 8 operations, finance controls and security (local database)', () => {
  let finA: string; let finB: string; let ops: string; let admin: string; let itStaff: string; let boarder: string;

  beforeAll(async () => {
    finA = await createStaff('op-fin-a', 'finance');
    finB = await createStaff('op-fin-b', 'finance');
    ops = await createStaff('op-ops', 'operations');
    admin = await createStaff('op-admin', 'super_admin');
    itStaff = await createStaff('op-it', 'it_support');
    boarder = await createStaff('op-boarder', 'boarding_staff');
  });

  const orgBooking = (user: string, org: string, outbound: string, pax: number, mode: 'pay_now' | 'on_account', client: string | null = null) =>
    currentTerms().then(terms => asUser(user, `select booking_id from public.create_organization_booking(${q(randomUUID())}, ${q(org)}, ${q(outbound)}, ${pax},
      'Fictional Crew', 'crew@example.test', '+966500000003', ${q(terms)}, ${q(mode)}, null, null, 'PO-IT-1', ${q(client)}, ${q(client ? 'C-REF' : null)})`));

  describe('corporate credit', () => {
    it('only finance sets terms; on-account booking is invoiced with a due date and limited by the facility', async () => {
      const corpAdmin = await createUser('corp-admin');
      const org = await createOrg(`corp-${randomUUID().slice(0, 4)}`, 'corporate', corpAdmin);
      const { out } = await createSailingPair();
      expect((await fails(asUser(corpAdmin, `select public.set_organization_credit(${q(org)}, 99999999, 90)`))).sqlState).toBe('42501');
      expect((await fails(orgBooking(corpAdmin, org, out, 1, 'on_account'))).message).toMatch(/credit_not_available/);
      await asUser(finA, `select public.set_organization_credit(${q(org)}, 150000, 30)`);
      expect(await asUser(finA, `select public.set_credit_status(${q(org)}, 'active', 'Approved facility (fictional)')`)).toBe('active');
      const bookingId = await orgBooking(corpAdmin, org, out, 2, 'on_account');
      expect(await owner(`select b.payment_status||'|'||i.status||'|'||i.settlement_mode||'|'||(i.due_date - i.issue_date)||'|'||i.total_halala
        from public.bookings b join public.invoices i on i.booking_id = b.id where b.id = ${q(bookingId)}`)).toBe('on_account|issued|on_account|30|100000');
      expect(await asUser(corpAdmin, `select outstanding_halala||'|'||available_halala from public.organization_credit_position(${q(org)})`)).toBe('100000|50000');
      expect((await fails(orgBooking(corpAdmin, org, out, 2, 'on_account'))).message).toMatch(/credit_limit_exceeded/);
      // Holds block further on-account bookings; every change is audited.
      await asUser(finB, `select public.set_credit_status(${q(org)}, 'on_hold', 'Overdue review (fictional)')`);
      expect((await fails(orgBooking(corpAdmin, org, out, 1, 'on_account'))).message).toMatch(/credit_not_available/);
      expect(Number(await owner(`select count(*) from public.config_audit where entity = 'organizations' and entity_id = ${q(org)}`))).toBeGreaterThanOrEqual(3);
      // Finance reconciles a bank transfer against the invoice.
      const inv = await owner(`select id from public.invoices where booking_id = ${q(bookingId)}`);
      expect(await asUser(finA, `select public.record_account_payment(${q(inv)}, 100000, 'BANK-IT-1')`)).toBe('paid');
      expect(await owner(`select payment_status from public.bookings where id = ${q(bookingId)}`)).toBe('paid');
    });

    it('overdue balances block new on-account bookings', async () => {
      const corpAdmin = await createUser('corp-overdue');
      const org = await createOrg(`od-${randomUUID().slice(0, 4)}`, 'corporate', corpAdmin);
      const { out } = await createSailingPair();
      await asUser(finA, `select public.set_organization_credit(${q(org)}, 10000000, 0)`);
      await asUser(finA, `select public.set_credit_status(${q(org)}, 'active', 'IT')`);
      const b = await orgBooking(corpAdmin, org, out, 1, 'on_account');
      await owner(`update public.invoices set due_date = due_date - 5 where booking_id = ${q(b)}`);
      expect((await fails(orgBooking(corpAdmin, org, out, 1, 'on_account'))).message).toMatch(/credit_on_hold/);
    });
  });

  describe('agent settlements', () => {
    it('pays no commission without an approved rule; an approved rule calculates; four-eyes approval', async () => {
      const agentAdmin = await createUser('agent-set');
      const org = await createOrg(`ag-${randomUUID().slice(0, 4)}`, 'agent', agentAdmin);
      const { out } = await createSailingPair(12, 24 * 3);
      const b = await orgBooking(agentAdmin, org, out, 2, 'pay_now', 'Fictional Vessel Owner');
      await payInSandbox(agentAdmin, b);
      const day = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date from public.sailings where id = ${q(out)}`);
      const s1 = await asUser(finA, `select public.generate_agent_settlement(${q(org)}, ${q(day)}, ${q(day)})`);
      expect(await owner(`select gross_halala||'|'||commission_halala||'|'||commission_status||'|'||trips||'|'||passengers from public.agent_settlements where id = ${q(s1)}`))
        .toBe('100000|0|no_approved_rule|1|2');
      await asUser(finA, `select public.decide_agent_settlement(${q(s1)}, 'void', null, 'regenerate with rule')`);
      const rule = await asUser(finA, `select public.propose_commission_rule(${q(org)}, 'percent_of_net_bp', 250, ${q(day)}, null, 'IT rate - fictional')`);
      expect((await fails(asUser(finA, `select public.approve_commission_rule(${q(rule)}, 'self')`))).message).toMatch(/four_eyes_required/);
      await asUser(finB, `select public.approve_commission_rule(${q(rule)}, 'IT')`);
      const s2 = await asUser(finA, `select public.generate_agent_settlement(${q(org)}, ${q(day)}, ${q(day)})`);
      expect(await owner(`select commission_halala||'|'||net_due_halala||'|'||commission_status from public.agent_settlements where id = ${q(s2)}`)).toBe('2500|2500|calculated');
      expect(await asUser(finA, `select public.adjust_agent_settlement(${q(s2)}, -500, 'Fictional correction')`)).toBe('2000');
      expect((await fails(asUser(finA, `select public.decide_agent_settlement(${q(s2)}, 'approve', null, 'self')`))).message).toMatch(/four_eyes_required/);
      await asUser(finB, `select public.decide_agent_settlement(${q(s2)}, 'approve', null, 'IT approve')`);
      await asUser(finB, `select public.decide_agent_settlement(${q(s2)}, 'mark_paid', 'TRF-IT-9', 'IT paid')`);
      // The agent sees its own statement; another agent does not.
      expect(await asUser(agentAdmin, `select status||'|'||net_due_halala from public.agent_settlements where id = ${q(s2)}`)).toBe('paid|2000');
      const otherAdmin = await createUser('agent-other');
      await createOrg(`ag2-${randomUUID().slice(0, 4)}`, 'agent', otherAdmin);
      expect(await asUser(otherAdmin, `select count(*) from public.agent_settlements where id = ${q(s2)}`)).toBe('0');
    });
  });

  describe('materials', () => {
    async function materialRequest(details: Record<string, unknown>) {
      const corpAdmin = await createUser('mat');
      const org = await createOrg(`mat-${randomUUID().slice(0, 4)}`, 'corporate', corpAdmin);
      const id = await asUser(corpAdmin, `select public.submit_transfer_request(${q(org)}, 'materials', ${q(randomUUID())}, ${q(JSON.stringify(details))}::jsonb)`);
      return { corpAdmin, org, id };
    }
    const approve = async (id: string) => {
      const rev = await owner(`select revision from public.transfer_requests where id = ${q(id)}`);
      return asUser(ops, `select public.review_transfer_request(${q(id)}, ${rev}, 'approved', 'IT approve')`);
    };

    it('never approves without a staff safety review, even when declared non-hazardous', async () => {
      const { id } = await materialRequest({ description: 'Spare pump', weight_kg: '120.5', category: 'spare_parts', hazardous: 'false' });
      expect(await owner(`select weight_kg||'|'||declared_hazardous||'|'||safety_decision from public.transfer_requests where id = ${q(id)}`)).toBe('121|false|pending');
      expect((await fails(approve(id))).message).toMatch(/safety_review_required/);
      await asUser(ops, `select public.record_material_safety_review(${q(id)}, 'accepted', null, 'Inspected (fictional)')`);
      expect(await approve(id)).toBe('recorded');
    });

    it('requires a permit reference for dangerous goods', async () => {
      const { id } = await materialRequest({ description: 'Fictional gas cylinders', weight_kg: '40', category: 'dangerous_goods' });
      expect((await fails(asUser(ops, `select public.record_material_safety_review(${q(id)}, 'accepted', null, 'x')`))).message).toMatch(/permit_reference_required/);
      expect(await asUser(ops, `select public.record_material_safety_review(${q(id)}, 'accepted', 'DG-PERMIT-IT', 'Permit seen')`)).toBe('accepted');
    });

    it('quotes from parameterised tariffs, enforces payload limits and proof of delivery', async () => {
      const { id, corpAdmin } = await materialRequest({ description: 'Provisions', weight_kg: '300', category: 'provisions' });
      const quote = await asUser(ops, `select public.quote_material_request(${q(id)})`);
      // Provisional seeded per-kg tariff: 500 halala/kg × 300 kg; VAT not configured.
      expect(await asUser(corpAdmin, `select basis||'|'||total_halala||'|'||status from public.material_quotes where id = ${q(quote)}`)).toBe('per_kg|150000|indicative');
      expect((await fails(asUser(finA, `select public.approve_material_quote(${q(quote)}, 'x')`))).message).toMatch(/tariff_not_approved/);
      await asUser(ops, `select public.record_material_safety_review(${q(id)}, 'accepted', null, 'ok')`);
      await approve(id);
      const { out } = await createSailingPair();
      expect((await fails(asUser(ops, `select public.assign_material_to_sailing(${q(id)}, ${q(out)}, 'x')`))).message).toMatch(/payload_capacity_unknown/);
      await asUser(ops, `select public.set_payload_capacity(null, ${q(out)}, 250, 'IT capacity')`);
      expect((await fails(asUser(ops, `select public.assign_material_to_sailing(${q(id)}, ${q(out)}, 'x')`))).message).toMatch(/payload_exceeded/);
      await asUser(ops, `select public.set_payload_capacity(null, ${q(out)}, 1000, 'IT capacity')`);
      expect(await asUser(ops, `select public.assign_material_to_sailing(${q(id)}, ${q(out)}, 'Load on first run')`)).toBe('scheduled');
      expect(await asUser(boarder, `select weight_kg||'|'||status from public.material_manifest(${q(out)})`)).toBe('300|scheduled');
      expect((await fails(asUser(ops, `select public.record_delivery(${q(id)}, 'Receiver', null, null, null)`))).message).toMatch(/proof_required/);
      await asUser(ops, `select public.record_delivery(${q(id)}, 'Fictional Receiver', 'SIG-IT-1', null, 'ok')`);
      expect(await owner(`select status from public.transfer_requests where id = ${q(id)}`)).toBe('delivered');
    });

    it('stores attachments only under the request path with allowed types and sizes', async () => {
      const { id, org, corpAdmin } = await materialRequest({ description: 'Docs', category: 'documents' });
      const good = `${org}/${id}/${randomUUID()}.pdf`;
      expect(await asUser(corpAdmin, `select count(*) from (select public.register_request_attachment(${q(id)}, ${q(good)}, 'application/pdf', 2048, null)) x`)).toBe('1');
      expect((await fails(asUser(corpAdmin, `select public.register_request_attachment(${q(id)}, ${q(`${org}/${id}/${randomUUID()}.pdf`)}, 'application/x-msdownload', 10, null)`))).message).toMatch(/unsupported file type/);
      expect((await fails(asUser(corpAdmin, `select public.register_request_attachment(${q(id)}, ${q(`${org}/${id}/${randomUUID()}.png`)}, 'image/png', 20000000, null)`))).message).toMatch(/too large/);
      const stranger = await createUser('att-stranger');
      expect((await fails(asUser(stranger, `select public.register_request_attachment(${q(id)}, ${q(`${org}/${id}/${randomUUID()}.pdf`)}, 'application/pdf', 10, null)`))).sqlState).toBe('42501');
      expect(await asUser(stranger, `select public.can_read_request_object(${q(good)})`)).toBe('f');
      expect(await asUser(ops, `select public.can_read_request_object(${q(good)})`)).toBe('t');
    });
  });

  describe('charters', () => {
    it('is confirmed only with a conflict-free vessel allocation', async () => {
      const corpAdmin = await createUser('charter');
      const org = await createOrg(`ch-${randomUUID().slice(0, 4)}`, 'corporate', corpAdmin);
      const id = await asUser(corpAdmin, `select public.submit_transfer_request(${q(org)}, 'charter', ${q(randomUUID())}, '{"description":"Crew change charter (fictional)","passengers":"6"}'::jsonb)`);
      const vessel = await owner(`select vessel_id from public.sailings where id = (select out from (select 1) x, lateral (select id as out from public.sailings order by departs_at desc limit 1) y)`);
      expect((await fails(asUser(ops, `select public.allocate_charter(${q(id)}, ${q(vessel)}, now() + interval '200 days', now() + interval '200 days 3 hours', 300000, 'x')`))).message).toMatch(/approve the charter/);
      const rev = await owner(`select revision from public.transfer_requests where id = ${q(id)}`);
      await asUser(ops, `select public.review_transfer_request(${q(id)}, ${rev}, 'approved', 'Feasible (fictional)')`);
      expect(await asUser(corpAdmin, `select status from public.transfer_requests where id = ${q(id)}`)).toBe('approved');
      const busyAt = await owner(`select departs_at from public.sailings where vessel_id = ${q(vessel)} and status = 'open' and departs_at > now() + interval '2 days' order by departs_at limit 1`);
      expect((await fails(asUser(ops, `select public.allocate_charter(${q(id)}, ${q(vessel)}, ${q(busyAt)}::timestamptz - interval '30 minutes', ${q(busyAt)}::timestamptz + interval '2 hours', 300000, 'x')`))).message).toMatch(/vessel_conflict/);
      const freeVessel = await owner(`insert into public.vessels (name, passenger_capacity, status) values (${q(`Charter IT ${randomUUID().slice(0, 6)}`)}, 10, 'active') returning id`);
      expect(await asUser(ops, `select public.allocate_charter(${q(id)}, ${q(freeVessel)}, now() + interval '200 days', now() + interval '200 days 3 hours', 300000, 'Allocated (fictional)')`)).toBe('confirmed');
      expect(await asUser(corpAdmin, `select r.status||'|'||a.quoted_total_halala from public.transfer_requests r join public.charter_allocations a on a.request_id = r.id where r.id = ${q(id)}`)).toBe('confirmed|300000');
    });
  });

  describe('communications', () => {
    it('records external messages as suppressed until a channel is configured, respecting consent', async () => {
      const user = await createUser('notify');
      const { out } = await createSailingPair();
      await individualBooking(user, out, 1);
      expect(await owner(`select string_agg(channel||':'||status||':'||coalesce(suppressed_reason,''), ',' order by channel) from public.notification_outbox where user_id = ${q(user)} and template_key = 'booking_created'`))
        .toBe('email:suppressed:channel_not_configured');
      expect((await fails(asUser(user, `select public.set_notification_preference('whatsapp', true, null)`))).message).toMatch(/consent_required/);
      await asUser(user, `select public.set_notification_preference('sms', true, 'sms-v1')`);
      await asUser(admin, `select public.set_notification_channel('email', true, 'IT enable (sandbox)')`);
      try {
        await individualBooking(user, out, 1);
        const rows = await owner(`select string_agg(channel||':'||status, ',' order by channel) from public.notification_outbox o
          where user_id = ${q(user)} and template_key = 'booking_created' and created_at > now() - interval '5 seconds'`);
        expect(rows).toContain('email:queued');
        expect(rows).toContain('sms:suppressed');
        // Dispatcher lease + retry semantics (service role only); never "sent" without provider acceptance.
        expect((await fails(asUser(user, `select * from public.claim_outbox_batch(10)`))).message).toMatch(/permission denied|not authorized/);
        const claimed = await asService(`select outbox_id||'|'||recipient from public.claim_outbox_batch(200) where channel = 'email'`);
        const mine = claimed.split('\n').find(l => l.endsWith('@example.test') && l.includes('notify'));
        expect(mine).toBeTruthy();
        const outboxId = mine!.split('|')[0];
        expect(await asService(`select public.complete_outbox_delivery(${q(outboxId)}, 'failed', 'sandbox-email', null, 'timeout')`)).toBe('retry_scheduled');
        expect(await asService(`select public.complete_outbox_delivery(${q(outboxId)}, 'sent', 'sandbox-email', 'msg-1', null)`)).toBe('sent');
        expect(await asService(`select public.complete_outbox_delivery(${q(outboxId)}, 'sent', 'sandbox-email', 'msg-1', null)`)).toBe('unchanged');
        expect(await asUser(itStaff, `select count(*) >= 0 from public.notification_delivery_issues(10)`)).toBe('t');
      } finally {
        await asUser(admin, `select public.set_notification_channel('email', false, 'IT disable')`);
        await owner(`update public.notification_outbox set status = 'suppressed', suppressed_reason = 'test_cleanup' where status in ('queued', 'sending')`);
      }
    });
  });

  describe('security, MFA and privacy', () => {
    it('IT support sees diagnostics but no passenger data', async () => {
      expect(await asUser(itStaff, `select (public.system_diagnostics() ->> 'payments_mode')`)).toBe('sandbox');
      expect(await asUser(itStaff, `select count(*) from public.bookings`)).toBe('0');
      expect(await asUser(itStaff, `select count(*) from public.tickets`)).toBe('0');
      expect((await fails(asUser(itStaff, `select * from public.ticket_manifest(gen_random_uuid())`))).sqlState).toBe('42501');
      expect((await fails(asUser(ops, `select public.system_diagnostics()`))).sqlState).toBe('42501');
    });

    it('enforces MFA (aal2) for staff roles when required', async () => {
      await owner(`update public.platform_settings set value = '{"value": true}' where key = 'security.staff_mfa_required'`);
      try {
        expect(await asUser(ops, `select count(*) > 0 from public.bookings`)).toBe('f');
        expect((await fails(asUser(ops, `select public.generate_sailings(current_date + 40, current_date + 40)`))).sqlState).toBe('42501');
        expect(await asUser(ops, `select count(*) > 0 from public.bookings`, { aal: 'aal2' })).toBe('t');
        expect(await asUser(ops, `select mfa_required||'|'||session_aal from public.my_security_posture()`)).toBe('true|aal1');
      } finally {
        await owner(`update public.platform_settings set value = '{"value": false}' where key = 'security.staff_mfa_required'`);
      }
    });

    it('exports own data, refuses erasure under legal hold, then redacts while keeping financial records', async () => {
      const user = await createUser('privacy');
      const other = await createUser('privacy-other');
      const { out } = await createSailingPair(12, 24);
      const b = await individualBooking(user, out, 1);
      await payInSandbox(user, b);
      const exported = JSON.parse(await asUser(user, `select public.export_my_data()::text`));
      expect(exported.bookings).toHaveLength(1);
      expect(JSON.stringify(exported)).not.toMatch(/qr_token/);
      expect(JSON.parse(await asUser(other, `select public.export_my_data()::text`)).bookings).toHaveLength(0);
      const req = await asUser(user, `select public.submit_privacy_request('erasure', 'Please erase (fictional)')`);
      expect(await owner(`select due_at::date - created_at::date from public.privacy_requests where id = ${q(req)}`)).toBe('30');
      // Trip still upcoming → refused; after the trip and with a legal hold → refused; hold released → redacted.
      expect((await fails(asUser(admin, `select public.anonymize_user_data(${q(user)}, 'Erasure request')`))).message).toMatch(/active_trips/);
      // Trip closed by operations (no automatic refund: a refund review is opened instead).
      await asUser(ops, `select public.cancel_booking(${q(b)}, 'Passenger no longer travelling (fictional)')`);
      await asUser(admin, `select public.set_legal_hold(${q(user)}, true, 'Fictional dispute')`);
      expect((await fails(asUser(admin, `select public.anonymize_user_data(${q(user)}, 'Erasure request')`))).message).toMatch(/legal_hold_active/);
      await asUser(admin, `select public.set_legal_hold(${q(user)}, false, 'Dispute closed')`);
      await asUser(admin, `select public.anonymize_user_data(${q(user)}, 'Erasure request')`);
      expect(await owner(`select b.contact_name||'|'||i.total_halala||'|'||(i.invoice_number is not null) from public.bookings b join public.invoices i on i.booking_id = b.id where b.id = ${q(b)}`)).toBe('Redacted|50000|true');
      expect(await asUser(admin, `select public.decide_privacy_request(${q(req)}, 'completed', 'Redacted; financial records retained')`)).toBe('completed');
    });

    it('retention does nothing until a period is approved', async () => {
      const rows = await asUser(admin, `select count(*) from public.apply_retention(true)`);
      expect(rows).toBe('0');
    });

    it('health ping is public; diagnostics are not', async () => {
      expect(await asAnon(`select public.health_ping() ->> 'status'`)).toBe('ok');
      expect((await fails(asAnon(`select public.system_diagnostics()`))).message).toMatch(/permission denied/);
    });

    it('privilege sweep: RLS everywhere, definer functions pinned, nothing new exposed to anon', async () => {
      expect(await owner(`select coalesce(string_agg(c.relname, ','), '') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity`)).toBe('');
      expect(await owner(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')`)).toBe('');
      const anonCallable = await owner(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
        and has_function_privilege('anon', p.oid, 'execute') and p.prosecdef`);
      expect(anonCallable.split(',').filter(Boolean).every(n => ['health_ping'].includes(n))).toBe(true);
      // No table grants writes to anon or authenticated beyond the documented column grants of earlier phases.
      expect(await owner(`select coalesce(string_agg(distinct table_name, ','), '') from information_schema.role_table_grants where table_schema = 'public'
        and grantee = 'anon'`)).toBe('');
      expect(await owner(`select coalesce(string_agg(distinct table_name, ',' order by table_name), '') from information_schema.role_table_grants where table_schema = 'public'
        and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')`)).toBe('profiles'); // Phase 1 self-service profile (RLS + status guard)
    });

    it('reports are role-gated, timezone-correct and do not double count return journeys', async () => {
      const user = await createUser('report');
      const { out, back } = await createSailingPair();
      const b = await individualBooking(user, out, 1, back);
      await payInSandbox(user, b);
      const day1 = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date from public.sailings where id = ${q(out)}`);
      const day2 = await owner(`select (departs_at at time zone 'Asia/Riyadh')::date + 1 from public.sailings where id = ${q(back)}`);
      const rows = await asUser(finA, `select sum(collected_halala) from public.report_revenue_by_sailing(${q(day1)}, ${q(day2)}) where sailing_id in (${q(out)}, ${q(back)})`);
      expect(rows).toBe('100000');
      expect((await fails(asUser(user, `select * from public.report_period_summary(${q(day1)}, ${q(day2)}, 'day')`))).sqlState).toBe('42501');
      expect((await fails(asUser(ops, `select * from public.report_payments_summary(${q(day1)}, ${q(day2)})`))).sqlState).toBe('42501');
      expect(Number(await asUser(ops, `select count(*) from public.report_period_summary(${q(day1)}, ${q(day2)}, 'day')`))).toBeGreaterThanOrEqual(1);
      expect(await asUser(finA, `select issue from public.report_payment_reconciliation(current_date - 1, current_date + 1) where booking_reference = (select reference from public.bookings where id = ${q(b)})`)).toBe('');
    });
  });
});
