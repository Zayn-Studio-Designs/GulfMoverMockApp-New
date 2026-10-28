// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asService, asUser, clearSailing, createOrg, createSailingPair, createStaff, createUser, currentTerms,
  dbConfigured, fails, individualBooking, owner, payInSandbox, q,
} from './pg';
import { decodeZatcaQr, encodeZatcaQr } from '../../domain/zatcaQr';

/**
 * Phase 8 — real-database tests for tariffs, pricing, the booking engine, checkout,
 * verified payment results, invoices, refunds and the minimum-sailing rule.
 * Requires `scripts/db/local-db.sh up` and GM_DB_URL (loopback only); skipped otherwise.
 */
const d = dbConfigured ? describe : describe.skip;

d('Phase 8 commerce (local database)', () => {
  let finA: string; let finB: string; let ops: string; let admin: string; let boarder: string;

  beforeAll(async () => {
    finA = await createStaff('fin-a', 'finance');
    finB = await createStaff('fin-b', 'finance');
    ops = await createStaff('ops', 'operations');
    admin = await createStaff('admin', 'super_admin');
    boarder = await createStaff('boarder', 'boarding_staff');
  });

  describe('tariffs and server-side pricing', () => {
    it('quotes SAR 500 per passenger per one-way leg with VAT not configured', async () => {
      const { out, back } = await createSailingPair();
      const user = await createUser('quote');
      const row = await asUser(user, `select unit_halala, quantity, net_halala, vat_halala, total_halala, vat_mode
        from public.quote_passenger_fare(${q(out)}, ${q(back)}, 3)`);
      expect(row).toBe('50000|6|300000|0|300000|not_configured');
    });

    it('blocks direct fare edits; publishing needs finance; approval needs a second person', async () => {
      const user = await createUser('tamper');
      expect((await fails(asUser(user, `update public.tariffs set per_person_halala = 1`))).message).toMatch(/permission denied/);
      expect((await fails(asUser(finA, `update public.tariffs set per_person_halala = 1`))).message).toMatch(/permission denied/);
      expect((await fails(asUser(user, `select public.publish_tariff('X', 1, 'not_configured', null, now())`))).sqlState).toBe('42501');
      const code = `IT-${randomUUID().slice(0, 6)}`;
      const id = await asUser(finA, `select public.publish_tariff(${q(code)}, 40000, 'exclusive', 1500, now() + interval '400 days', null, 'IT', 'IT publish')`);
      expect((await fails(asUser(finA, `select public.approve_tariff(${q(id)}, 'self approve')`))).message).toMatch(/four_eyes_required/);
      expect(await asUser(finB, `select public.approve_tariff(${q(id)}, 'IT approval')`)).toBe('approved');
      // Amounts are immutable even for the owner role once published.
      expect((await fails(owner(`update public.tariffs set per_person_halala = 1 where id = ${q(id)}`))).message).toMatch(/tariff_immutable/);
      const audit = await owner(`select count(*) from public.config_audit where entity = 'tariffs' and entity_id = ${q(id)}`);
      expect(Number(audit)).toBeGreaterThanOrEqual(2);
      // Retire so it never affects other tests' quotes.
      expect(await asUser(finB, `select public.retire_tariff(${q(id)}, 'IT cleanup')`)).toBe('retired');
    });

    it('computes exclusive and inclusive VAT exactly in halala', async () => {
      expect(await owner(`select net_halala||'|'||vat_halala||'|'||gross_halala from public.vat_breakdown(50000, 'exclusive', 1500)`)).toBe('50000|7500|57500');
      expect(await owner(`select net_halala||'|'||vat_halala||'|'||gross_halala from public.vat_breakdown(50001, 'inclusive', 1500)`)).toBe('43479|6522|50001');
      expect(await owner(`select net_halala||'|'||vat_halala||'|'||gross_halala from public.vat_breakdown(333, 'exclusive', 1500)`)).toBe('333|50|383');
    });
  });

  describe('booking engine', () => {
    it('individual books outbound + return in one checkout with separate legs, tickets and capacity', async () => {
      const { out, back } = await createSailingPair();
      const user = await createUser('indiv');
      const id = await individualBooking(user, out, 2, back);
      const row = await owner(`select account_type, organization_id is null, total_halala, payment_status, settlement_mode, hold_expires_at > now(),
          (select count(*) from public.tickets where booking_id = b.id), (select count(*) from public.booking_legs where booking_id = b.id)
        from public.bookings b where id = ${q(id)}`);
      expect(row).toBe('individual|t|200000|unpaid|pay_now|t|4|2');
      expect(await owner(`select string_agg(seats_booked::text, ',' order by departs_at) from public.sailings where id in (${q(out)}, ${q(back)})`)).toBe('2,2');
      // Customers cannot write money columns.
      expect((await fails(asUser(user, `update public.bookings set total_halala = 1 where id = ${q(id)}`))).message).toMatch(/permission denied/);
    });

    it('replays an identical request and rejects a changed payload for the same key', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('replay');
      const key = randomUUID();
      const a = await individualBooking(user, out, 1, null, key);
      const b = await individualBooking(user, out, 1, null, key);
      expect(a).toBe(b);
      expect((await fails(individualBooking(user, out, 2, null, key))).message).toMatch(/payload_mismatch/);
    });

    it('never overbooks under concurrent checkouts', async () => {
      const { out } = await createSailingPair(5);
      const users = await Promise.all(Array.from({ length: 6 }, (_, i) => createUser(`race-${i}`)));
      const results = await Promise.allSettled(users.map(u => individualBooking(u, out, 2)));
      const ok = results.filter(r => r.status === 'fulfilled').length;
      expect(ok).toBe(2);
      for (const r of results) if (r.status === 'rejected') expect(String(r.reason.message)).toMatch(/sailing_full/);
      expect(await owner(`select seats_booked from public.sailings where id = ${q(out)}`)).toBe('4');
    });

    it('requires terms acceptance, rejects strangers booking for an organization, and isolates agents', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('noterms');
      expect((await fails(asUser(user, `select * from public.create_individual_booking(${q(randomUUID())}, ${q(out)}, 1,
        'A', 'a@example.test', '+966500000001', null, null, null, null, 'wrong-version')`))).message).toMatch(/terms_not_accepted/);
      const agentAdmin = await createUser('agent-admin');
      const agentOrg = await createOrg(`agent-${randomUUID().slice(0, 4)}`, 'agent', agentAdmin);
      const stranger = await createUser('stranger');
      const terms = await currentTerms();
      const call = (u: string) => asUser(u, `select booking_id from public.create_organization_booking(${q(randomUUID())}, ${q(agentOrg)}, ${q(out)}, 1,
        'Crew Member', 'crew@example.test', '+966500000002', ${q(terms)}, 'pay_now', null, null, null, 'Fictional Shipping Client', 'CLIENT-1')`);
      expect((await fails(call(stranger))).message).toMatch(/not_a_member/);
      const bookingId = await call(agentAdmin);
      expect(await owner(`select account_type||'|'||(agent_organization_id = organization_id)||'|'||client_name from public.bookings where id = ${q(bookingId)}`))
        .toBe('agent|true|Fictional Shipping Client');
      expect(await asUser(stranger, `select count(*) from public.bookings where id = ${q(bookingId)}`)).toBe('0');
    });

    it('rejects a return sailing that is not the reverse route or departs first', async () => {
      const a = await createSailingPair();
      const b = await createSailingPair();
      const user = await createUser('badreturn');
      expect((await fails(individualBooking(user, a.out, 1, b.out))).message).toMatch(/invalid return sailing/);
    });
  });

  describe('checkout and verified payment results', () => {
    it('is idempotent, server-priced, sandbox-simulated, invoiced with reconciling lines', async () => {
      const { out, back } = await createSailingPair();
      const user = await createUser('payer');
      const bookingId = await individualBooking(user, out, 1, back);
      const key = randomUUID();
      const first = await asUser(user, `select payment_id||'|'||amount_halala||'|'||outcome||'|'||mode from public.begin_checkout(${q(bookingId)}, 'visa', ${q(key)})`);
      const [payId, amount, outcome, mode] = first.split('|');
      expect([amount, outcome, mode]).toEqual(['100000', 'created', 'sandbox']);
      expect((await asUser(user, `select payment_id||'|'||outcome from public.begin_checkout(${q(bookingId)}, 'visa', ${q(key)})`))).toBe(`${payId}|replayed`);
      expect((await fails(asUser(user, `select * from public.begin_checkout(${q(bookingId)}, 'visa', ${q(randomUUID())})`))).message).toMatch(/payment_in_progress/);
      // Nothing is paid or invoiced before a verified result.
      expect(await owner(`select payment_status||'|'||(select count(*) from public.invoices where booking_id = ${q(bookingId)}) from public.bookings where id = ${q(bookingId)}`)).toBe('pending|0');
      // An authenticated user cannot call the service-role result endpoint.
      expect((await fails(asUser(user, `select public.apply_payment_result('sandbox-provider', 'evt-x', 'payment_paid', null, null, 'paid', 100000, 'SAR', 0, 'webhook', null)`))).message).toMatch(/permission denied|not authorized/);
      expect(await asUser(user, `select public.sandbox_simulate_payment(${q(payId)}, 'paid')`)).toBe('succeeded');
      expect(await asUser(user, `select public.sandbox_simulate_payment(${q(payId)}, 'paid')`)).toBe('duplicate_event');
      const inv = await owner(`select i.invoice_number ~ '^GM-INV-[0-9]{4}-[0-9]{6}$', i.status, i.total_halala, i.amount_paid_halala, i.document_type, i.sandbox,
          (select sum(total_halala) from public.invoice_lines where invoice_id = i.id), (select count(*) from public.invoice_lines where invoice_id = i.id),
          i.previous_hash is not null and i.invoice_hash is not null, i.qr_tlv is null
        from public.invoices i where booking_id = ${q(bookingId)}`);
      expect(inv).toBe('t|paid|100000|100000|commercial_invoice|t|100000|2|t|t');
      expect(await asUser(user, `select payment_status from public.bookings where id = ${q(bookingId)}`)).toBe('paid');
    });

    it('flags an amount mismatch for review instead of confirming the booking', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('mismatch');
      const bookingId = await individualBooking(user, out, 1);
      const ref = await asUser(user, `select merchant_reference from public.begin_checkout(${q(bookingId)}, 'mada', ${q(randomUUID())})`);
      const res = await asService(`select public.apply_payment_result('sandbox-provider', ${q(`evt-${randomUUID()}`)}, 'payment_paid', ${q(ref)}, ${q(`pay_${randomUUID()}`)}, 'paid', 100, 'SAR', 0, 'webhook', null)`);
      expect(res).toBe('amount_mismatch');
      expect(await owner(`select b.payment_status||'|'||p.status from public.bookings b join public.payments p on p.booking_id = b.id where b.id = ${q(bookingId)}`)).toBe('pending|requires_review');
      // A provider id that already belongs to another payment is never re-pointed.
      const other = await individualBooking(user, out, 1);
      const ref2 = await asUser(user, `select merchant_reference from public.begin_checkout(${q(other)}, 'mada', ${q(randomUUID())})`);
      const taken = await owner(`select provider_payment_id from public.payments where booking_id = ${q(bookingId)}`);
      expect(await asService(`select public.apply_payment_result('sandbox-provider', ${q(`evt-${randomUUID()}`)}, 'payment_paid', ${q(ref2)}, ${q(taken)}, 'paid', 50000, 'SAR', 0, 'webhook', null)`)).toBe('reference_conflict');
      expect(await owner(`select payment_status from public.bookings where id = ${q(other)}`)).toBe('pending');
    });

    it('refuses live checkout until live payments are explicitly enabled', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('live');
      const bookingId = await individualBooking(user, out, 1);
      await owner(`update public.platform_settings set value = '{"value":"live"}' where key = 'payments.mode'`);
      try {
        expect((await fails(asUser(user, `select * from public.begin_checkout(${q(bookingId)}, 'mada', ${q(randomUUID())})`))).message).toMatch(/payments_not_enabled/);
        expect((await fails(asUser(admin, `select public.update_platform_setting('payments.live_enabled', '{"value": true}', 'try')`))).message).toMatch(/seller_identity_required/);
      } finally {
        await owner(`update public.platform_settings set value = '{"value":"sandbox"}' where key = 'payments.mode'`);
      }
    });

    it('expires unpaid holds, releases seats, and routes a late capture to refund review', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('hold');
      const bookingId = await individualBooking(user, out, 2);
      const ref = await asUser(user, `select merchant_reference from public.begin_checkout(${q(bookingId)}, 'mada', ${q(randomUUID())})`);
      await owner(`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = ${q(bookingId)};
                   update public.payments set created_at = now() - interval '2 hours' where booking_id = ${q(bookingId)}`);
      expect(Number(await asUser(ops, `select public.expire_stale_holds()`))).toBeGreaterThanOrEqual(1);
      expect(await owner(`select b.status||'|'||s.seats_booked from public.bookings b, public.sailings s where b.id = ${q(bookingId)} and s.id = ${q(out)}`)).toBe('expired|0');
      const late = await asService(`select public.apply_payment_result('sandbox-provider', ${q(`evt-${randomUUID()}`)}, 'payment_paid', ${q(ref)}, null, 'paid', 100000, 'SAR', 0, 'server_fetch', null)`);
      expect(late).toBe('captured_after_close');
      expect(await owner(`select status from public.refunds where booking_id = ${q(bookingId)}`)).toBe('pending_review');
    });
  });

  describe('refunds and credit notes', () => {
    it('needs an approved policy and a second person, then issues a credit note', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('refundee');
      const bookingId = await individualBooking(user, out, 1);
      const pay = await payInSandbox(user, bookingId);
      const refundId = await asUser(finA, `select public.request_refund(${q(pay)}, 20000, 'Goodwill (fictional)')`);
      expect((await fails(asUser(finB, `select public.decide_refund(${q(refundId)}, 'approve', 'ok')`))).message).toMatch(/refund_policy_not_approved/);
      const version = `it-${randomUUID().slice(0, 6)}`;
      await asUser(admin, `select public.publish_policy('refund', ${q(version)}, '{"note":"IT approved refund policy (fictional)"}', 'IT')`);
      await asUser(admin, `select public.set_policy_status('refund', ${q(version)}, 'approved', 'IT approval')`);
      try {
        expect((await fails(asUser(finA, `select public.decide_refund(${q(refundId)}, 'approve', 'self')`))).message).toMatch(/four_eyes_required/);
        expect(await asUser(finB, `select public.decide_refund(${q(refundId)}, 'approve', 'IT approve')`)).toBe('succeeded');
        expect(await owner(`select p.status||'|'||p.refunded_halala||'|'||b.payment_status||'|'||cn.total_halala||'|'||(cn.credit_number ~ '^GM-CN-')
          from public.payments p join public.bookings b on b.id = p.booking_id join public.credit_notes cn on cn.booking_id = b.id where p.id = ${q(pay)}`))
          .toBe('partially_refunded|20000|partially_refunded|20000|true');
        expect((await fails(asUser(finA, `select public.request_refund(${q(pay)}, 90000, 'too much')`))).message).toMatch(/exceeds captured/);
      } finally {
        await asUser(admin, `select public.set_policy_status('refund', ${q(version)}, 'retired', 'IT cleanup')`);
      }
    });

    it('cancelling a sailing opens refund reviews but never refunds automatically', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('cxl');
      const bookingId = await individualBooking(user, out, 1);
      await payInSandbox(user, bookingId);
      expect(await asUser(ops, `select public.cancel_sailing(${q(out)}, 'Weather (fictional)')`)).toBe('1');
      expect(await owner(`select b.payment_status||'|'||r.status||'|'||(select count(*) from public.tickets t where t.booking_id = b.id and t.status = 'cancelled')
        from public.bookings b join public.refunds r on r.booking_id = b.id where b.id = ${q(bookingId)}`)).toBe('paid|pending_review|1');
    });
  });

  describe('minimum sailing and boarding', () => {
    it('counts qualifying tickets across bookings and keeps reservations separate', async () => {
      const { out } = await createSailingPair();
      const u1 = await createUser('min1'); const u2 = await createUser('min2');
      const b1 = await individualBooking(u1, out, 3);
      await payInSandbox(u1, b1);
      const b2 = await individualBooking(u2, out, 1);
      const before = await asUser(u1, `select reserved_tickets||'|'||qualifying_tickets||'|'||threshold_met||'|'||commercial_state from public.sailing_commercial_status(${q(out)})`);
      expect(before).toBe('4|3|false|awaiting_minimum');
      await payInSandbox(u2, b2);
      const after = await asUser(u1, `select qualifying_tickets||'|'||qualifying_revenue_halala||'|'||threshold_met||'|'||commercial_state from public.sailing_commercial_status(${q(out)})`);
      expect(after).toBe('4|200000|true|threshold_met');
      // Meeting the minimum does not open boarding.
      expect(await asUser(ops, `select public.sailing_boarding_gate(${q(out)})`)).toBe('not_ready');
    });

    it('gates boarding on payment and every checkpoint, and boards exactly once under concurrency', async () => {
      const { out } = await createSailingPair();
      const user = await createUser('board');
      const bookingId = await individualBooking(user, out, 1);
      const ref = await owner(`select reference from public.tickets where booking_id = ${q(bookingId)}`);
      const scan = () => asUser(boarder, `select public.board_ticket(${q(ref)}, ${q(out)})`);
      expect(await scan()).toBe('payment_required');
      await payInSandbox(user, bookingId);
      expect(await scan()).toBe('not_ready');
      await asUser(ops, `select public.set_sailing_readiness(${q(out)}, 'ready', 'IT')`);
      expect(await scan()).toBe('master_not_go');
      await asUser(ops, `select public.record_master_decision(${q(out)}, 'go', 'Capt. Fictional', 'IT')`);
      expect(await scan()).toBe('clearance_pending');
      await asUser(ops, `select public.record_port_clearance(${q(out)}, 'cleared', 'IT-1', 'IT')`);
      const results = await Promise.all([scan(), scan(), scan()]);
      expect(results.filter(r => r === 'boarded')).toHaveLength(1);
      expect(results.filter(r => r === 'already_boarded')).toHaveLength(2);
      expect((await fails(asUser(user, `select public.board_ticket(${q(ref)}, ${q(out)})`))).sqlState).toBe('42501');
    });

    it('suspension blocks booking and boarding; reschedule rotates ticket secrets', async () => {
      const a = await createSailingPair();
      const user = await createUser('resched');
      const bookingId = await individualBooking(user, a.out, 1);
      await payInSandbox(user, bookingId);
      const oldRef = await owner(`select reference from public.tickets where booking_id = ${q(bookingId)}`);
      // Another departure on the same route.
      const later = await owner(`insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
        select route_id, vessel_id, departs_at + interval '1 day', seat_capacity, 'open' from public.sailings where id = ${q(a.out)} returning id`);
      expect(await asUser(user, `select public.reschedule_booking_leg(${q(bookingId)}, 'outbound', ${q(later)}, 'Change of plan')`)).toBe('rescheduled');
      const newRef = await owner(`select reference from public.tickets where booking_id = ${q(bookingId)}`);
      expect(newRef).not.toBe(oldRef);
      expect(await owner(`select string_agg(seats_booked::text, ',' order by departs_at) from public.sailings where id in (${q(a.out)}, ${q(later)})`)).toBe('0,1');
      await clearSailing(ops, later);
      expect(await asUser(boarder, `select public.board_ticket(${q(oldRef)}, ${q(later)})`)).toBe('not_found');
      expect(await asUser(ops, `select public.suspend_sailing(${q(later)}, 'Weather hold (fictional)')`)).toBe('suspended');
      expect(await asUser(boarder, `select public.board_ticket(${q(newRef)}, ${q(later)})`)).toBe('sailing_suspended');
      const u2 = await createUser('susp');
      expect((await fails(individualBooking(u2, later, 1))).message).toMatch(/sailing_unavailable/);
      expect(await asUser(ops, `select public.resume_sailing(${q(later)}, 'Weather cleared')`)).toBe('resumed');
      expect(await asUser(boarder, `select public.board_ticket(${q(newRef)}, ${q(later)})`)).toBe('boarded');
    });
  });

  describe('settings and schedules', () => {
    it('only authorised roles change settings, with validation and audit', async () => {
      expect((await fails(asUser(ops, `select public.update_platform_setting('payments.mode', '{"value":"live"}', 'x')`))).sqlState).toBe('42501');
      expect((await fails(asUser(ops, `select public.update_platform_setting('sailing.minimum_tickets', '{"value": 0}', 'x')`))).sqlState).toBe('22023');
      expect(await asUser(ops, `select public.update_platform_setting('sailing.minimum_tickets', '{"value": 4}', 'IT reaffirm')`)).toBe('updated');
      expect(await owner(`select reason from public.config_audit where entity = 'platform_settings' and entity_id = 'sailing.minimum_tickets' order by id desc limit 1`)).toBe('IT reaffirm');
      expect((await fails(asUser(finA, `select public.update_platform_setting('seller.vat_number', '{"value":"123"}', 'x')`))).message).toMatch(/15 digits/);
      expect((await fails(asAnon(`select public.update_platform_setting('sailing.minimum_tickets', '{"value": 4}', 'x')`))).message).toMatch(/permission denied/);
    });

    it('generates sailings from Asia/Riyadh templates idempotently', async () => {
      const first = Number(await asUser(ops, `select public.generate_sailings(current_date + 20, current_date + 21)`));
      const second = Number(await asUser(ops, `select public.generate_sailings(current_date + 20, current_date + 21)`));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBe(0);
      const local = await owner(`select string_agg(distinct to_char(s.departs_at at time zone 'Asia/Riyadh', 'HH24:MI'), ',' order by to_char(s.departs_at at time zone 'Asia/Riyadh', 'HH24:MI'))
        from public.sailings s join public.routes r on r.id = s.route_id
        join public.vessels v on v.id = s.vessel_id and v.name = 'Provisional Taxi Vessel - pending ATCO confirmation'
        where r.origin = 'Ras Tanura Service Pier' and (s.departs_at at time zone 'Asia/Riyadh')::date = current_date + 20`);
      expect(local).toBe('07:00,09:30,13:00');
    });
  });

  describe('VAT-enabled tax invoices (ZATCA preparation, not compliance)', () => {
    it('database QR TLV matches the TypeScript encoder byte for byte', async () => {
      const db = await owner(`select public.zatca_qr_tlv('Fictional Seller LLC', '300000000000003', '2026-11-01T09:30:00Z', 115000, 15000)`);
      expect(db).toBe(encodeZatcaQr({ sellerName: 'Fictional Seller LLC', vatNumber: '300000000000003', timestamp: '2026-11-01T09:30:00Z', totalWithVat: '1150.00', vatTotal: '150.00' }));
    });

    it('issues a simplified tax invoice with VAT lines, QR and an unbroken hash chain once Finance configures VAT', async () => {
      const code = `IT-VAT-${randomUUID().slice(0, 6)}`;
      const tariff = await asUser(finA, `select public.publish_tariff(${q(code)}, 50000, 'exclusive', 1500, now() - interval '1 minute', null, 'IT VAT test', 'IT')`);
      await asUser(finB, `select public.approve_tariff(${q(tariff)}, 'IT')`);
      await asUser(admin, `select public.update_platform_setting('seller.legal_name', '{"value":"Fictional Seller LLC"}', 'IT')`);
      await asUser(admin, `select public.update_platform_setting('seller.vat_number', '{"value":"300000000000003"}', 'IT')`);
      try {
        const { out, back } = await createSailingPair();
        const user = await createUser('vat');
        const bookingId = await individualBooking(user, out, 1, back);
        expect(await owner(`select net_halala||'|'||vat_halala||'|'||total_halala||'|'||vat_mode from public.bookings where id = ${q(bookingId)}`)).toBe('100000|15000|115000|exclusive');
        await payInSandbox(user, bookingId);
        const row = await owner(`select document_type||'|'||net_halala||'|'||vat_halala||'|'||total_halala||'|'||(previous_hash = (select coalesce((select h from (select icv, invoice_hash h from public.invoices where icv < i.icv union all select icv, document_hash from public.credit_notes where icv < i.icv) d order by icv desc limit 1), public._zatca_initial_pih())))||'|'||qr_tlv
          from public.invoices i where booking_id = ${q(bookingId)}`);
        const [doc, net, vat, total, chained, qr] = row.split('|');
        expect([doc, net, vat, total, chained]).toEqual(['simplified_tax_invoice', '100000', '15000', '115000', 'true']);
        expect(decodeZatcaQr(qr)).toMatchObject({ 1: 'Fictional Seller LLC', 2: '300000000000003', 4: '1150.00', 5: '150.00' });
        expect(await owner(`select string_agg(l.net_halala||'/'||l.vat_halala||'/'||l.total_halala, ',' order by l.line_no) from public.invoice_lines l join public.invoices i on i.id = l.invoice_id where i.booking_id = ${q(bookingId)}`))
          .toBe('50000/7500/57500,50000/7500/57500');
      } finally {
        await asUser(finB, `select public.retire_tariff(${q(tariff)}, 'IT cleanup')`);
        await asUser(admin, `select public.update_platform_setting('seller.vat_number', '{"value":null}', 'IT cleanup')`);
        await asUser(admin, `select public.update_platform_setting('seller.legal_name', '{"value":null}', 'IT cleanup')`);
      }
    });
  });
});
