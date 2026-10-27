import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppProviders, AppRoutes } from '../App';
import { useLanguage } from '../context/LanguageContext';
import { markTourSeen } from '../components/Tour';
import { classifyDataError } from '../lib/dataService';
import { isValidTime, saudiDateTimeParts, saudiDateTimeToIso } from '../domain/dates';
import { deferred, fake, fakeClient, type FakeResponse } from './helpers/fakeSupabase';

/**
 * Phase 3 production UI: navigation guards, ATCO company review, booking and My bookings.
 * Auth service mocked; data services run for real against the in-memory Supabase fake.
 * These prove the UI wiring and contracts — the security boundary itself is proven by the
 * local-Supabase integration suite (src/tests/integration), not here.
 */

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

const USER_ID = 'auth-user-1';
const session = { user: { id: USER_ID, email: 'booker@example.test', user_metadata: { display_name: 'Sara Booker' }, created_at: '2026-01-01T00:00:00.000Z' } } as unknown as Session;
const ok = (data: unknown, count?: number): FakeResponse & { count?: number } => ({ data, error: null, status: 200, ...(count !== undefined ? { count } : {}) });
const networkFailure: FakeResponse = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };

let switchLang: (lang: 'en' | 'ar') => void;
function LangProbe() { switchLang = useLanguage().setLang; return null; }
const renderApp = (route: string) => render(
  <AppProviders><MemoryRouter initialEntries={[route]}><LangProbe /><AppRoutes /></MemoryRouter></AppProviders>,
);

const staff = (...roles: string[]) => { fake.tables.role_assignments = ok(roles.map(role => ({ role, status: 'active' }))); };
const approvedMember = () => fake.setMemberships([{ orgId: 'org-1', org: { legalName: 'Approved Co LLC', status: 'approved' } }]);

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const route = (id: string, origin: string, destination: string) => ({ id, origin, destination, status: 'active' });
const sailing = (id: string, r: ReturnType<typeof route>, hours: number, capacity: number, booked = 0) => ({
  id, departs_at: inHours(hours), seat_capacity: capacity, seats_booked: booked, status: 'open', route: r, vessel: { id: 'v-1', name: 'Test Vessel One' },
});
const OUT = route('r-out', 'Test Pier', 'Test Anchorage');
const BACK = route('r-back', 'Test Anchorage', 'Test Pier');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  Object.values(svc).forEach(fn => fn.mockReset());
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  svc.getSession.mockResolvedValue(session);
  fake.reset();
  markTourSeen(USER_ID);
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://phase3-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'phase3-publishable-key');
});
afterEach(() => { vi.unstubAllEnvs(); document.documentElement.dir = 'ltr'; });

describe('Saudi-time helpers', () => {
  it('validates HH:MM times and converts Saudi local date/time to an ISO instant (UTC+3)', () => {
    expect(isValidTime('07:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('7:00')).toBe(false);
    expect(isValidTime('12:60')).toBe(false);
    expect(saudiDateTimeToIso('2027-01-15', '07:00')).toBe('2027-01-15T04:00:00.000Z');
    expect(saudiDateTimeToIso('2027-02-30', '07:00')).toBeNull();
    expect(saudiDateTimeParts('2027-01-15T04:00:00.000Z')).toEqual({ date: '2027-01-15', time: '07:00' });
  });
});

describe('error classification', () => {
  it.each([
    [{ code: 'P0001', message: 'sailing_full: not enough seats on the outbound sailing' }, 400, 'sailing-full', false],
    [{ code: '42501', message: 'organization_not_approved: only ATCO-approved organizations can book' }, 400, 'organization-not-approved', false],
    [{ code: '42501', message: 'conflict_of_interest: reviewers may not decide on their own organization' }, 400, 'conflict-of-interest', false],
    [{ code: '55000', message: 'reviewer_profile_missing: provision a profile' }, 400, 'reviewer-profile-missing', false],
    [{ code: '55000', message: 'invalid_transition: only pending organizations can be reviewed' }, 400, 'invalid-transition', false],
    [{ code: '42501', message: 'new row violates row-level security policy' }, 403, 'forbidden', false],
    [{ code: '23505', message: 'duplicate key value' }, 409, 'duplicate', false],
    [{ code: '', message: 'Failed to fetch' }, 0, 'network', true],
    [{ code: '', message: 'Bad gateway' }, 502, 'server', true],
  ])('%j → %s', (error, status, kind, uncertain) => {
    const err = classifyDataError(error, status);
    expect(err.kind).toBe(kind);
    expect(err.uncertain).toBe(uncertain);
    expect(err.message).not.toContain(error.message);
  });
});

describe('navigation reflects server-side roles, not a UI switch', () => {
  it('a customer sees only customer destinations; ATCO screens refuse and issue no admin query', async () => {
    approvedMember();
    renderApp('/admin/companies');
    expect(await screen.findByRole('heading', { name: 'ATCO staff access required' })).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
    expect(within(nav).getByRole('link', { name: /Book a sailing|Book Transfer/ })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: /Company review/ })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /Vessels and sailings/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ATCO staff (demo)' })).toBeNull(); // no demo view switch
    expect(fake.queries.some(q => q.table === 'organizations')).toBe(false);
  });

  it('a super_admin sees the ATCO destinations', async () => {
    staff('super_admin');
    renderApp('/onboarding');
    const nav = (await screen.findAllByRole('navigation', { name: 'Main navigation' }))[0];
    expect(await within(nav).findByRole('link', { name: /Company review/ })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /Vessels and sailings/ })).toBeTruthy();
  });

  it('demo-only modules are shown as not connected in production, never as working demo screens', async () => {
    for (const path of ['/operations', '/boarding', '/materials', '/fleet', '/corporate']) {
      const view = renderApp(path);
      expect(await screen.findByRole('heading', { name: 'Not connected in this build' })).toBeTruthy();
      expect(screen.queryByText(/DEMO DATA/)).toBeNull();
      view.unmount();
    }
  });
});

