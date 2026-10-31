import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppProviders } from '../App';
import AuthView from '../pages/AuthView';
import { useAuth, type AuthContextValue } from '../context/AuthContext';

/**
 * Checkpoint 2 cutover tests. The Checkpoint 1 auth SERVICE (`src/lib/authService.ts`)
 * is fully mocked, so NOTHING here contacts a real Supabase project; the real
 * `src/lib/supabase.ts` mode/validation logic runs unmocked. Demo tests exercise
 * the genuine demo provider (localStorage only).
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
  return {
    signUp: svc.signUp,
    signIn: svc.signIn,
    signOut: svc.signOut,
    getSession: svc.getSession,
    onAuthStateChange: svc.onAuthStateChange,
    requestPasswordReset: svc.requestPasswordReset,
    updatePassword: svc.updatePassword,
    AuthNotAvailableError,
    AuthOperationError,
    AuthInputError,
    SESSION_MISSING_CODE: 'session_missing',
  };
});

// Same class identity as the mock above, so instanceof checks inside AuthContext work.
const { AuthOperationError } = (await import('../lib/authService')) as {
  AuthOperationError: new (message: string, code: string | null, status: number | null) => Error;
};

const sessionOf = (email: string, displayName?: string): Session => ({
  user: {
    id: 'auth-user-1',
    email,
    user_metadata: displayName === undefined ? {} : { display_name: displayName },
    created_at: '2026-01-01T00:00:00.000Z',
  },
} as unknown as Session);

/** Test probe that captures the live context value for assertions and actions. */
let api: AuthContextValue;
function Probe() {
  api = useAuth();
  return null;
}

function renderAuth(initialEntry = '/') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Probe />
      </MemoryRouter>
    </AppProviders>,
  );
}

function renderAuthView(route = '/signin') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[route]}>
        <AuthView />
      </MemoryRouter>
    </AppProviders>,
  );
}

