import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppProviders, AppRoutes } from '../App';
import { useLanguage } from '../context/LanguageContext';
import { markTourSeen } from '../components/Tour';
import { deferred, fake, fakeClient, fakeSupabaseModule, type FakeResponse } from './helpers/fakeSupabase';

/**
 * Company onboarding, end to end through the real pages, contexts and company service.
 * Auth is the mocked auth service (no Supabase Auth calls); the company service talks to
 * the in-memory Supabase fake — no real accounts, database or credentials are involved.
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

const USER_ID = 'auth-user-1';
const sessionOf = (email = 'admin@example.test'): Session => ({
  user: { id: USER_ID, email, user_metadata: { display_name: 'Sara Test' }, created_at: '2026-01-01T00:00:00.000Z' },
} as unknown as Session);

let switchLang: (lang: 'en' | 'ar') => void;
function LangProbe() {
  switchLang = useLanguage().setLang;
  return null;
}

const renderApp = (route = '/onboarding') => render(
  <AppProviders><MemoryRouter initialEntries={[route]}><LangProbe /><AppRoutes /></MemoryRouter></AppProviders>,
);

const created = (legalName = 'Gulf Test Logistics LLC'): FakeResponse =>
  ({ data: [{ id: 'org-new', legal_name: legalName, status: 'pending', outcome: 'created' }], error: null, status: 201 });
const replayed = (legalName = 'Gulf Test Logistics LLC'): FakeResponse =>
  ({ data: [{ id: 'org-new', legal_name: legalName, status: 'pending', outcome: 'replayed' }], error: null, status: 200 });
const networkFailure: FakeResponse = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };

/** After a successful registration the RLS-visible state is the new pending company. */
const becomePending = (legalName = 'Gulf Test Logistics LLC') =>
  fake.setMemberships([{ orgId: 'org-new', org: { legalName, status: 'pending' } }]);

const fillValid = () => {
  fireEvent.change(screen.getByLabelText('Company legal name *'), { target: { value: 'Gulf Test Logistics LLC' } });
  fireEvent.change(screen.getByLabelText('Company contact email (optional)'), { target: { value: 'Ops@Example.test' } });
  fireEvent.change(screen.getByLabelText('Company contact phone (optional)'), { target: { value: '+966 13 000 0000' } });
};
const submitButton = () => screen.getByRole('button', { name: /Submit company registration|Retry submission|Submitting registration/ });

const productionEnv = () => {
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://onboarding-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'onboarding-publishable-key');
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  Object.values(svc).forEach(fn => fn.mockReset());
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  svc.getSession.mockResolvedValue(sessionOf());
  fake.reset();
  markTourSeen(USER_ID);
  productionEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.documentElement.dir = 'ltr';
});

