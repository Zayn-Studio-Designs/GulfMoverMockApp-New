import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppProviders, AppRoutes } from '../App';
import { markTourSeen } from '../components/Tour';
import { fake } from './helpers/fakeSupabase';

/**
 * Phase 10.1 — the rewired production routes (`/operations`, `/fleet`)
 * redirect to the canonical staff pages and render the real guarded
 * staff components:
 * - a customer (no platform roles) gets the staff-only refusal and no
 *   admin query is issued;
 * - an operations staffer gets the real screens (vessels/sailings control).
 * Auth service mocked; data layer is the in-memory Supabase fake.
 */
const svc = vi.hoisted(() => ({
  signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), getSession: vi.fn(), onAuthStateChange: vi.fn(),
  requestPasswordReset: vi.fn(), updatePassword: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('../lib/authService', () => {
  class AuthNotAvailableError extends Error {}
  class AuthOperationError extends Error {
    readonly code: string | null = null;
    readonly status: number | null = null;
  }
  class AuthInputError extends Error {}
  return { ...svc, AuthNotAvailableError, AuthOperationError, AuthInputError, SESSION_MISSING_CODE: 'session_missing' };
});
vi.mock('@supabase/supabase-js', async () => (await import('./helpers/fakeSupabase')).fakeSupabaseModule);

const session = { user: { id: 'u-ops', email: 'ops@example.test', user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' } } as unknown as Session;
const ok = (data: unknown) => ({ data, error: null, status: 200 });

const renderApp = (route: string) =>
  render(<AppProviders><MemoryRouter initialEntries={[route]}><AppRoutes /></MemoryRouter></AppProviders>);

const asOps = () => {
  fake.tables.role_assignments = ok([{ role: 'operations', status: 'active' }]);
};
const asCustomer = () => {
  fake.tables.role_assignments = ok([]);
  fake.setMemberships([{ orgId: 'org-1', org: { legalName: 'Approved Co', status: 'approved' } }]);
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  svc.getSession.mockResolvedValue(session);
  fake.reset();
  markTourSeen('u-ops');
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://rewire-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'rewire-publishable-key');
});

describe('rewired production routes', () => {
  test('/operations refuses customers without issuing admin queries', async () => {
    asCustomer();
    renderApp('/operations');
    expect(await screen.findByRole('heading', { name: 'ATCO staff access required' })).toBeTruthy();
    expect(fake.queries.some(q => ['vessels', 'routes', 'sailings'].includes(q.table))).toBe(false);
  });

  test('/operations serves the vessels/sailings screen to operations staff', async () => {
    asOps();
    renderApp('/operations');
    expect(await screen.findByRole('heading', { name: 'Vessels and sailings' })).toBeTruthy();
  });

  test('/fleet serves sailing control to operations staff', async () => {
    asOps();
    renderApp('/fleet');
    expect(await screen.findByRole('heading', { name: 'Sailing control' })).toBeTruthy();
  });

  test('/fleet refuses customers (StaffKit guard) with no control actions', async () => {
    asCustomer();
    renderApp('/fleet');
    // SailingControlView guards with the StaffKit RequireRoles variant, whose
    // refusal text differs from the ProductionUi guard used by /operations.
    // NOTE: its data loaders fire before the guard (unlike AdminOperationsView
    // where hooks sit inside the guarded child); the RLS boundary — not the
    // UI — is what protects the rows, consistent with the rest of the app.
    expect(await screen.findByRole('alert')).toHaveTextContent('Your account does not have access to this page.');
    expect(screen.queryByRole('button', { name: /Mark ready|Generate sailings/ })).toBeNull();
  });
});