describe('ATCO company review', () => {
  const pendingCompany = {
    id: 'org-p', legal_name: 'Pending Shipping LLC', display_name: 'Pending Shipping', registration_number: 'REG-1',
    billing_contact: 'Accounts', contact_email: 'ops@pending.test', contact_phone: '+966130000000', status: 'pending',
    rejection_reason: null, created_at: '2026-10-27T08:00:00Z', approved_at: null,
  };
  const history = ok([{ decision: 'submitted', reason: null, occurred_at: '2026-10-27T08:00:00Z', actor_user_id: 'u-x' }]);
  const openCompany = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Open record' }));
    return screen.findByRole('heading', { name: 'Pending Shipping' });
  };

  beforeEach(() => {
    fake.tables.organizations = ok([pendingCompany], 1);
    fake.tables.approval_events = history;
  });

  it('lists pending registrations with stored fields and history; approving sends one RPC even on double click', async () => {
    staff('super_admin');
    const pending = deferred<FakeResponse>();
    fake.rpc.mockImplementationOnce(() => pending.promise);
    renderApp('/admin/companies');
    await openCompany();
    expect(screen.getByText('REG-1')).toBeTruthy();
    expect(screen.getByText(/has not verified them/)).toBeTruthy();
    expect(await screen.findByText('Registration submitted')).toBeTruthy();
    const orgQuery = fake.queries.find(q => q.table === 'organizations')!;
    expect(orgQuery.filters).toContainEqual(['eq', 'status', 'pending']);
    expect(orgQuery.filters.some(f => f[0] === 'range')).toBe(true); // paginated

    const approve = screen.getByRole('button', { name: 'Approve company' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await act(async () => { pending.resolve(ok([{ id: 'org-p', status: 'approved', outcome: 'decided' }])); await pending.promise; });
    expect(await screen.findByText('Company approved. The decision is recorded in the audit history.')).toBeTruthy();
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.rpc).toHaveBeenCalledWith('review_company', { p_organization_id: 'org-p', p_decision: 'approve', p_reason: null });
    expect(fake.writeAttempts).toEqual([]); // no direct organisation write
  });

  it('rejection requires a reason and sends it; a repeated decision is reported as unchanged', async () => {
    staff('super_admin');
    fake.rpc.mockImplementationOnce(() => ok([{ id: 'org-p', status: 'rejected', outcome: 'unchanged' }]));
    renderApp('/admin/companies');
    await openCompany();
    fireEvent.click(screen.getByRole('button', { name: 'Reject company' }));
    expect(await screen.findByText('Enter a reason before rejecting.')).toBeTruthy();
    expect(fake.rpc).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for rejection (required to reject)'), { target: { value: '  Documents incomplete ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject company' }));
    expect(await screen.findByText('This decision was already recorded. Nothing was changed.')).toBeTruthy();
    expect(fake.rpc).toHaveBeenCalledWith('review_company', { p_organization_id: 'org-p', p_decision: 'reject', p_reason: 'Documents incomplete' });
  });

  it('server refusals are shown honestly (conflict of interest, network)', async () => {
    staff('super_admin');
    fake.rpc.mockImplementationOnce(() => ({ data: null, error: { code: '42501', message: 'conflict_of_interest: x' }, status: 403 }));
    fake.rpc.mockImplementationOnce(() => networkFailure);
    renderApp('/admin/companies');
    await openCompany();
    fireEvent.click(screen.getByRole('button', { name: 'Approve company' }));
    expect(await screen.findByText('You cannot review a company you belong to or registered.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve company' }));
    expect(await screen.findByText(/The server did not confirm the decision/)).toBeTruthy();
    expect(screen.queryByText(/Company approved\./)).toBeNull();
  });

  it('operations staff can view but get no decision controls', async () => {
    staff('operations');
    renderApp('/admin/companies');
    await openCompany();
    expect(screen.getByText('Your role can view registrations but not decide on them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve company' })).toBeNull();
  });

  it('an empty filter and a load failure are shown clearly', async () => {
    staff('super_admin');
    fake.tables.organizations = ok([], 0);
    const view = renderApp('/admin/companies');
    expect(await screen.findByText('No companies match this filter.')).toBeTruthy();
    view.unmount();
    fake.tables.organizations = networkFailure;
    renderApp('/admin/companies');
    expect(await screen.findByText(/We could not reach the server/)).toBeTruthy();
  });
});

