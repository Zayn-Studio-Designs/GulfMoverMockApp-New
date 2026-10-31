// N+1 regression tests: list pages must fetch per-row status in ONE batch request,
// never one (or two) extra request(s) per row. Counted at the Supabase client boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppProviders, AppRoutes } from '../App';
import { markTourSeen } from '../components/Tour';
import { SAILING_STATUS_BATCH, sailingControlStatus } from '../lib/phase8Service';
import { fake, fakeClient, type FakeResponse } from './helpers/fakeSupabase';

const svc = vi.hoisted(() => ({
  signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), getSession: vi.fn(), onAuthStateChange: vi.fn(),
  requestPasswordReset: vi.fn(), updatePassword: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('../lib/authService', () => {
  class AuthNotAvailableError extends Error {}
  class AuthOperationError extends Error { readonly code: string | null = null; readonly status: number | null = null; }
  class AuthInputError extends Error {}
  return { ...svc, AuthNotAvailableError, AuthOperationError, AuthInputError, SESSION_MISSING_CODE: 'session_missing' };
});
vi.mock('@supabase/supabase-js', async () => (await import('./helpers/fakeSupabase')).fakeSupabaseModule);

const USER_ID = 'ops-user-1';
const session = { user: { id: USER_ID, email: 'ops@example.test', user_metadata: { display_name: 'Ops' }, created_at: '2026-01-01T00:00:00.000Z' } } as unknown as Session;
const ok = (data: unknown): FakeResponse => ({ data, error: null, status: 200 });
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const renderApp = (path: string) => render(<AppProviders><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></AppProviders>);

/** A status row as `sailing_control_status` returns it; sailing #0 has met the minimum. */
const statusRow = (id: string, met: boolean) => ({
  sailing_id: id, reserved_tickets: met ? 4 : 1, qualifying_tickets: met ? 4 : 1, qualifying_revenue_halala: met ? 200000 : 50000,
  threshold_tickets: 4, threshold_revenue_halala: 200000, threshold_met: met, confirmation_deadline: inHours(6),
  commercial_state: met ? 'threshold_met' : 'awaiting_minimum', counting_basis: 'paid_and_on_account', boarding_gate: 'not_ready',
});
const callsTo = (fn: string) => fakeClient.rpc.mock.calls.filter(([name]) => name === fn);

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  Object.values(svc).forEach(fn => fn.mockReset());
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  svc.getSession.mockResolvedValue(session);
  fake.reset();
  fake.session = session as never;
  markTourSeen(USER_ID);
  fake.tables.role_assignments = ok([{ role: 'operations', status: 'active' }]);
  fake.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => fn === 'sailing_control_status'
    ? ok((args.p_sailing_ids as string[]).map((id, i) => statusRow(id, i === 0)))
    : { data: null, error: { message: `unexpected rpc ${fn}`, code: 'TEST' }, status: 500 });
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://n-plus-one.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'n-plus-one-publishable-key');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('Sailing Control page', () => {
  it('loads status for 40 sailings with ONE batch request (was 80 extra requests)', async () => {
    const sailings = Array.from({ length: 40 }, (_, i) => ({
      id: `s-${i}`, departs_at: inHours(24 + i), status: 'open', seat_capacity: 12, seats_booked: i % 5, readiness_status: 'pending',
      master_decision: 'pending', port_clearance_status: 'pending', commercial_decision: 'none', payload_capacity_kg: null, payload_booked_kg: 0,
      route: { origin: 'Test Pier', destination: 'Test Anchorage' }, vessel: { name: 'Test Vessel' },
    }));
    fake.tables.sailings = ok(sailings);
    fake.tables.schedule_templates = ok([]);
    renderApp('/admin/sailings');
    expect(await screen.findByText('Minimum met')).toBeInTheDocument();
    expect(await screen.findAllByText('Awaiting minimum')).toHaveLength(39);
    expect(callsTo('sailing_control_status')).toHaveLength(1);
    expect(callsTo('sailing_control_status')[0][1]).toEqual({ p_sailing_ids: sailings.map(s => s.id) });
    expect(callsTo('sailing_commercial_status')).toHaveLength(0);
    expect(callsTo('sailing_boarding_gate')).toHaveLength(0);
  });
});

describe('booking detail page', () => {
  it('loads both legs\' minimum status and gate with ONE request (was 4)', async () => {
    fake.setMemberships([{ orgId: 'org-1', org: { legalName: 'Approved Co LLC', status: 'approved' } }]);
    fake.tables.role_assignments = ok([]);
    const leg = (leg: string, id: string, h: number) => ({ leg, passengers: 2, sailing: { id, departs_at: inHours(h), status: 'open', route: { origin: 'A', destination: 'B' }, vessel: { name: 'V' } } });
    fake.tables.bookings = ok({
      id: '11111111-1111-4111-8111-111111111111', reference: 'GM-1A2B3C4D', status: 'reserved', payment_status: 'unpaid', passenger_count: 2,
      contact_name: 'Sara', contact_email: 'sara@example.test', contact_phone: '+966130000000', passenger_names: ['Sara'], po_reference: null,
      organization_id: 'org-1', created_at: inHours(-1), settlement_mode: 'pay_now', account_type: 'corporate', net_halala: 200000, vat_halala: 0,
      total_halala: 200000, vat_mode: 'not_configured', tariff_status: 'provisional', hold_expires_at: inHours(0.5), client_name: null,
      terms_version: 'v1', cancel_reason: null, booking_legs: [leg('outbound', 's-out', 30), leg('return', 's-back', 34)],
    });
    renderApp('/bookings/GM-1A2B3C4D');
    expect((await screen.findAllByText('Awaiting operations readiness')).length).toBe(2);
    expect(callsTo('sailing_control_status')).toHaveLength(1);
    expect(callsTo('sailing_control_status')[0][1]).toEqual({ p_sailing_ids: ['s-out', 's-back'] });
    expect(callsTo('sailing_commercial_status')).toHaveLength(0);
    expect(callsTo('sailing_boarding_gate')).toHaveLength(0);
  });
});

describe('sailingControlStatus batching', () => {
  it('makes no request for an empty list, de-duplicates ids, and splits only at the 500-id limit', async () => {
    fake.session = session as never;
    expect((await sailingControlStatus([])).size).toBe(0);
    expect(callsTo('sailing_control_status')).toHaveLength(0);

    const ids = Array.from({ length: 1200 }, (_, i) => `s-${i}`);
    const result = await sailingControlStatus([...ids, 's-0', 's-1']);
    expect(result.size).toBe(1200);
    expect(callsTo('sailing_control_status').map(([, a]) => (a as { p_sailing_ids: string[] }).p_sailing_ids.length))
      .toEqual([SAILING_STATUS_BATCH, SAILING_STATUS_BATCH, 200]);
    expect(result.get('s-0')?.commercial.state).toBe('threshold_met');
    expect(result.get('s-7')?.gate).toBe('not_ready');
  });
});
