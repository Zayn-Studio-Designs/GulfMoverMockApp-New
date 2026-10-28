import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LanguageProvider } from '../context/LanguageContext';
import CorporateWorkspaceView from '../pages/CorporateWorkspaceView';

vi.mock('../context/OnboardingContext', () => ({ useOnboarding: () => mockedOnboarding() }));

const state = {
  status: { phase: 'ready' as const, snapshot: { memberships: [] as unknown[] } },
  bookings: [] as Array<{ id: string; reference: string; status: string; passengerCount: number }>,
};

function mockedOnboarding() {
  return { status: state.status };
}

vi.mock('../lib/bookingService', () => ({ listBookings: () => Promise.resolve(state.bookings) }));
vi.mock('../pages/CompanyReportsView', () => ({ default: () => <div>company-account-stub</div> }));

const renderWorkspace = () =>
  render(
    <LanguageProvider>
      <MemoryRouter>
        <CorporateWorkspaceView />
      </MemoryRouter>
    </LanguageProvider>,
  );

const approvedMembership = (role: string) => ({
  membershipRole: role,
  membershipStatus: 'active',
  organization: { status: 'approved', legalName: 'Sea Horizon', displayName: '' },
});

beforeEach(() => {
  state.status = { phase: 'ready' as const, snapshot: { memberships: [] as unknown[] } };
  state.bookings = [];
});

describe('production corporate workspace', () => {
  test('members without an approved company are guided to registration', async () => {
    renderWorkspace();
    expect(await screen.findByText('No approved company yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Company registration' })).toHaveAttribute('href', '/onboarding');
  });

  test('a company booker sees their own bookings but not the admin account report', async () => {
    state.status = {
      phase: 'ready' as const,
      snapshot: { memberships: [approvedMembership('company_booker')] as unknown[] },
    };
    state.bookings = [{ id: 'b1', reference: 'GM-AB12CD34', status: 'reserved', passengerCount: 2 }];
    renderWorkspace();
    expect(await screen.findByText('GM-AB12CD34')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open booking' })).toHaveAttribute('href', '/bookings/GM-AB12CD34');
    expect(screen.queryByText('company-account-stub')).toBeNull();
    expect(screen.getByText('Available to company administrators of approved organizations.')).toBeTruthy();
  });

  test('a company admin sees the account report', async () => {
    state.status = {
      phase: 'ready' as const,
      snapshot: { memberships: [approvedMembership('company_admin')] as unknown[] },
    };
    renderWorkspace();
    expect(await screen.findByText('company-account-stub')).toBeTruthy();
  });

  test('the previously disconnected production routes are now wired', () => {
    const app = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toContain('production={<CorporateWorkspaceView />}');
    expect(app).toContain('production={<AdminOperationsView />}');
    expect(app).toContain('production={<SailingControlView />}');
    for (const route of ['/corporate', '/operations', '/fleet']) {
      const line = app.split('\n').find(l => l.includes(`path="${route}"`));
      expect(line, route).not.toContain('NotConnectedView');
    }
  });
});
