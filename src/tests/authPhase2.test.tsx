import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppProviders, AppRoutes } from '../App';
import { useAuth, type AuthContextValue } from '../context/AuthContext';
import { markTourSeen } from '../components/Tour';
import { readRecoveryLinkSignal, RECOVERY_PATH } from '../lib/recoveryLink';
import { deferred } from './helpers/fakeSupabase';

/**
 * Phase 2 authentication hardening. The auth SERVICE is mocked (as in authCutover.test.tsx),
 * so nothing contacts Supabase; the real AuthContext, routing and pages run unmocked.
 */

const svc = vi.hoisted(() => ({
  signUp: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../lib/authService', () => {
  class AuthNotAvailableError extends Error {
    readonly reason: 'demo-mode' | 'config-error';
    readonly issues?: readonly string[];
    constructor(reason: 'demo-mode' | 'config-error', message: string, issues?: readonly string[]) {
      super(message);
      this.name = 'AuthNotAvailableError';
      this.reason = reason;
      this.issues = issues;
    }
  }
  class AuthOperationError extends Error {
    readonly code: string | null;
    readonly status: number | null;
    constructor(message: string, code: string | null, status: number | null) {
      super(message);
      this.name = 'AuthOperationError';
      this.code = code;
      this.status = status;
    }
  }
  class AuthInputError extends Error {}
  return { ...svc, AuthNotAvailableError, AuthOperationError, AuthInputError, SESSION_MISSING_CODE: 'session_missing' };
});

// Company onboarding reads go through the Supabase client: keep them in memory too.
vi.mock('@supabase/supabase-js', async () => (await import('./helpers/fakeSupabase')).fakeSupabaseModule);

const service = (await import('../lib/authService')) as unknown as {
  AuthOperationError: new (message: string, code: string | null, status: number | null) => Error;
  AuthNotAvailableError: new (reason: 'demo-mode' | 'config-error', message: string, issues?: readonly string[]) => Error;
};
const { fake } = await import('./helpers/fakeSupabase');

type Handler = (event: string, session: Session | null) => void;

const sessionOf = (email: string, id = 'auth-user-1'): Session => ({
  user: { id, email, user_metadata: { display_name: 'Test User' }, created_at: '2026-01-01T00:00:00.000Z' },
} as unknown as Session);

let api: AuthContextValue;
function Probe() {
  api = useAuth();
  return null;
}

const renderProbe = () => render(
  <AppProviders><MemoryRouter><Probe /></MemoryRouter></AppProviders>,
);

const renderApp = (route: string) => render(
  <AppProviders><MemoryRouter initialEntries={[route]}><Probe /><AppRoutes /></MemoryRouter></AppProviders>,
);

const handler = (): Handler => svc.onAuthStateChange.mock.calls[0][0] as Handler;

const stubProductionEnv = () => {
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://phase2-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'phase2-publishable-key');
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  // Full reset: queued once-values must not leak when a test short-circuits before using them.
  Object.values(svc).forEach(fn => fn.mockReset());
  fake.reset();
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  svc.getSession.mockResolvedValue(null);
  markTourSeen('auth-user-1');
  markTourSeen('auth-user-2');
  api = undefined as unknown as AuthContextValue;
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

/* ------------------------------------------------------------------------ */
describe('B. session restoration races (deterministic)', () => {
  beforeEach(stubProductionEnv);

  it('a SIGNED_OUT event during a pending restore is not overwritten by the stale restored session', async () => {
    const restore = deferred<Session | null>();
    svc.getSession.mockReturnValueOnce(restore.promise);
    renderProbe();
    expect(api.sessionLoading).toBe(true);

    act(() => handler()('SIGNED_OUT', null));
    expect(api.user).toBeNull();

    // The initial getSession() request started before the sign-out and only answers now.
    await act(async () => { restore.resolve(sessionOf('stale@example.test')); await restore.promise; });

    expect(api.user).toBeNull();
    expect(api.signedOutByUser).toBe(true);
    expect(api.sessionLoading).toBe(false);
  });

  it('a SIGNED_IN event during a pending restore is not undone by a stale "no session" answer', async () => {
    const restore = deferred<Session | null>();
    svc.getSession.mockReturnValueOnce(restore.promise);
    renderProbe();

    act(() => handler()('SIGNED_IN', sessionOf('fresh@example.test', 'auth-user-2')));
    expect(api.user?.email).toBe('fresh@example.test');

    await act(async () => { restore.resolve(null); await restore.promise; });

    expect(api.user?.email).toBe('fresh@example.test');
    expect(api.sessionLoading).toBe(false);
  });

  it('a sign-in completed through the app during a pending restore also wins over the stale answer', async () => {
    const restore = deferred<Session | null>();
    svc.getSession.mockReturnValueOnce(restore.promise);
    svc.signIn.mockResolvedValueOnce({ userId: 'auth-user-2', session: sessionOf('typed@example.test', 'auth-user-2') });
    renderProbe();

    await act(async () => { await expect(api.signIn('typed@example.test', 'pw-real-1')).resolves.toBeNull(); });
    await act(async () => { restore.resolve(null); await restore.promise; });

    expect(api.user?.email).toBe('typed@example.test');
  });

  it('normal restoration applies the persisted session once loading completes', async () => {
    const restore = deferred<Session | null>();
    svc.getSession.mockReturnValueOnce(restore.promise);
    renderProbe();
    expect(api.sessionLoading).toBe(true);
    expect(api.user).toBeNull();

    await act(async () => { restore.resolve(sessionOf('restored@example.test')); await restore.promise; });

    expect(api.user?.email).toBe('restored@example.test');
    expect(api.sessionLoading).toBe(false);
  });

  it('unmounting unsubscribes exactly once and ignores a restore or event that arrives afterwards', async () => {
    const restore = deferred<Session | null>();
    svc.getSession.mockReturnValueOnce(restore.promise);
    const { unmount } = renderProbe();
    const listen = handler();
    const seen = api;
    unmount();
    expect(svc.unsubscribe).toHaveBeenCalledTimes(1);

    await act(async () => { restore.resolve(sessionOf('late@example.test')); await restore.promise; });
    act(() => listen('SIGNED_IN', sessionOf('late@example.test')));
    // The last value rendered before unmount is unchanged: nothing applied the late results.
    expect(seen.user).toBeNull();
    expect(svc.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
describe('C. unavailable authentication is never reported as success', () => {
  it('a broken production configuration returns errAuthUnavailable for every operation, with no service call', async () => {
    stubProductionEnv();
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    renderProbe();
    await waitFor(() => expect(api.authUnavailable?.reason).toBe('config-error'));

    await expect(api.signIn('sami@example.test', 'pw-real-1')).resolves.toBe('errAuthUnavailable');
    await expect(api.signUp({ email: 'sami@example.test', username: '', company: '', password: 'pw-real-1', confirm: 'pw-real-1' })).resolves.toBe('errAuthUnavailable');
    await expect(api.requestResetEmail('sami@example.test')).resolves.toBe('errAuthUnavailable');
    await expect(api.signOut()).resolves.toBe('errAuthUnavailable');
    expect(api.user).toBeNull();
    expect(svc.signIn).not.toHaveBeenCalled();
    expect(svc.signUp).not.toHaveBeenCalled();
  });

  it('a missing auth service at call time (AuthNotAvailableError) is an error, not a login or registration', async () => {
    stubProductionEnv();
    svc.signIn.mockRejectedValueOnce(new service.AuthNotAvailableError('config-error', 'not available', ['missing-url']));
    svc.signUp.mockRejectedValueOnce(new service.AuthNotAvailableError('config-error', 'not available', ['missing-url']));
    renderProbe();
    await waitFor(() => expect(api.sessionLoading).toBe(false));

    let signInResult: unknown;
    await act(async () => { signInResult = await api.signIn('sami@example.test', 'pw-real-1'); });
    expect(signInResult).toBe('errAuthUnavailable');
    let signUpResult: unknown;
    await act(async () => { signUpResult = await api.signUp({ email: 'new@example.test', username: '', company: '', password: 'pw-real-1', confirm: 'pw-real-1' }); });
    expect(signUpResult).toBe('errAuthUnavailable');
    expect(api.user).toBeNull();
    expect(api.confirmationPending).toBeNull();
    expect(api.authUnavailable?.issues).toEqual(['missing-url']);
  });

  it('network failures and unexpected errors are errors, never null', async () => {
    stubProductionEnv();
    svc.signIn.mockRejectedValueOnce(new service.AuthOperationError('Failed to fetch', null, 0));
    svc.signUp.mockRejectedValueOnce(new TypeError('boom'));
    renderProbe();
    await waitFor(() => expect(api.sessionLoading).toBe(false));
    await expect(api.signIn('sami@example.test', 'pw-real-1')).resolves.toBe('errAuthNetwork');
    await expect(api.signUp({ email: 'new@example.test', username: '', company: '', password: 'pw-real-1', confirm: 'pw-real-1' })).resolves.toBe('errAuthGeneric');
    expect(api.user).toBeNull();
  });

  it('production sign-in rejects a username before contacting the service', async () => {
    stubProductionEnv();
    renderProbe();
    await waitFor(() => expect(api.sessionLoading).toBe(false));
    await expect(api.signIn('sami', 'pw-real-1')).resolves.toBe('errEmail');
    expect(svc.signIn).not.toHaveBeenCalled();
  });

  it('a password change without a session is an error, not a silent success', async () => {
    stubProductionEnv();
    renderProbe();
    await waitFor(() => expect(api.sessionLoading).toBe(false));
    await expect(api.changePassword('', 'pw-newer-99', 'pw-newer-99')).resolves.toBe('errSessionRequired');
    expect(svc.updatePassword).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
describe('D. sign-out, confirmation notice, labels and configuration screen', () => {
  beforeEach(stubProductionEnv);

  it('a failed sign-out keeps the user signed in and returns errSignOutFailed', async () => {
    svc.getSession.mockResolvedValue(sessionOf('stay@example.test'));
    svc.signOut.mockRejectedValueOnce(new service.AuthOperationError('Failed to fetch', null, 0));
    renderProbe();
    await waitFor(() => expect(api.user?.email).toBe('stay@example.test'));
    let result: unknown;
    await act(async () => { result = await api.signOut(); });
    expect(result).toBe('errSignOutFailed');
    expect(api.user?.email).toBe('stay@example.test');
    expect(api.signedOutByUser).toBe(false);
  });

  it('the Settings sign-out button reports the failure and does not leave the page', async () => {
    svc.getSession.mockResolvedValue(sessionOf('stay@example.test'));
    svc.signOut.mockRejectedValueOnce(new service.AuthOperationError('Failed to fetch', null, 0));
    renderApp('/settings?tab=account');
    const card = await screen.findByRole('region', { name: 'Sign out' });
    fireEvent.click(within(card).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Sign-out did not complete — you are still signed in. Check your connection and try again.')).toBeTruthy();
    expect(screen.queryByText('You have signed out.')).toBeNull();
    expect(api.user?.email).toBe('stay@example.test');
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('a successful sign-out clears the session and returns null', async () => {
    svc.getSession.mockResolvedValue(sessionOf('leave@example.test'));
    svc.signOut.mockResolvedValueOnce(undefined);
    renderProbe();
    await waitFor(() => expect(api.user).not.toBeNull());
    let result: unknown = 'unset';
    await act(async () => { result = await api.signOut(); });
    expect(result).toBeNull();
    expect(api.user).toBeNull();
    expect(api.signedOutByUser).toBe(true);
  });

  it('the confirmation-pending notice is shown after sign-up and cleared by a real SIGNED_IN event', async () => {
    svc.signUp.mockResolvedValueOnce({ userId: 'auth-user-1', email: 'confirm@example.test', session: null, emailConfirmationRequired: true });
    renderApp('/signup');
    await screen.findByRole('heading', { name: 'Create an account' });
    // Production sign-up never collects a company it would silently drop.
    expect(screen.queryByLabelText('Company name')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'confirm@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-real-1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw-real-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Check your email')).toBeTruthy();
    expect(screen.getByText(/We sent a confirmation link to confirm@example.test/)).toBeTruthy();
    // Back on the sign-in form with the address filled in; no session was invented.
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('confirm@example.test');
    expect(api.user).toBeNull();
    expect(fake.rpc).not.toHaveBeenCalled();

    act(() => handler()('SIGNED_IN', sessionOf('confirm@example.test')));
    await waitFor(() => expect(api.confirmationPending).toBeNull());
    expect(api.user?.email).toBe('confirm@example.test');
  });

  it('the confirmation-pending notice is also cleared by a restored session and by sign-out', async () => {
    svc.signUp.mockResolvedValueOnce({ userId: 'auth-user-1', email: 'confirm@example.test', session: null, emailConfirmationRequired: true });
    renderProbe();
    await waitFor(() => expect(api.sessionLoading).toBe(false));
    await act(async () => { await api.signUp({ email: 'confirm@example.test', username: '', company: '', password: 'pw-real-1', confirm: 'pw-real-1' }); });
    expect(api.confirmationPending).toBe('confirm@example.test');
    act(() => handler()('SIGNED_OUT', null));
    expect(api.confirmationPending).toBeNull();
  });

  it('the production sign-in form asks for an email, not a username', async () => {
    renderApp('/signin');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.queryByLabelText('Email or username')).toBeNull();
  });

  it('the production configuration-error screen lists the issue codes on sign-in and inside the app', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://insecure.example.test');
    const { unmount } = renderApp('/signin');
    expect(await screen.findByRole('heading', { name: 'Authentication is not configured' })).toBeTruthy();
    expect(screen.getByText('url-insecure-http')).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    unmount();
    renderApp('/bookings');
    expect(await screen.findByRole('heading', { name: 'Authentication is not configured' })).toBeTruthy();
    expect(screen.queryByText('Explore as demo guest')).toBeNull();
  });

  it('never logs the submitted password or session tokens', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    svc.getSession.mockResolvedValue({ ...sessionOf('tok@example.test'), access_token: 'secret-access-token-xyz', refresh_token: 'secret-refresh-xyz' });
    svc.signIn.mockRejectedValueOnce(new service.AuthOperationError('Invalid login credentials', 'invalid_credentials', 400));
    svc.signUp.mockRejectedValueOnce(new service.AuthOperationError('Password is known to be weak', 'weak_password', 422));
    renderProbe();
    await waitFor(() => expect(api.user).not.toBeNull());
    await act(async () => { await api.signIn('tok@example.test', 'pw-Secret-777'); });
    await act(async () => { await api.signUp({ email: 'tok@example.test', username: '', company: '', password: 'pw-Secret-888', confirm: 'pw-Secret-888' }); });
    const logged = spies.flatMap(spy => spy.mock.calls.flat()).map(arg => (arg instanceof Error ? arg.message : String(arg))).join('\n');
    for (const secret of ['pw-Secret-777', 'pw-Secret-888', 'secret-access-token-xyz', 'secret-refresh-xyz']) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach(spy => spy.mockRestore());
  });
});

/* ------------------------------------------------------------------------ */
describe('A. password recovery callback', () => {
  beforeEach(stubProductionEnv);

  const fillAndSubmit = (next: string, confirm: string) => {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  };

  it('classifies the recovery redirect URL without reading any token', () => {
    expect(readRecoveryLinkSignal({ pathname: '/', search: '', hash: '#access_token=a&refresh_token=b&type=recovery' })).toEqual({ kind: 'link' });
    expect(readRecoveryLinkSignal({ pathname: RECOVERY_PATH, search: '?code=abc', hash: '' })).toEqual({ kind: 'link' });
    expect(readRecoveryLinkSignal({ pathname: '/', search: '?code=abc', hash: '' })).toEqual({ kind: 'none' });
    expect(readRecoveryLinkSignal({ pathname: RECOVERY_PATH, search: '', hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid' }))
      .toEqual({ kind: 'error', code: 'otp_expired' });
    expect(readRecoveryLinkSignal({ pathname: RECOVERY_PATH, search: '?error=<script>', hash: '' })).toEqual({ kind: 'error', code: 'link_error' });
    expect(readRecoveryLinkSignal({ pathname: RECOVERY_PATH, search: '', hash: '' })).toEqual({ kind: 'none' });
  });

  it('successful recovery: verifies the link, shows the form, updates the password and confirms', async () => {
    window.history.replaceState(null, '', `${RECOVERY_PATH}#access_token=opaque&type=recovery`);
    const restore = deferred<Session | null>();
    svc.getSession.mockReturnValueOnce(restore.promise);
    svc.updatePassword.mockResolvedValueOnce('auth-user-1');
    renderApp(RECOVERY_PATH);

    expect(await screen.findByText('Verifying your password-reset link…')).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();

    await act(async () => { restore.resolve(sessionOf('reset@example.test')); await restore.promise; });
    act(() => handler()('PASSWORD_RECOVERY', sessionOf('reset@example.test')));

    fillAndSubmit('pw-brand-new-1', 'pw-brand-new-1');
    expect(await screen.findByText('Password changed')).toBeTruthy();
    expect(svc.updatePassword).toHaveBeenCalledTimes(1);
    expect(svc.updatePassword.mock.calls[0][0]).toBe('pw-brand-new-1');
    expect(screen.queryByLabelText('New password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Gulf Mover' }));
    expect(await screen.findByRole('heading', { name: 'Company registration' })).toBeTruthy();
  });

  it('a recovery event received on another page redirects to the new-password screen instead of the home page', async () => {
    svc.getSession.mockResolvedValue(sessionOf('reset@example.test'));
    renderApp('/');
    await waitFor(() => expect(api.user).not.toBeNull());
    act(() => handler()('PASSWORD_RECOVERY', sessionOf('reset@example.test')));
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeTruthy();
    expect(screen.getByLabelText('New password')).toBeTruthy();
  });

  it('an expired link shows a clear error, no form, and never claims a change', async () => {
    window.history.replaceState(null, '', `${RECOVERY_PATH}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    renderApp(RECOVERY_PATH);
    expect(await screen.findByText('This reset link has expired')).toBeTruthy();
    expect(screen.getByText(/Your password has not been changed/)).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.queryByText('Password changed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request a new reset link' }));
    expect(await screen.findByRole('heading', { name: 'Reset password' })).toBeTruthy();
    expect(svc.updatePassword).not.toHaveBeenCalled();
  });

  it('a recovery link that yields no session is reported as invalid', async () => {
    window.history.replaceState(null, '', `${RECOVERY_PATH}#access_token=opaque&type=recovery`);
    svc.getSession.mockResolvedValueOnce(null);
    renderApp(RECOVERY_PATH);
    expect(await screen.findByText('This reset link cannot be used')).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('opening the callback without any link explains that the email link is required', async () => {
    renderApp(RECOVERY_PATH);
    expect(await screen.findByText('This page only works from the link in a password-reset email. Your password has not been changed.')).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
    await expect(api.completePasswordRecovery('pw-brand-new-1', 'pw-brand-new-1')).resolves.toBe('errRecoveryExpired');
    expect(svc.updatePassword).not.toHaveBeenCalled();
  });

  const openReadyForm = async () => {
    svc.getSession.mockResolvedValue(sessionOf('reset@example.test'));
    renderApp(RECOVERY_PATH);
    await waitFor(() => expect(api.user).not.toBeNull());
    act(() => handler()('PASSWORD_RECOVERY', sessionOf('reset@example.test')));
    await screen.findByLabelText('New password');
  };

  it('validates the new password locally before calling the service', async () => {
    await openReadyForm();
    fillAndSubmit('short', 'short');
    expect(await screen.findByText('Password must be at least 8 characters with a letter and a number.')).toBeTruthy();
    fillAndSubmit('pw-brand-new-1', 'pw-brand-new-2');
    expect(await screen.findByText('Passwords do not match.')).toBeTruthy();
    expect(svc.updatePassword).not.toHaveBeenCalled();
  });

  it('an expired recovery session during the update is reported, the form is withdrawn, nothing is claimed', async () => {
    await openReadyForm();
    svc.updatePassword.mockRejectedValueOnce(new service.AuthOperationError('Auth session missing!', 'session_missing', 400));
    fillAndSubmit('pw-brand-new-1', 'pw-brand-new-1');
    expect(await screen.findByText('This reset link cannot be used')).toBeTruthy();
    expect(screen.queryByText('Password changed')).toBeNull();
    expect(api.recovery).toBe('invalid');
  });

  it('a network or server failure keeps the form with an error and never shows success', async () => {
    await openReadyForm();
    svc.updatePassword.mockRejectedValueOnce(new service.AuthOperationError('Failed to fetch', null, 0));
    fillAndSubmit('pw-brand-new-1', 'pw-brand-new-1');
    expect(await screen.findByText('We could not reach the sign-in service. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByLabelText('New password')).toBeTruthy();
    expect(screen.queryByText('Password changed')).toBeNull();

    svc.updatePassword.mockRejectedValueOnce(new service.AuthOperationError('New password should be different', 'same_password', 422));
    fillAndSubmit('pw-brand-new-1', 'pw-brand-new-1');
    expect(await screen.findByText('Choose a password that is different from your current one.')).toBeTruthy();
    expect(api.recovery).toBe('ready');
  });
});

/* ------------------------------------------------------------------------ */
describe('demo-mode regression', () => {
  it('demo sign-in keeps the email-or-username field, company sign-up field and guest pass', async () => {
    renderApp('/signin');
    expect(await screen.findByLabelText('Email or username')).toBeTruthy();
    expect(screen.getByText('Explore as demo guest')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByLabelText('Company name')).toBeTruthy();
    expect(svc.getSession).not.toHaveBeenCalled();
  });

  it('demo sign-out resolves null after clearing the local session', async () => {
    renderProbe();
    await act(async () => { await api.signInAsGuest(); });
    await waitFor(() => expect(api.user).not.toBeNull());
    let result: unknown = 'unset';
    await act(async () => { result = await api.signOut(); });
    expect(result).toBeNull();
    expect(api.user).toBeNull();
  });

  it('the demo recovery callback explains the on-screen code instead of pretending to reset', async () => {
    renderApp(RECOVERY_PATH);
    expect(await screen.findByText(/Emailed reset links are part of production sign-in/)).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
    await expect(api.completePasswordRecovery('pw-brand-new-1', 'pw-brand-new-1')).resolves.toBe('errDemoOnly');
    expect(svc.updatePassword).not.toHaveBeenCalled();
  });
});