describe('production booking', () => {
  beforeEach(() => {
    fake.tables.sailings = ok([sailing('s-1', OUT, 30, 10, 2), sailing('s-full', OUT, 32, 3, 3), sailing('s-back', BACK, 40, 10, 0)]);
  });

  const chooseOutbound = async () => {
    fireEvent.change(await screen.findByLabelText('Route (from → to) *'), { target: { value: 'r-out' } });
    const radios = await screen.findAllByRole('radio');
    return radios;
  };
  const fillContact = () => {
    fireEvent.change(screen.getByLabelText('Contact phone number *'), { target: { value: '+966 13 000 0000' } });
  };

  it('is refused (with a link to company status) for users without an approved company', async () => {
    fake.setMemberships([{ orgId: 'org-1', org: { legalName: 'Pending Co', status: 'pending' } }]);
    renderApp('/book');
    expect(await screen.findByRole('heading', { name: 'Booking needs an approved company' })).toBeTruthy();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('books a selected sailing through create_booking only, and shows the server reference — no price, no payment success', async () => {
    approvedMember();
    fake.rpc.mockImplementationOnce(() => ok([{ booking_id: 'b-1', reference: 'GM-1A2B3C4D', status: 'reserved', outcome: 'created' }]));
    renderApp('/book');
    const radios = await chooseOutbound();
    expect(radios).toHaveLength(2);
    expect(radios[1]).toBeDisabled(); // fully booked sailing cannot be chosen
    expect(screen.getByText('8 seat(s) left')).toBeTruthy();
    expect(screen.getByText('2 of 4 minimum tickets')).toBeTruthy();
    fireEvent.click(radios[0]);
    expect((screen.getByLabelText('Lead passenger full name *') as HTMLInputElement).value).toBe('Sara Booker');
    fireEvent.change(screen.getByLabelText('Number of passengers *'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Other passenger names (optional)'), { target: { value: 'Second Person\n\n' } });
    fillContact();
    fireEvent.click(screen.getByRole('button', { name: 'Reserve seats' }));
    expect(await screen.findByRole('heading', { name: 'Seats reserved' })).toBeTruthy();
    expect(screen.getByText('GM-1A2B3C4D')).toBeTruthy();
    expect(screen.getByText(/It is not paid, ticketed or cleared for boarding/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SAR\s?\d|Payment recorded|Paid/);

    expect(fake.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = fake.rpc.mock.calls[0];
    expect(fn).toBe('create_booking');
    expect(args).toMatchObject({
      p_organization_id: 'org-1', p_outbound_sailing_id: 's-1', p_return_sailing_id: null, p_passenger_count: 2,
      p_contact_name: 'Sara Booker', p_contact_email: 'booker@example.test', p_contact_phone: '+966 13 000 0000',
      p_passenger_names: ['Second Person'], p_po_reference: null,
    });
    expect(Object.keys(args).some(k => /status|price|amount|paid|user/i.test(k))).toBe(false);
    expect(sessionStorage.getItem(`gm-booking-attempt:${USER_ID}`)).toBeNull();
  });

  it('a double click reserves once; an uncertain failure retries with the SAME request key', async () => {
    approvedMember();
    const first = deferred<FakeResponse>();
    fake.rpc.mockImplementationOnce(() => first.promise);
    fake.rpc.mockImplementationOnce(() => ok([{ booking_id: 'b-1', reference: 'GM-00000001', status: 'reserved', outcome: 'replayed' }]));
    renderApp('/book');
    fireEvent.click((await chooseOutbound())[0]);
    fillContact();
    const button = screen.getByRole('button', { name: 'Reserve seats' });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => { first.resolve(networkFailure); await first.promise; });
    expect(await screen.findByText('We could not confirm your reservation')).toBeTruthy();
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry reservation' }));
    expect(await screen.findByText(/no seats were reserved twice/)).toBeTruthy();
    expect(fake.rpc.mock.calls[1][1].p_request_key).toBe(fake.rpc.mock.calls[0][1].p_request_key);
  });

  it('a full sailing is reported, the list is reloaded, and nothing is shown as booked', async () => {
    approvedMember();
    fake.rpc.mockImplementationOnce(() => ({ data: null, error: { code: 'P0001', message: 'sailing_full: not enough seats' }, status: 400 }));
    renderApp('/book');
    fireEvent.click((await chooseOutbound())[0]);
    fillContact();
    const before = fake.queries.filter(q => q.table === 'sailings').length;
    fireEvent.click(screen.getByRole('button', { name: 'Reserve seats' }));
    expect(await screen.findByText(/Not enough seats are left on that sailing/)).toBeTruthy();
    await waitFor(() => expect(fake.queries.filter(q => q.table === 'sailings').length).toBeGreaterThan(before));
    expect(screen.queryByRole('heading', { name: 'Seats reserved' })).toBeNull();
  });

  it('offers only reverse-route sailings after the outbound one as return options', async () => {
    approvedMember();
    fake.rpc.mockImplementationOnce(() => ok([{ booking_id: 'b-2', reference: 'GM-0000000A', status: 'reserved', outcome: 'created' }]));
    renderApp('/book');
    fireEvent.click((await chooseOutbound())[0]);
    fireEvent.click(screen.getByLabelText('Add a return sailing on the reverse route'));
    const returnGroup = screen.getByRole('radiogroup', { name: 'Return sailing' });
    const options = within(returnGroup).getAllByRole('radio');
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]);
    fillContact();
    fireEvent.click(screen.getByRole('button', { name: 'Reserve seats' }));
    await screen.findByRole('heading', { name: 'Seats reserved' });
    expect(fake.rpc.mock.calls[0][1].p_return_sailing_id).toBe('s-back');
  });

  it('validates locally before calling the server', async () => {
    approvedMember();
    renderApp('/book');
    fireEvent.click((await chooseOutbound())[0]);
    fireEvent.change(screen.getByLabelText('Number of passengers *'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Contact email address *'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reserve seats' }));
    expect(await screen.findByText('More passengers than seats left on the chosen sailing(s).')).toBeTruthy();
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('This field is required.')).toBeTruthy(); // phone
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('is translated with RTL layout in Arabic', async () => {
    approvedMember();
    renderApp('/book');
    await screen.findByLabelText('Route (from → to) *');
    act(() => switchLang('ar'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { name: 'حجز رحلة' })).toBeTruthy();
    expect(screen.getByLabelText('المسار (من ← إلى) *')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حجز المقاعد' })).toBeTruthy();
  });
});

describe('My bookings (server-backed)', () => {
  const booking = {
    id: 'b-1', reference: 'GM-1A2B3C4D', status: 'reserved', passenger_count: 2, contact_name: 'Sara Booker',
    contact_email: 'booker@example.test', contact_phone: '+966130000000', passenger_names: ['Sara Booker', 'Second Person'],
    po_reference: 'PO-9', organization_id: 'org-1', created_at: '2026-10-27T08:00:00Z',
    booking_legs: [{ leg: 'outbound', passengers: 2, sailing: { id: 's-1', departs_at: inHours(30), status: 'open', route: { origin: 'Test Pier', destination: 'Test Anchorage' }, vessel: { name: 'Test Vessel One' } } }],
  };

  it('lists the caller\'s reservations and opens the saved record with separate status dimensions', async () => {
    approvedMember();
    fake.tables.bookings = ok([booking]);
    renderApp('/bookings');
    expect(await screen.findByText('GM-1A2B3C4D')).toBeTruthy();
    fake.tables.bookings = ok(booking);
    fireEvent.click(screen.getByRole('link', { name: 'Open booking' }));
    expect(await screen.findByRole('heading', { name: /Booking reference/ })).toBeTruthy();
    expect(screen.getByText('Seat reservation')).toBeTruthy();
    expect(screen.getAllByText('Not connected yet')).toHaveLength(3); // payment, clearance, boarding
    expect(screen.getByText('Second Person')).toBeTruthy();
    const detailQuery = fake.queries.filter(q => q.table === 'bookings').at(-1)!;
    expect(detailQuery.filters).toContainEqual(['eq', 'reference', 'GM-1A2B3C4D']);
  });

  it('a reference that RLS does not return is "not visible", whatever is typed into the URL', async () => {
    fake.tables.bookings = ok(null);
    renderApp('/bookings/GM-FFFFFFFF');
    expect(await screen.findByText('No booking with this reference is visible to your account.')).toBeTruthy();
  });

  it('ATCO staff "My bookings" is limited to bookings they created', async () => {
    staff('operations');
    fake.tables.bookings = ok([]);
    renderApp('/bookings');
    expect(await screen.findByText('You have no reservations yet.')).toBeTruthy();
    const bookingQueries = fake.queries.filter(q => q.table === 'bookings');
    expect(bookingQueries.length).toBeGreaterThan(0);
    // EVERY query — including the first — is limited to the staff member's own bookings.
    for (const q of bookingQueries) expect(q.filters).toContainEqual(['eq', 'created_by', USER_ID]);
  });
});

describe('ATCO operations', () => {
  it('creates a sailing with an ISO departure in Saudi time and lists the manifest', async () => {
    staff('operations');
    fake.writableTables.add('sailings');
    fake.tables.sailings = ok([sailing('s-1', OUT, 30, 10, 2)]);
    fake.tables.routes = ok([OUT, BACK]);
    fake.tables.vessels = ok([{ id: 'v-1', name: 'Test Vessel One', passenger_capacity: 12, status: 'active' }]);
    fake.tables.booking_legs = ok([{ leg: 'outbound', passengers: 2, booking: { reference: 'GM-1A2B3C4D', contact_name: 'Sara Booker', contact_phone: '+966130000000', organization: { legal_name: 'Approved Co LLC' } } }]);
    renderApp('/admin/operations');
    expect(await screen.findByText(/2 of 10 seats reserved/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Route (from → to) *'), { target: { value: 'r-out' } });
    fireEvent.change(screen.getByLabelText('Assigned vessel *'), { target: { value: 'v-1' } });
    fireEvent.change(screen.getByLabelText('Departure date (Saudi time) *'), { target: { value: '2027-01-15' } });
    fireEvent.change(screen.getByLabelText('Departure time (Saudi time) *'), { target: { value: '07:00' } });
    fireEvent.change(screen.getByLabelText('Seats offered *'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(fake.writes).toContainEqual(['sailings', 'insert', {
      route_id: 'r-out', vessel_id: 'v-1', departs_at: '2027-01-15T04:00:00.000Z', seat_capacity: 8, status: 'open',
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'View reservations' }));
    expect(await screen.findByText('Approved Co LLC')).toBeTruthy();
    expect(fakeClient.from).toHaveBeenCalledWith('booking_legs');
  });
});

describe('demo mode is unchanged', () => {
  it('keeps the offline booking wizard and shows ATCO admin screens as not connected', async () => {
    vi.unstubAllEnvs();
    localStorage.setItem('gm-demo-tour-seen', JSON.stringify(['U-guest']));
    const signIn = renderApp('/signin');
    fireEvent.click(await screen.findByText('Explore as demo guest'));
    await screen.findByRole('heading', { name: 'Home' });
    signIn.unmount();
    const book = renderApp('/book');
    expect(await screen.findByText('What do you need to arrange?')).toBeTruthy();
    book.unmount();
    renderApp('/admin/companies');
    expect(await screen.findByRole('heading', { name: 'Not connected in this build' })).toBeTruthy();
    expect(fakeClient.from).not.toHaveBeenCalled();
  });
});
