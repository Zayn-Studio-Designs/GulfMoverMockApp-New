import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from './helpers/fakeSupabase';
import { boardTicket, getTicketManifest, getTicketQr, listBookingTickets, listReadinessEvents, setSailingReadiness, validTicketLookup } from '../lib/ticketService';
import { I18N } from '../i18n/translations';
vi.mock('@supabase/supabase-js', async () => (await import('./helpers/fakeSupabase')).fakeSupabaseModule);
const ID = '11111111-1111-4111-8111-111111111111';
const REF = 'TK-' + 'A'.repeat(24); const QR = 'GMT1:' + 'a'.repeat(64);
const ticket = { id: ID, reference: REF, booking_id: ID, sailing_id: ID, passenger_index: 2, passenger_name: null, status: 'valid', boarded_at: null };
const ok = (data: unknown) => ({ data, error: null, status: 200 });
beforeEach(() => {
  fake.reset(); vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://fictional.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'synthetic-public-key');
});
import { afterEach } from 'vitest';
afterEach(() => vi.unstubAllEnvs());
describe('ticket service (offline mock, not RLS proof)', () => {
  it('lists persisted ticket fields, preserves uncollected names and never selects QR secrets', async () => {
    fake.tables.tickets = ok([ticket]);
    expect(await listBookingTickets(ID)).toEqual([expect.objectContaining({ passengerName: null, status: 'valid', sailingId: ID })]);
    expect(fake.queries[0].filters).toContainEqual(['eq','booking_id',ID]);
    expect(fake.queries[0].select).not.toMatch(/qr_token|created_by/);
  });
  it('requires a valid id before querying', async () => {
    await expect(listBookingTickets('bad')).rejects.toMatchObject({ kind: 'invalid-input' });
    expect(fake.queries).toHaveLength(0);
  });
  it('never falls back to demo or calls an RPC when signed out', async () => {
    vi.stubEnv('VITE_APP_MODE', 'demo'); await expect(getTicketQr(ID)).rejects.toMatchObject({ kind: 'unavailable' });
    vi.stubEnv('VITE_APP_MODE', 'production'); fake.session = null;
    await expect(boardTicket(REF, ID)).rejects.toMatchObject({ kind: 'not-authenticated' });
    expect(fake.rpc).not.toHaveBeenCalled();
  });
  it('retrieves only a well-formed opaque QR via the owner RPC', async () => {
    fake.rpc.mockResolvedValueOnce(ok(QR)); expect(await getTicketQr(ID)).toBe(QR);
    expect(fake.rpc).toHaveBeenCalledWith('get_ticket_qr', { p_ticket_id: ID });
    fake.rpc.mockResolvedValueOnce(ok('name@example.test')); await expect(getTicketQr(ID)).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
  it.each(['boarded','already_boarded','not_found','wrong_sailing','cancelled','sailing_cancelled','not_ready'] as const)('uses the authoritative boarding outcome %s', async outcome => {
    fake.rpc.mockResolvedValueOnce(ok(outcome)); expect(await boardTicket(` ${QR} `, ID)).toBe(outcome);
    expect(fake.rpc).toHaveBeenCalledWith('board_ticket', { p_code: QR, p_sailing_id: ID });
    expect(fake.writes).toEqual([]); expect(fake.writeAttempts).toEqual([]);
  });
  it('rejects malformed/manual booking references locally, and never accepts arbitrary server success', async () => {
    for (const bad of ['', 'GM-ABCDEF12', 'GMT1:abc', 'name@example.test', 'TK-' + 'A'.repeat(23)]) {
      expect(validTicketLookup(bad)).toBe(false); await expect(boardTicket(bad, ID)).rejects.toMatchObject({ kind: 'invalid-input' });
    }
    expect(fake.rpc).not.toHaveBeenCalled(); fake.rpc.mockResolvedValueOnce(ok('paid'));
    await expect(boardTicket(REF, ID)).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
  it('maps errors without exposing the supplied code or database detail', async () => {
    fake.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: `secret internal ${QR}` }, status: 403 });
    const error = await boardTicket(REF, ID).catch(e => e); expect(error.kind).toBe('forbidden'); expect(error.message).not.toContain(QR);
  });
  it('parses the restricted staff manifest contract and rejects malformed rows', async () => {
    fake.rpc.mockResolvedValueOnce(ok([{ ...ticket, ticket_id: ID, booking_reference: 'GM-12345678', leg: 'return' }]));
    expect(await getTicketManifest(ID)).toEqual([expect.objectContaining({ leg: 'return', passengerName: null, bookingReference: 'GM-12345678' })]);
    fake.rpc.mockResolvedValueOnce(ok([{ status: 'paid' }])); await expect(getTicketManifest(ID)).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
  it('requires a bounded reason and an explicit supported readiness status, sends no forged actor', async () => {
    await expect(setSailingReadiness(ID,'ready','  ')).rejects.toMatchObject({ kind: 'invalid-input' });
    await expect(setSailingReadiness(ID,'ready','a'.repeat(501))).rejects.toMatchObject({ kind: 'invalid-input' });
    expect(fake.rpc).not.toHaveBeenCalled(); fake.rpc.mockResolvedValueOnce(ok('recorded'));
    expect(await setSailingReadiness(ID,'ready',' Reviewed internally ')).toBe('recorded');
    expect(fake.rpc).toHaveBeenCalledWith('set_sailing_readiness', { p_sailing_id: ID, p_status: 'ready', p_reason: 'Reviewed internally' });
  });
  it('loads restricted readiness audit fields and handles malformed data safely', async () => {
    fake.tables.sailing_readiness_events = ok([{ id: ID, status: 'blocked', reason: 'Review', occurred_at: '2026-10-28T00:00:00Z' }]);
    expect(await listReadinessEvents(ID)).toEqual([{ id: ID, status: 'blocked', reason: 'Review', occurredAt: '2026-10-28T00:00:00Z' }]);
    fake.tables.tickets = ok(null); await expect(listBookingTickets(ID)).rejects.toMatchObject({ kind: 'unexpected-response' });
  });
  it('has explicit Arabic copy for all new visible messages', () => {
    for (const key of Object.keys(I18N.en).filter(k => k.startsWith('p4'))) {
      expect(I18N.ar[key], key).toBeTruthy(); expect(I18N.ar[key], key).not.toBe(I18N.en[key]);
    }
  });
});
