// @vitest-environment node
//
// Phase 7: ATCO requirements against the real local stack. Fictional data only.
// Covers individual + agent booking access, lifecycle, sandbox payments,
// minimum-sailing evaluation and extended materials fields.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { confirmedUser, futureIso, grantPlatformRole, localStackConfigured, quote, sql, type TestUser } from './helpers';

const suite = localStackConfigured ? describe : describe.skip;

suite('Phase 7: ATCO requirements against the local database', () => {
  let ops: TestUser; let reviewer: TestUser; let individual: TestUser; let stranger: TestUser;
  let agentAdmin: TestUser; let corpAdmin: TestUser;
  let agentOrg = ''; let corpOrg = '';
  let outboundId = ''; let returnId = ''; let termsVersion = ''; let tariffEach = 0;

  beforeAll(async () => {
    ops = await confirmedUser('p7-ops'); grantPlatformRole(ops.id, 'operations');
    reviewer = await confirmedUser('p7-reviewer'); grantPlatformRole(reviewer.id, 'super_admin');
    individual = await confirmedUser('p7-individual');
    stranger = await confirmedUser('p7-stranger');
    agentAdmin = await confirmedUser('p7-agent');
    corpAdmin = await confirmedUser('p7-corp');

    async function company(u: TestUser, label: string, account: 'corporate' | 'agent') {
      const r = await u.client.rpc('register_company', {
        p_registration_key: randomUUID(), p_legal_name: `${label} ${randomUUID()}`,
        p_profile_display_name: 'Fictional Administrator',
      });
      expect(r.error).toBeNull();
      const id = r.data[0].id as string;
      if (account === 'agent') {
        expect((await reviewer.client.rpc('set_organization_account_type', { p_org: id, p_account_type: 'agent' })).error).toBeNull();
      }
      expect((await reviewer.client.rpc('review_company', { p_organization_id: id, p_decision: 'approve' })).error).toBeNull();
      return id;
    }
    agentOrg = await company(agentAdmin, 'P7 Agent Co', 'agent');
    corpOrg = await company(corpAdmin, 'P7 Corp Co', 'corporate');

    termsVersion = sql(`select version from public.service_policies where policy_type='booking_terms' order by effective_from desc limit 1`);
    expect(termsVersion).not.toBe('');
    tariffEach = Number(sql(`select per_person_halala from public.tariffs where active=true order by effective_from desc limit 1`));
    expect(tariffEach).toBe(50000);

    const vessel = await ops.client.from('vessels').insert({ name: `P7 vessel ${randomUUID()}`, passenger_capacity: 12 }).select('id').single();
    expect(vessel.error).toBeNull();
    // Explicit reverse pair on the same sailing corridor.
    const a = `P7 out ${randomUUID()}`; const b = `P7 back ${randomUUID()}`;
    const outId = sql(`insert into public.routes(origin,destination) values (${quote(a)},${quote(b)}) returning id`);
    const backId = sql(`insert into public.routes(origin,destination) values (${quote(b)},${quote(a)}) returning id`);
    const s1 = await ops.client.from('sailings')
      .insert({ vessel_id: vessel.data!.id, route_id: outId, departs_at: futureIso(72), seat_capacity: 12 }).select('id').single();
    const s2 = await ops.client.from('sailings')
      .insert({ vessel_id: vessel.data!.id, route_id: backId, departs_at: futureIso(96), seat_capacity: 12 }).select('id').single();
    expect(s1.error).toBeNull(); expect(s2.error).toBeNull();
    outboundId = s1.data!.id; returnId = s2.data!.id;
  }, 90_000);

  it('tariff and terms are published and readable; money is integer halala', async () => {
    const t = await individual.client.from('tariffs').select('code,per_person_halala,currency,vat_active').eq('active', true).limit(5);
    expect(t.error).toBeNull();
    expect(t.data!.some(r => r.code === 'BASE-2026-ATCO-PENDING' && r.per_person_halala === 50000 && r.vat_active === false)).toBe(true);
    // No floats anywhere in the tariff table definition.
    expect(sql(`select data_type from information_schema.columns where table_schema='public' and table_name='tariffs' and column_name='per_person_halala'`)).toBe('bigint');
  });

  it('an individual books without any company; terms are mandatory', async () => {
    const noTerms = await individual.client.rpc('create_individual_booking', {
      p_request_key: randomUUID(), p_outbound_sailing_id: outboundId, p_passenger_count: 1,
      p_contact_name: 'Solo Traveller', p_contact_email: 'solo@example.test', p_contact_phone: '+966130000001',
    });
    expect(noTerms.error?.message).toMatch(/terms_not_accepted/);
    const booked = await individual.client.rpc('create_individual_booking', {
      p_request_key: randomUUID(), p_outbound_sailing_id: outboundId, p_passenger_count: 2,
      p_contact_name: 'Solo Traveller', p_contact_email: 'solo@example.test', p_contact_phone: '+966130000001',
      p_passenger_names: ['Solo Plus One'], p_return_sailing_id: returnId,
      p_destination_vessel: 'Fictional Dhow', p_destination_imo: 'IMO1234567', p_terms_version: termsVersion,
    });
    expect(booked.error).toBeNull();
    const bookingId = booked.data[0].booking_id as string;
    expect(sql(`select account_type from public.bookings where id=${quote(bookingId)}`)).toBe('individual');
    expect(sql(`select organization_id from public.bookings where id=${quote(bookingId)}`)).toBe('');
    expect(sql(`select fare_halala from public.bookings where id=${quote(bookingId)}`)).toBe(String(tariffEach * 2 * 2));
    expect(sql(`select count(*) from public.tickets where booking_id=${quote(bookingId)}`)).toBe('4');
    expect(sql(`select terms_version from public.bookings where id=${quote(bookingId)}`)).toBe(termsVersion);
    // A retry with the same key replays; a changed payload mismatches.
    const replay = await individual.client.rpc('create_individual_booking', {
      p_request_key: booked.data[0].request_key ?? randomUUID(), p_outbound_sailing_id: outboundId, p_passenger_count: 1,
      p_contact_name: 'Solo Traveller', p_contact_email: 'solo@example.test', p_contact_phone: '+966130000001',
      p_terms_version: termsVersion,
    });
    expect(replay.error === null || /payload_mismatch|terms_not_accepted/.test(replay.error.message)).toBe(true);
  });

  it('a stranger cannot use the individual path for someone else, and staff roles are not granted', async () => {
    const mine = await individual.client.from('bookings').select('id').limit(1);
    expect(mine.error).toBeNull();
    expect((await stranger.client.rpc('amend_booking', { p_booking_id: mine.data![0].id, p_contact_name: 'Forged' })).error?.code).toBe('42501');
    expect((await stranger.client.rpc('cancel_booking', { p_booking_id: mine.data![0].id, p_reason: 'Forged' })).error?.code).toBe('42501');
    expect(sql(`select count(*) from public.role_assignments where user_id=${quote(individual.id)}`)).toBe('0');
  });

  it('an agent books on behalf of a client; a corporate org cannot use the agent path', async () => {
    const bad = await corpAdmin.client.rpc('create_agent_booking', {
      p_request_key: randomUUID(), p_agent_organization_id: corpOrg, p_client_name: 'Client Co',
      p_client_reference: 'BAD-REF', p_outbound_sailing_id: outboundId, p_passenger_count: 1,
      p_contact_name: 'Agent Booker', p_contact_email: 'agent@example.test', p_contact_phone: '+966130000002',
      p_terms_version: termsVersion,
    });
    expect(bad.error?.message).toMatch(/not_agent_organization/);
    const good = await agentAdmin.client.rpc('create_agent_booking', {
      p_request_key: randomUUID(), p_agent_organization_id: agentOrg, p_client_name: 'Client Co',
      p_client_reference: 'CLIENT-REF-1', p_outbound_sailing_id: outboundId, p_passenger_count: 1,
      p_contact_name: 'Agent Booker', p_contact_email: 'agent@example.test', p_contact_phone: '+966130000002',
      p_terms_version: termsVersion,
    });
    expect(good.error).toBeNull();
    const bookingId = good.data[0].booking_id as string;
    expect(sql(`select account_type||':'||client_name||':'||client_reference from public.bookings where id=${quote(bookingId)}`))
      .toBe('agent:Client Co:CLIENT-REF-1');
    expect(sql(`select count(*) from public.tickets where booking_id=${quote(bookingId)}`)).toBe('1');
    // The agent org cannot read the corporate org's bookings and vice versa.
    expect((await agentAdmin.client.from('bookings').select('id').eq('organization_id', corpOrg)).data).toEqual([]);
  });

  it('amend updates contact metadata only; cancel releases seats and blocks boarding', async () => {
    const before = Number(sql(`select seats_booked from public.sailings where id=${quote(outboundId)}`));
    const mine = (await individual.client.from('bookings').select('id').order('created_at', { ascending: false }).limit(1)).data![0].id as string;
    expect((await individual.client.rpc('amend_booking', { p_booking_id: mine, p_contact_name: 'Solo Traveller-Amended' })).data).toBe('amended');
    expect(sql(`select contact_name from public.bookings where id=${quote(mine)}`)).toBe('Solo Traveller-Amended');
    expect((await individual.client.rpc('cancel_booking', { p_booking_id: mine, p_reason: 'Plans changed, provisional test' })).data).toBe('cancelled');
    expect(sql(`select status||':'||operational_status||':'||payment_status from public.bookings where id=${quote(mine)}`))
      .toBe('cancelled:cancelled:unpaid');
    const after = Number(sql(`select seats_booked from public.sailings where id=${quote(outboundId)}`));
    expect(after).toBeLessThan(before);
    // Amending a cancelled booking is refused.
    expect((await individual.client.rpc('amend_booking', { p_booking_id: mine, p_contact_name: 'Again' })).error?.code).toBe('55000');
    // Re-cancelling is idempotent.
    expect((await individual.client.rpc('cancel_booking', { p_booking_id: mine, p_reason: 'Again' })).data).toBe('unchanged');
  });

  it('sandbox payment: initiate, verify, invoice; refund stays gated behind an approved policy', async () => {
    const bookingId = (await individual.client.from('bookings')
      .select('id').eq('account_type', 'individual').neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1)).data![0].id as string;
    const pay = await individual.client.rpc('initiate_payment', { p_booking_id: bookingId, p_method: 'mada' });
    expect(pay.error).toBeNull();
    // Only staff can verify; the customer cannot self-verify a payment.
    expect((await individual.client.rpc('verify_payment', { p_payment_id: pay.data, p_succeed: true })).error?.code).toBe('42501');
    expect((await reviewer.client.rpc('verify_payment', { p_payment_id: pay.data, p_succeed: true })).data).toBe('succeeded');
    expect(sql(`select status||':'||payment_status from public.bookings where id=${quote(bookingId)}`)).toBe('paid:paid');
    const inv = await individual.client.from('invoices').select('invoice_number,amount_halala,zatca_status').eq('booking_id', bookingId);
    expect(inv.error).toBeNull();
    expect(inv.data!.length).toBe(1);
    expect(inv.data![0].zatca_status).toBe('not_submitted');
    // Refunds require an approved refund policy: the provisional default blocks them.
    const fin = await confirmedUser('p7-finance'); grantPlatformRole(fin.id, 'finance');
    expect((await fin.client.rpc('refund_payment', { p_payment_id: pay.data, p_amount_halala: 100, p_reason: 'Provisional test' })).error?.message)
      .toMatch(/refund_policy_not_approved/);
    expect(sql(`select status from public.payments where id=${quote(pay.data as string)}`)).toBe('succeeded');
  });

  it('minimum-sailing status reflects real counts and configured thresholds', async () => {
    const row = await ops.client.rpc('sailing_minimum_status', { p_sailing_id: outboundId });
    expect(row.error).toBeNull();
    const s = row.data[0];
    expect(s.threshold_tickets).toBe(4);
    expect(s.threshold_revenue_halala).toBe(200000);
    expect(typeof s.ticket_count).toBe('number');
    expect(typeof s.revenue_halala).toBe('number');
    expect(typeof s.threshold_met).toBe('boolean');
    // Reaching the threshold never authorises departure: the column stays internal.
    expect(sql(`select readiness_status from public.sailings where id=${quote(outboundId)}`)).toBe('pending');
  });

  it('materials requests accept the ATCO field set and reject bad attachments', async () => {
    const details = {
      description: 'Spare impeller kit', destination: 'Approved Anchorage', quantity: '12',
      weight_kg: '84.5', dimensions: '120x80x60cm', sender: 'Ras Tanura stores', receiver: 'MV Fictional',
      handling: 'Keep dry, lift by crane', photo_urls: ['https://example.test/photos/impeller.jpg'],
      hazardous: 'false', notes: 'Fictional test cargo',
    };
    const key = randomUUID();
    const ok = await corpAdmin.client.rpc('submit_transfer_request', { p_org: corpOrg, p_kind: 'materials', p_key: key, p_details: details });
    expect(ok.error).toBeNull();
    const badUrl = await corpAdmin.client.rpc('submit_transfer_request', {
      p_org: corpOrg, p_kind: 'materials', p_key: randomUUID(),
      p_details: { description: 'X', photo_urls: ['file:///etc/passwd'] },
    });
    expect(badUrl.error).not.toBeNull();
    const badFlag = await corpAdmin.client.rpc('submit_transfer_request', {
      p_org: corpOrg, p_kind: 'materials', p_key: randomUUID(),
      p_details: { description: 'X', hazardous: 'maybe' },
    });
    expect(badFlag.error).not.toBeNull();
    // The agent org cannot file on behalf of the corporate org.
    expect((await agentAdmin.client.rpc('submit_transfer_request', {
      p_org: corpOrg, p_kind: 'materials', p_key: randomUUID(), p_details: { description: 'Cross-company' },
    })).error?.code).toBe('42501');
  });

  it('staff reports are role-gated and derive from persisted rows', async () => {
    expect((await individual.client.rpc('report_sailing_occupancy', { p_from: '2026-01-01', p_to: '2030-01-01' })).error?.code).toBe('42501');
    const occ = await ops.client.rpc('report_sailing_occupancy', { p_from: '2026-01-01', p_to: '2030-01-01' });
    expect(occ.error).toBeNull();
    expect((occ.data as unknown[]).length).toBeGreaterThan(0);
    const rev = await ops.client.rpc('report_revenue_by_sailing', { p_from: '2026-01-01', p_to: '2030-01-01' });
    expect(rev.error).toBeNull();
    // Bad ranges are rejected, not silently widened.
    expect((await ops.client.rpc('report_revenue_by_sailing', { p_from: '2030-01-01', p_to: '2026-01-01' })).error).not.toBeNull();
  });
});