const stubProductionEnv = () => {
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://cutover-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'cutover-publishable-key');
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  // The service contract: onAuthStateChange registers and returns the unsubscribe function.
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  api = undefined as unknown as AuthContextValue;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('demo mode (default): behaviour preserved', () => {
  it('defaults to the demo provider without contacting the auth service', () => {
    renderAuth();
    expect(api.authMode).toBe('demo');
    expect(api.sessionLoading).toBe(false);
    expect(api.user).toBeNull();
    expect(api.authUnavailable).toBeNull();
    expect(svc.getSession).not.toHaveBeenCalled();
    expect(svc.onAuthStateChange).not.toHaveBeenCalled();
  });

  it('demo sign-up validates inputs like before', async () => {
    renderAuth();
    await expect(api.signUp({ email: 'bad-email', username: 'sam', company: 'Co', password: 'pw-demo-1', confirm: 'pw-demo-1', dateOfBirth: '1990-05-01' })).resolves.toBe('errEmail');
    expect(api.user).toBeNull();
  });

  it('demo sign-up + sign out round-trip keeps the local session mechanics', async () => {
    renderAuth();
    await expect(api.signUp({ email: 'demo@example.test', username: 'sami', company: 'Demo Co', password: 'pw-demo-1', confirm: 'pw-demo-1', dateOfBirth: '1990-05-01' })).resolves.toBeNull();
    await waitFor(() => expect(api.user?.email).toBe('demo@example.test'));
    api.signOut();
    await waitFor(() => expect(api.user).toBeNull());
    expect(api.signedOutByUser).toBe(true);
  });

  it('demo guest sign-in works exactly as before', async () => {
    renderAuth();
    await act(async () => { await api.signInAsGuest(true); });
    await waitFor(() => expect(api.user?.email).toBe('guest@demo.test'));
  });

  it('demo mode rejects the production-only reset-email path as demo experience', async () => {
    renderAuth();
    await expect(api.requestResetEmail('not-an-email')).resolves.toBe('errEmail');
    await expect(api.requestResetEmail('nobody@example.test')).resolves.toBe('errNoAccount');
  });
});

describe('production mode: real auth service behind the same interface', () => {
  beforeEach(() => {
    stubProductionEnv();
    svc.getSession.mockResolvedValue(null); // the service returns the Session itself, or null when signed out
  });

  it('sign-in uses the service and maps the session to the app user', async () => {
    svc.signIn.mockResolvedValueOnce({ userId: 'auth-user-1', session: sessionOf('sami@example.test', 'Sami Al-Sayegh') });
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.signIn('sami@example.test', 'pw-real-1', true, true)).resolves.toBeNull();
    await waitFor(() => expect(api.user?.email).toBe('sami@example.test'));
    expect(api.user?.fullName).toBe('Sami Al-Sayegh');
    expect(svc.signIn.mock.calls[0].slice(0, 2)).toEqual(['sami@example.test', 'pw-real-1']);
  });

  it('wrong credentials surface the localized email-only errSignInEmail key, echoing nothing', async () => {
    svc.signIn.mockRejectedValueOnce(new AuthOperationError('Invalid login credentials', 'invalid_credentials', 400));
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    // Phase 2: production accepts e-mail only, so the message no longer mentions usernames.
    await expect(api.signIn('sami@example.test', 'pw-wrong-1', true, true)).resolves.toBe('errSignInEmail');
    expect(api.user).toBeNull();
  });

  it('sign-up with a session signs the user in', async () => {
    svc.signUp.mockResolvedValueOnce({ userId: 'auth-user-1', email: 'new@example.test', session: sessionOf('new@example.test', 'New User'), emailConfirmationRequired: false });
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.signUp({ email: 'new@example.test', username: 'newuser', company: 'ignored here', password: 'pw-real-1', confirm: 'pw-real-1', dateOfBirth: '1990-05-01' })).resolves.toBeNull();
    await waitFor(() => expect(api.user?.email).toBe('new@example.test'));
  });

  it('email-confirmation-required sign-up sets confirmationPending and does NOT fake a session', async () => {
    svc.signUp.mockResolvedValueOnce({ userId: 'auth-user-1', email: 'pending@example.test', session: null, emailConfirmationRequired: true });
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.signUp({ email: 'pending@example.test', username: 'pending', company: 'Co', password: 'pw-real-1', confirm: 'pw-real-1', dateOfBirth: '1990-05-01' })).resolves.toBeNull();
    await waitFor(() => expect(api.confirmationPending).toBe('pending@example.test'));
    expect(api.user).toBeNull();
  });

  it('a rejected sign-up surfaces an error and never fakes confirmation or a session', async () => {
    svc.signUp.mockRejectedValueOnce(new AuthOperationError('User already registered', 'user_already_exists', 422));
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.signUp({ email: 'taken@example.test', username: 'taken', company: 'Co', password: 'pw-real-1', confirm: 'pw-real-1', dateOfBirth: '1990-05-01' })).resolves.toBe('errEmailTaken');
    expect(api.user).toBeNull();
    expect(api.confirmationPending).toBeNull();
  });

  it('sign out clears the user and calls the service', async () => {
    svc.signIn.mockResolvedValueOnce({ userId: 'auth-user-1', session: sessionOf('signed-in@example.test', 'User') });
    svc.signOut.mockResolvedValueOnce(undefined);
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.signIn('signed-in@example.test', 'pw-real-1', true, true)).resolves.toBeNull();
    await waitFor(() => expect(api.user).not.toBeNull());
    api.signOut();
    await waitFor(() => expect(api.user).toBeNull());
    expect(api.signedOutByUser).toBe(true);
    expect(svc.signOut).toHaveBeenCalledTimes(1);
  });

  it('restores the persisted session on mount and stops loading', async () => {
    svc.getSession.mockResolvedValue(sessionOf('restored@example.test', 'Restored'));
    renderAuth('/bookings');
    await waitFor(() => expect(api.user?.email).toBe('restored@example.test'));
    await waitFor(() => expect(api.sessionLoading).toBe(false));
    expect(api.authUnavailable).toBeNull();
  });

  it('auth-state changes update the app; the subscription unsubscribes on unmount', async () => {
    svc.getSession.mockResolvedValue(sessionOf('listener@example.test', 'Listener'));
    const { unmount } = renderAuth();
    expect(svc.onAuthStateChange).toHaveBeenCalledTimes(1);
    const handler = svc.onAuthStateChange.mock.calls[0][0] as (event: string, session: Session | null) => void;
    await waitFor(() => expect(api.user?.email).toBe('listener@example.test'));

    handler('SIGNED_OUT', null);
    await waitFor(() => expect(api.user).toBeNull());
    expect(api.signedOutByUser).toBe(true);

    handler('SIGNED_IN', sessionOf('again@example.test', 'Again'));
    await waitFor(() => expect(api.user?.email).toBe('again@example.test'));

    unmount();
    expect(svc.unsubscribe).toHaveBeenCalled();
  });

  it('missing production configuration fails visibly and never falls back to demo', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    renderAuth();
    await waitFor(() => expect(api.authUnavailable).not.toBeNull());
    expect(api.authUnavailable?.reason).toBe('config-error');
    expect(api.authUnavailable?.issues).toContain('missing-url');
    expect(api.authMode).toBe('production');
    // The interface refuses to use the demo provider behind the user's back, and (Phase 2)
    // reports the refusal as an error instead of a null "success".
    await expect(api.signIn('sami@example.test', 'pw-real-1', true, true)).resolves.toBe('errAuthUnavailable');
    expect(svc.signIn).not.toHaveBeenCalled();
    expect(api.user).toBeNull();
  });

  it('password reset requires an explicitly configured redirect URL and fails clearly without one', async () => {
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.requestResetEmail('sami@example.test')).resolves.toBe('errResetRedirect');
    expect(svc.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('password reset sends the request with the configured redirect URL', async () => {
    vi.stubEnv('VITE_AUTH_RESET_REDIRECT_URL', 'https://app.example.test/auth/reset-callback');
    svc.requestPasswordReset.mockResolvedValueOnce(undefined);
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.requestResetEmail('sami@example.test')).resolves.toBeNull();
    expect(svc.requestPasswordReset.mock.calls[0].slice(0, 2)).toEqual(['sami@example.test', 'https://app.example.test/auth/reset-callback']);
  });

  it('production password change uses the service update (validated only in an active session)', async () => {
    svc.signIn.mockResolvedValueOnce({ userId: 'auth-user-1', session: sessionOf('pwchange@example.test', 'User') });
    svc.updatePassword.mockResolvedValueOnce('auth-user-1');
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await expect(api.signIn('pwchange@example.test', 'pw-real-1', true, true)).resolves.toBeNull();
    await waitFor(() => expect(api.user).not.toBeNull());
    await expect(api.changePassword('', 'pw-newer-99', 'pw-newer-99')).resolves.toBeNull();
    expect(svc.updatePassword.mock.calls[0][0]).toBe('pw-newer-99');
  });

  it('OAuth-affecting flows are inert: guest and provider sign-ins never touch the service', async () => {
    renderAuth();
    await waitFor(() => expect(api.authMode).toBe('production'));
    await act(async () => { await api.signInAsGuest(true); });
    await act(async () => { await api.signInWithProvider('google', true); });
    expect(api.user).toBeNull();
    expect(svc.signIn).not.toHaveBeenCalled();
    expect(svc.signUp).not.toHaveBeenCalled();
  });

  it('production AuthView hides the guest pass and the simulated provider buttons', async () => {
    renderAuthView('/signin');
    await waitFor(() => expect(screen.getByText('Production authentication is active. Sign in with your real account; demo accounts and the guest pass are not available.')).toBeTruthy());
    expect(screen.queryByText('Explore as demo guest')).toBeNull();
    expect(screen.queryByText('Sign in with Google')).toBeNull();
    expect(screen.queryByText('Sign in with Apple')).toBeNull();
  });
});