describe('registration form (authenticated, no company yet)', () => {
  it('shows required fields, submits through register_company with the exact contract, and shows pending — not approved', async () => {
    fake.rpc.mockImplementationOnce(() => { becomePending(); return created(); });
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Company details' })).toBeTruthy();
    expect(screen.getByText(/Fields marked \* are required/)).toBeTruthy();
    expect((screen.getByLabelText('Your full name *') as HTMLInputElement).value).toBe('Sara Test');

    fillValid();
    fireEvent.click(submitButton());

    expect(await screen.findByText('Registration received by ATCO')).toBeTruthy();
    expect(screen.getByText(/It is not approved yet — it is pending ATCO review/)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Awaiting ATCO approval' })).toBeTruthy();
    expect(screen.getByText('Pending ATCO review')).toBeTruthy();
    expect(screen.queryByText('Company approved by ATCO')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Company details' })).toBeNull();

    expect(fake.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = fake.rpc.mock.calls[0];
    expect(fn).toBe('register_company');
    expect(Object.keys(args).sort()).toEqual([
      'p_billing_contact', 'p_contact_email', 'p_contact_phone', 'p_display_name', 'p_language',
      'p_legal_name', 'p_profile_display_name', 'p_registration_key', 'p_registration_number',
    ]);
    expect(args).toMatchObject({
      p_legal_name: 'Gulf Test Logistics LLC', p_profile_display_name: 'Sara Test', p_display_name: null,
      p_registration_number: null, p_billing_contact: null, p_contact_email: 'ops@example.test',
      p_contact_phone: '+966 13 000 0000', p_language: 'en',
    });
    expect(String(args.p_registration_key)).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.writeAttempts).toEqual([]);
    expect(sessionStorage.getItem(`gm-registration-attempt:${USER_ID}`)).toBeNull(); // attempt closed on success
  });

  it('rejects invalid input locally and never calls the RPC', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fireEvent.change(screen.getByLabelText('Your full name *'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('Company contact email (optional)'), { target: { value: 'not-an-email' } });
    fireEvent.click(submitButton());
    expect(await screen.findByText('Please correct the highlighted fields.')).toBeTruthy();
    expect(screen.getAllByText('This field is required.')).toHaveLength(2);
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByLabelText('Company legal name *')).toHaveAttribute('aria-invalid', 'true');
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('a double click submits exactly once and shows the loading state', async () => {
    const pending = deferred<FakeResponse>();
    fake.rpc.mockImplementationOnce(() => pending.promise);
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    const form = submitButton().closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(submitButton());
    await waitFor(() => expect(fake.rpc).toHaveBeenCalledTimes(1));
    expect(submitButton()).toHaveTextContent('Submitting registration…');
    expect(submitButton()).toBeDisabled();
    await act(async () => { becomePending(); pending.resolve(created()); await pending.promise; });
    expect(await screen.findByText('Registration received by ATCO')).toBeTruthy();
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it('an uncertain network failure keeps the details and retries with the SAME key (server replays, no duplicate)', async () => {
    fake.rpc.mockImplementationOnce(() => networkFailure);
    fake.rpc.mockImplementationOnce(() => { becomePending(); return replayed(); });
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    fireEvent.click(submitButton());

    expect(await screen.findByText('We could not confirm your registration')).toBeTruthy();
    expect(screen.queryByText('Registration received by ATCO')).toBeNull();
    expect((screen.getByLabelText('Company legal name *') as HTMLInputElement).value).toBe('Gulf Test Logistics LLC');
    const firstKey = fake.rpc.mock.calls[0][1].p_registration_key;
    expect(sessionStorage.getItem(`gm-registration-attempt:${USER_ID}`)).toBe(firstKey);

    fireEvent.click(screen.getByRole('button', { name: 'Retry submission' }));
    expect(await screen.findByText(/had already been received. No duplicate company was created/)).toBeTruthy();
    expect(fake.rpc).toHaveBeenCalledTimes(2);
    expect(fake.rpc.mock.calls[1][1]).toEqual(fake.rpc.mock.calls[0][1]); // identical key AND payload
  });

  it('a page reload after an uncertain failure still retries with the stored key', async () => {
    fake.rpc.mockImplementationOnce(() => networkFailure);
    const first = renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText('We could not confirm your registration');
    const firstKey = fake.rpc.mock.calls[0][1].p_registration_key;
    first.unmount();

    fake.rpc.mockImplementationOnce(() => { becomePending(); return replayed(); });
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText('Registration received by ATCO');
    expect(fake.rpc.mock.calls[1][1].p_registration_key).toBe(firstKey);
  });

  it('a server validation rejection marks the field; the corrected retry reuses the unused key', async () => {
    fake.rpc.mockImplementationOnce(() => ({ data: null, error: { code: '22023', message: 'invalid contact phone' }, status: 400 }));
    fake.rpc.mockImplementationOnce(() => { becomePending(); return created(); });
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    fireEvent.click(submitButton());
    expect(await screen.findByText('The server rejected some of the details. Check the highlighted field and try again.')).toBeTruthy();
    expect(screen.getByLabelText('Company contact phone (optional)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('The server did not accept this value.')).toBeTruthy();
    expect(screen.queryByText(/invalid contact phone/)).toBeNull(); // database text is not shown
    expect(screen.queryByText('Registration received by ATCO')).toBeNull();

    fireEvent.change(screen.getByLabelText('Company contact phone (optional)'), { target: { value: '+966130000001' } });
    fireEvent.click(submitButton());
    await screen.findByText('Registration received by ATCO');
    expect(fake.rpc.mock.calls[1][1].p_registration_key).toBe(fake.rpc.mock.calls[0][1].p_registration_key);
  });

  it.each([
    [{ code: '28000', message: 'profile_suspended: suspended accounts may not register a company' }, 400, 'Your account is suspended and cannot register a company. Contact ATCO.'],
    [{ code: 'PGRST202', message: 'Could not find the function public.register_company' }, 404, 'Company registration is not available on this server yet. Contact the operator.'],
    [{ code: '40001', message: 'registration attempt lost during conflict — retry' }, 409, 'Another submission was being processed at the same time. Please try again.'],
    [{ code: 'PGRST303', message: 'JWT expired' }, 401, 'Your session has ended. Sign in again, then submit your registration.'],
  ])('a server rejection %j is shown as an understandable message and never as success', async (error, status, text) => {
    fake.rpc.mockImplementationOnce(() => ({ data: null, error, status }));
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    fireEvent.click(submitButton());
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText('Registration received by ATCO')).toBeNull();
  });

  it('a payload mismatch re-reads the real status instead of creating another company', async () => {
    fake.rpc.mockImplementationOnce(() => {
      becomePending('Earlier Name LLC');
      return { data: null, error: { code: '22023', message: 'payload_mismatch: payload differs from the original registration for this key' }, status: 400 };
    });
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    fillValid();
    fireEvent.click(submitButton());
    expect(await screen.findByRole('heading', { name: 'Awaiting ATCO approval' })).toBeTruthy();
    expect(screen.getByText('Earlier Name LLC')).toBeTruthy();
    expect(screen.queryByText('Registration received by ATCO')).toBeNull();
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('onboarding states', () => {
  it('an existing pending member sees the pending status and is not sent through registration again', async () => {
    fake.setMemberships([{ orgId: 'org-1', org: { legalName: 'Pending Co LLC', status: 'pending' } }]);
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Awaiting ATCO approval' })).toBeTruthy();
    expect(screen.getByText('Pending Co LLC')).toBeTruthy();
    expect(screen.getByText('Company administrator')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Company details' })).toBeNull();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('an approved member sees the approval, a link to book, and the separate payment/readiness boundary', async () => {
    fake.setMemberships([{ orgId: 'org-1', role: 'company_booker', org: { legalName: 'Approved Co LLC', displayName: 'Approved Co', status: 'approved' } }]);
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Company approved by ATCO' })).toBeTruthy();
    expect(screen.getByText(/Payment is not connected; boarding requires a separate internal readiness decision/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Book a sailing' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Approved Co')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Company details' })).toBeNull();
  });

  it.each([
    ['restricted (membership suspended)', () => fake.setMemberships([{ orgId: 'org-x', status: 'suspended', org: { legalName: 'Co X', status: 'approved' } }]), 'Company access is restricted'],
    ['invited', () => fake.setMemberships([{ orgId: 'org-x', status: 'invited', org: { legalName: 'Co X', status: 'approved' } }]), 'Company invitation not yet active'],
    ['rejected company', () => fake.setMemberships([{ orgId: 'org-x', org: { legalName: 'Rejected Co', status: 'rejected' } }]), 'Registration not approved by ATCO'],
    ['suspended company', () => fake.setMemberships([{ orgId: 'org-x', org: { legalName: 'Suspended Co', status: 'suspended' } }]), 'Company suspended by ATCO'],
    ['suspended profile', () => { fake.tables.profiles = { data: { status: 'suspended' }, error: null, status: 200 }; }, 'Your account is suspended'],
    ['ATCO staff', () => { fake.tables.role_assignments = { data: [{ role: 'operations', status: 'active' }], error: null, status: 200 }; }, 'ATCO staff account'],
  ])('%s: shows its own next action and no registration form', async (_label, setup, heading) => {
    setup();
    renderApp();
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Company details' })).toBeNull();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('a status read failure is reported, nothing is assumed, and retry recovers', async () => {
    fake.tables['rpc:my_company_memberships'] = networkFailure;
    renderApp();
    expect(await screen.findByText('We could not load your company status. Nothing has been changed.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Company details' })).toBeNull();
    fake.tables['rpc:my_company_memberships'] = { data: [], error: null, status: 200 };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Company details' })).toBeTruthy();
  });
});

describe('authentication boundary', () => {
  it('signed-out visitors are sent to sign in; nothing protected is read or called', async () => {
    svc.getSession.mockResolvedValue(null);
    fake.session = null;
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(fakeClient.from).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('a sign-up awaiting e-mail confirmation cannot reach registration or call the RPC', async () => {
    svc.getSession.mockResolvedValue(null);
    fake.session = null;
    svc.signUp.mockResolvedValueOnce({ userId: USER_ID, email: 'new@example.test', session: null, emailConfirmationRequired: true });
    renderApp('/signup');
    await screen.findByRole('heading', { name: 'Create an account' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-real-1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw-real-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Check your email')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Company details' })).toBeNull();
    expect(fakeClient.from).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('after sign-in, production lands on company onboarding', async () => {
    svc.getSession.mockResolvedValue(null);
    svc.signIn.mockResolvedValueOnce({ userId: USER_ID, session: sessionOf() });
    renderApp('/signin');
    await screen.findByRole('heading', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-real-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Company registration' })).toBeTruthy();
  });
});

describe('production vs demo', () => {
  it('production never falls back to demo: live badge, scope notice, no guest pass', async () => {
    renderApp('/bookings');
    expect(await screen.findByText(/Live in this build: sign-in, company registration and ATCO review, sailings and seat reservations/)).toBeTruthy();
    expect(await screen.findByText('Next step: register your company with ATCO.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Company registration|Company/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Explore as demo guest')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'View company status' }));
    expect(await screen.findByText('LIVE ACCOUNT DATA')).toBeTruthy();
    expect(screen.queryByText('Company registration needs production sign-in')).toBeNull();
  });

  it('demo mode keeps its offline behaviour: no Supabase client, explanatory card, no production nav entry', async () => {
    vi.unstubAllEnvs();
    renderApp('/signin');
    fireEvent.click(await screen.findByText('Explore as demo guest'));
    await screen.findByRole('heading', { name: 'Home' });
    expect(screen.queryByText(/Live in this build/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Company registration/ })).toBeNull();
    expect(fakeSupabaseModule.createClient).not.toHaveBeenCalled();
    expect(svc.getSession).not.toHaveBeenCalled();
  });

  it('the demo /onboarding route explains the production-only feature without any network call', async () => {
    vi.unstubAllEnvs();
    const signIn = renderApp('/signin');
    fireEvent.click(await screen.findByText('Explore as demo guest'));
    await screen.findByRole('heading', { name: 'Home' });
    signIn.unmount(); // the demo session stays in localStorage, as for a returning visitor
    renderApp('/onboarding');
    expect(await screen.findByText('Company registration needs production sign-in')).toBeTruthy();
    expect(screen.getByText('DEMO DATA')).toBeTruthy();
    expect(fakeSupabaseModule.createClient).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});

describe('English and Arabic', () => {
  it('labels, required markers and states are translated with right-to-left layout', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Company details' });
    expect(screen.getByLabelText('Company legal name *')).toBeTruthy();
    act(() => switchLang('ar'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { name: 'بيانات الشركة' })).toBeTruthy();
    expect(screen.getByLabelText('الاسم القانوني للشركة *')).toBeTruthy();
    expect(screen.getByLabelText('اسمك الكامل *')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إرسال تسجيل الشركة' })).toBeTruthy();
    // E-mail and phone stay left-to-right inside the RTL form.
    expect(screen.getByLabelText('البريد الإلكتروني للتواصل مع الشركة (اختياري)')).toHaveAttribute('dir', 'ltr');
    // The Arabic UI language becomes the default preferred language for the new profile.
    fake.rpc.mockImplementationOnce(() => { becomePending(); return created(); });
    fireEvent.change(screen.getByLabelText('الاسم القانوني للشركة *'), { target: { value: 'شركة الخليج للاختبار' } });
    fireEvent.click(screen.getByRole('button', { name: 'إرسال تسجيل الشركة' }));
    expect(await screen.findByRole('heading', { name: 'بانتظار موافقة أتكو' })).toBeTruthy();
    expect(screen.getByText('بانتظار مراجعة أتكو')).toBeTruthy();
    expect(fake.rpc.mock.calls[0][1].p_language).toBe('en'); // form default captured at first render (English)
  });

  it('a form first shown in Arabic defaults the preferred language to Arabic', async () => {
    fake.rpc.mockImplementationOnce(() => { becomePending(); return created(); });
    fake.tables['rpc:my_company_memberships'] = { data: [], error: null, status: 200 };
    renderApp('/bookings');
    await screen.findByText(/Live in this build/);
    act(() => switchLang('ar'));
    fireEvent.click(screen.getByRole('link', { name: 'عرض حالة الشركة' }));
    fireEvent.change(await screen.findByLabelText('الاسم القانوني للشركة *'), { target: { value: 'شركة الخليج للاختبار' } });
    fireEvent.click(screen.getByRole('button', { name: 'إرسال تسجيل الشركة' }));
    await screen.findByRole('heading', { name: 'بانتظار موافقة أتكو' });
    expect(fake.rpc.mock.calls[0][1].p_language).toBe('ar');
  });
});
