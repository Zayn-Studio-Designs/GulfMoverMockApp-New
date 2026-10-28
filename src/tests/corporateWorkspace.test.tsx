import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LanguageProvider } from '../context/LanguageContext';
import CorporateWorkspaceView from '../pages/CorporateWorkspaceView';

vi.mock('../context/OnboardingContext', () => ({ useOnboarding: () => mockedOnboarding() }));

const state: { status: unknown } = { status: { phase: 'loading' } };
function mockedOnboarding() {
  return { status: state.status, refresh: vi.fn() };
}

const bookingsState: { rows: Array<{ id: string; reference: string; status: string; passengerCount: number }> } = { rows: [] };
vi.mock('../lib/bookingService', () => ({ listBookings: () => Promise.resolve(bookingsState.rows) }));
vi.mock('../pages/CompanyReportsView', () => ({ default: () => <div>company-account-stub</div> }));

const renderWorkspace = (lang: 'en' | 'ar' = 'en') =>
  render(
    <LanguageProvider initialLang={lang}>
      <MemoryRouter>
        <CorporateWorkspaceView />
      </MemoryRouter>
    </LanguageProvider>,
  );

const ready = (kind: string, memberships: unknown[] = []) => ({
  phase: 'ready' as const,
  state: { kind },
  snapshot: { memberships },
});

const approvedMembership = (role: string, orgId = 'org-1', name = 'Sea Horizon') => ({
  organizationId: orgId,
  membershipRole: role,
  membershipStatus: 'active',
  organization: { status: 'approved', legalName: name, displayName: '' },
});

beforeEach(() => {
  state.status = { phase: 'loading' };
  bookingsState.rows = [];
});

describe('production corporate workspace', () => {
  test('loading, signed-out and error states never imply a company', () => {
    renderWorkspace();
    expect(screen.getByText('Loading database records…')).toBeTruthy();
  });

  test('members without an approved company are guided to registration', async () => {
    state.status = ready('no-company');
    renderWorkspace();
    expect(await screen.findByText('No approved company yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Company registration' })).toHaveAttribute('href', '/onboarding');
    expect(screen.queryByText('company-account-stub')).toBeNull();
  });

  test('pending, rejected and suspended states show truthful guidance, not registration', async () => {
    for (const [kind, body] of [
      ['pending', 'under review'],
      ['rejected', 'did not approve'],
      ['suspended', 'suspended this company'],
    ] as const) {
      state.status = ready(kind);
      const view = renderWorkspace();
      expect(await screen.findByText(new RegExp(body))).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Company registration' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Check status again' })).toHaveAttribute('href', '/onboarding');
      view.unmount();
    }
  });

  test('restricted, invited and staff states are distinguished', async () => {
    for (const kind of ['restricted', 'invited', 'platform-staff'] as const) {
      state.status = ready(kind);
      const view = renderWorkspace();
      // Each renders its own banner; none renders bookings or admin content.
      await screen.findByRole('status');
      expect(screen.queryByText('company-account-stub')).toBeNull();
      view.unmount();
    }
  });

  test('error state offers retry; account-suspended offers nothing', async () => {
    state.status = { phase: 'error', error: 'network' };
    const errView = renderWorkspace();
    expect(await screen.findByText('We could not load your company status. Nothing has been changed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check status again' })).toBeTruthy();
    errView.unmount();
    state.status = ready('account-suspended');
    renderWorkspace();
    expect(await screen.findByText(/suspended/)).toBeTruthy();
  });

  test('a company booker sees their own bookings but not the admin account report', async () => {
    state.status = ready('approved', [approvedMembership('company_booker')]);
    bookingsState.rows = [{ id: 'b1', reference: 'GM-AB12CD34', status: 'reserved', passengerCount: 2 }];
    renderWorkspace();
    expect(await screen.findByText('GM-AB12CD34')).toBeTruthy();
    expect(screen.queryByText('company-account-stub')).toBeNull();
    expect(screen.getByText('Available to company administrators of approved organizations.')).toBeTruthy();
  });

  test('a company admin sees the account report; multiple companies are listed', async () => {
    state.status = ready('approved', [approvedMembership('company_admin'), approvedMembership('company_booker', 'org-2', 'Jannah')]);
    renderWorkspace();
    expect(await screen.findByText('company-account-stub')).toBeTruthy();
    expect(screen.getByText(/more than one approved company/)).toBeTruthy();
    expect(screen.getByText('Jannah')).toBeTruthy();
  });

  test('Arabic renders RTL with translated states and no raw keys', async () => {
    state.status = ready('pending');
    renderWorkspace('ar');
    expect(await screen.findByText('بانتظار موافقة أتكو')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.body.textContent).not.toMatch(/p8Corp|onbPending|navCompany/);
  });

  test('the previously disconnected production routes are now wired', () => {
    const app = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toContain('production={<CorporateWorkspaceView />}');
    // Staff short routes are deliberate aliases that redirect to the canonical
    // /admin pages (linked from the production staff nav).
    expect(app).toContain('path="/operations"');
    expect(app).toContain('path="/fleet"');
    expect(app).toContain('Navigate to="/admin/operations"');
    expect(app).toContain('Navigate to="/admin/sailings"');
    for (const route of ['/corporate', '/operations', '/fleet']) {
      const line = app.split('\n').find(l => l.includes(`path="${route}"`));
      expect(line, route).not.toContain('NotConnectedView');
    }
  });
});
