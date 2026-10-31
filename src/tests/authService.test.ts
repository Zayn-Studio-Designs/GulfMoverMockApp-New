import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import {
  APP_MODE_VARIABLE,
  SUPABASE_ANON_KEY_VARIABLE,
  SUPABASE_URL_VARIABLE,
} from '../lib/supabase';
import {
  AuthInputError,
  AuthNotAvailableError,
  AuthOperationError,
  getSession,
  onAuthStateChange,
  requestPasswordReset,
  signIn,
  signOut,
  signUp,
  updatePassword,
} from '../lib/authService';

/**
 * Checkpoint 1 tests. The Supabase SDK's `createClient` is mocked, so NO test
 * ever connects to a real Supabase project: every call below is in-memory.
 * The real `src/lib/supabase.ts` configuration/mode logic runs unmocked, and
 * per-operation behaviour is driven through synthetic mock user objects.
 */

const mocks = vi.hoisted(() => {
  const auth = {
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
  };
  return { auth, createClient: vi.fn() };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

const env = (values: Record<string, string | undefined>) => values;

const VALID_URL = 'https://example-project.supabase.co';
const VALID_KEY = 'test-publishable-anon-key';

const prodEnv = (overrides: Record<string, string | undefined> = {}) => env({
  [APP_MODE_VARIABLE]: 'production',
  [SUPABASE_URL_VARIABLE]: VALID_URL,
  [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
  ...overrides,
});

const DEMO_ENV = env({ [APP_MODE_VARIABLE]: 'demo' });

const session = { user: { id: 'auth-user-id' } } as unknown as Session;

/** Supabase-shaped ok/error response helpers. */
const ok = <T extends object>(data: T) => ({ data, error: null });
const serverError = (message: string, code: string | null, status: number | null) => ({
  data: { user: null, session: null },
  error: { message, ...(code === null ? {} : { code }), ...(status === null ? {} : { status }) },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createClient.mockImplementation(() => ({ auth: mocks.auth }));
});

describe('availability (demo mode, missing and invalid configuration)', () => {
  it('demo mode throws AuthNotAvailableError (demo-mode) and never creates a client', async () => {
    await expect(signIn('person@example.test', 'pw-not-used', DEMO_ENV)).rejects.toMatchObject({
      name: 'AuthNotAvailableError',
      reason: 'demo-mode',
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('no mode variable at all defaults to demo and does not construct a client', async () => {
    await expect(signUp({ email: 'person@example.test', password: 'pw-not-used' }, env({}))).rejects.toMatchObject({
      reason: 'demo-mode',
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('production with missing configuration throws AuthNotAvailableError (config-error) with the exact issues', async () => {
    const missingEnv = prodEnv({ [SUPABASE_URL_VARIABLE]: undefined, [SUPABASE_ANON_KEY_VARIABLE]: undefined });
    await expect(signIn('person@example.test', 'pw-not-used', missingEnv)).rejects.toMatchObject({
      name: 'AuthNotAvailableError',
      reason: 'config-error',
      issues: ['missing-url', 'missing-anon-key'],
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('production with an invalid URL throws AuthNotAvailableError (config-error, invalid-url)', async () => {
    await expect(signIn('person@example.test', 'pw-not-used', prodEnv({ [SUPABASE_URL_VARIABLE]: 'not-a-url' })))
      .rejects.toMatchObject({ reason: 'config-error', issues: ['invalid-url'] });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('config-error messages never contain the configured values', async () => {
    await expect(signUp({ email: 'person@example.test', password: 'pw-not-used' }, prodEnv({ [SUPABASE_URL_VARIABLE]: 'https://user:pass@leaky.example.test' })))
      .rejects
      .toSatisfy((error: unknown) => {
        const e = error as Error;
        return !e.message.includes('leaky.example.test');
      });
  });

  it('reuses one memoized client per configuration: repeated operations build it only once', async () => {
    const memoEnv = prodEnv({ [SUPABASE_URL_VARIABLE]: 'https://memo-check-project.supabase.co' });
    const callsBefore = mocks.createClient.mock.calls.length;
    mocks.auth.getSession.mockResolvedValue(ok({ session }));
    await getSession(memoEnv);
    await getSession(memoEnv);
    expect(mocks.createClient.mock.calls.length - callsBefore).toBe(1);
    expect(mocks.auth.getSession).toHaveBeenCalledTimes(2);
  });
});

describe('signUp', () => {
  it('returns the user, session and confirmation flag on success', async () => {
    mocks.auth.signUp.mockResolvedValueOnce(ok({ user: { id: 'auth-user-id' }, session }));
    const result = await signUp({ email: ' Person@Example.test ', password: 'pw-example-1' }, prodEnv());
    expect(result).toEqual({
      userId: 'auth-user-id',
      email: 'Person@Example.test',
      session,
      emailConfirmationRequired: false,
    });
    expect(mocks.auth.signUp).toHaveBeenCalledWith({ email: 'Person@Example.test', password: 'pw-example-1' });
  });

  it('passes displayName as user metadata display_name', async () => {
    mocks.auth.signUp.mockResolvedValueOnce(ok({ user: { id: 'auth-user-id' }, session }));
    await signUp({ email: 'person@example.test', password: 'pw-example-1', displayName: ' Sami Al-Sayegh ' }, prodEnv());
    expect(mocks.auth.signUp).toHaveBeenCalledWith({
      email: 'person@example.test',
      password: 'pw-example-1',
      options: { data: { display_name: 'Sami Al-Sayegh' } },
    });
  });

  it('sends NO user metadata when displayName is absent, empty or whitespace-only', async () => {
    mocks.auth.signUp.mockResolvedValue(ok({ user: { id: 'auth-user-id' }, session }));
    await signUp({ email: 'person@example.test', password: 'pw-example-1' }, prodEnv());
    await signUp({ email: 'person@example.test', password: 'pw-example-1', displayName: '' }, prodEnv());
    await signUp({ email: 'person@example.test', password: 'pw-example-1', displayName: '   ' }, prodEnv());
    for (const call of mocks.auth.signUp.mock.calls) {
      expect(call[0]).not.toHaveProperty('options');
    }
  });

  it('records the 18+ age confirmation (never a date of birth) as user metadata', async () => {
    mocks.auth.signUp.mockResolvedValueOnce(ok({ user: { id: 'auth-user-id' }, session }));
    await signUp({ email: 'person@example.test', password: 'pw-example-1', displayName: 'Sami', ageConfirmed: true }, prodEnv());
    const sent = mocks.auth.signUp.mock.calls[0][0];
    expect(sent.options.data).toMatchObject({ display_name: 'Sami', age_confirmed_18_plus: true });
    expect(Number.isNaN(Date.parse(sent.options.data.age_confirmed_at))).toBe(false);
    expect(Object.keys(sent.options.data).sort()).toEqual(['age_confirmed_18_plus', 'age_confirmed_at', 'display_name']);
  });

  it('flags emailConfirmationRequired when signup returns a user but no session', async () => {
    mocks.auth.signUp.mockResolvedValueOnce(ok({ user: { id: 'auth-user-id' }, session: null }));
    const result = await signUp({ email: 'person@example.test', password: 'pw-example-1' }, prodEnv());
    expect(result).toEqual({
      userId: 'auth-user-id',
      email: 'person@example.test',
      session: null,
      emailConfirmationRequired: true,
    });
  });

  it('maps server errors to AuthOperationError with code and status', async () => {
    mocks.auth.signUp.mockResolvedValueOnce(serverError('User already registered', 'user_already_exists', 422));
    const error = await signUp({ email: 'taken@example.test', password: 'pw-secret-9' }, prodEnv()).catch(e => e);
    expect(error).toBeInstanceOf(AuthOperationError);
    expect(error.code).toBe('user_already_exists');
    expect(error.status).toBe(422);
    expect(error.message).toBe('User already registered');
    // Error text never carries the submitted password:
    expect(error.message).not.toContain('pw-secret-9');
  });

  it('keeps a usable fallback message when the server sends none', async () => {
    mocks.auth.signUp.mockResolvedValueOnce(serverError('', 'weird_server_state', null));
    const error = await signUp({ email: 'person@example.test', password: 'pw-secret-9' }, prodEnv()).catch(e => e);
    expect(error).toBeInstanceOf(AuthOperationError);
    expect(error.message).toContain('sign-up');
    expect(error.message).not.toContain('pw-secret-9');
  });

  it('rejects a blank email locally without contacting the client', async () => {
    await expect(signUp({ email: '   ', password: 'pw-example-1' }, prodEnv())).rejects.toBeInstanceOf(AuthInputError);
    expect(mocks.auth.signUp).not.toHaveBeenCalled();
  });

  it('rejects a blank password locally without contacting the client', async () => {
    await expect(signUp({ email: 'person@example.test', password: '' }, prodEnv())).rejects.toBeInstanceOf(AuthInputError);
    expect(mocks.auth.signUp).not.toHaveBeenCalled();
  });
});

describe('signIn', () => {
  it('returns the user id and session, trimming the email', async () => {
    mocks.auth.signInWithPassword.mockResolvedValueOnce(ok({ user: { id: 'auth-user-id' }, session }));
    const result = await signIn(' person@example.test ', 'pw-signin-1', prodEnv());
    expect(result).toEqual({ userId: 'auth-user-id', session });
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'person@example.test',
      password: 'pw-signin-1',
    });
  });

  it('maps invalid credentials to AuthOperationError (invalid_credentials)', async () => {
    mocks.auth.signInWithPassword.mockResolvedValueOnce(serverError('Invalid login credentials', 'invalid_credentials', 400));
    const error = await signIn('person@example.test', 'pw-wrong-9', prodEnv()).catch(e => e);
    expect(error).toBeInstanceOf(AuthOperationError);
    expect(error.code).toBe('invalid_credentials');
    expect(error.status).toBe(400);
    expect(error.message).not.toContain('pw-wrong-9');
  });

  it('throws AuthOperationError when the response carries no user or session', async () => {
    mocks.auth.signInWithPassword.mockResolvedValueOnce(ok({ user: null, session: null }));
    await expect(signIn('person@example.test', 'pw-signin-1', prodEnv())).rejects.toMatchObject({
      name: 'AuthOperationError',
      code: null,
      status: null,
    });
  });

  it('rejects blank and whitespace-only email input locally without contacting the client', async () => {
    for (const blank of ['', '   ']) {
      await expect(signIn(blank, 'pw-signin-1', prodEnv())).rejects.toBeInstanceOf(AuthInputError);
    }
    expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('rejects blank and whitespace-only password input locally without contacting the client', async () => {
    for (const blank of ['', '   ']) {
      await expect(signIn('person@example.test', blank, prodEnv())).rejects.toBeInstanceOf(AuthInputError);
    }
    expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('surfaces secret-key configuration errors safely in demo-ops terms (no key value anywhere)', async () => {
    const secretKey = 'sb_secret_supersecretvalue0123456789abcdef';
    const error = await signIn('person@example.test', 'pw-not-used', prodEnv({ [SUPABASE_ANON_KEY_VARIABLE]: secretKey })).catch(e => e);
    expect(error).toMatchObject({ name: 'AuthNotAvailableError', reason: 'config-error' });
    expect(error.issues).toContain('secret-key-detected');
    expect(error.message).not.toContain(secretKey);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe('signOut', () => {
  it('calls signOut and resolves when the server accepts it', async () => {
    mocks.auth.signOut.mockResolvedValueOnce(ok({}));
    await expect(signOut(prodEnv())).resolves.toBeUndefined();
    expect(mocks.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('maps a sign-out failure to AuthOperationError', async () => {
    mocks.auth.signOut.mockResolvedValueOnce(serverError('Network request failed', 'network_error', null));
    await expect(signOut(prodEnv())).rejects.toMatchObject({ code: 'network_error' });
  });
});

describe('getSession', () => {
  it('returns the session when one is stored', async () => {
    mocks.auth.getSession.mockResolvedValueOnce(ok({ session }));
    expect(await getSession(prodEnv())).toBe(session);
    expect(mocks.auth.getSession).toHaveBeenCalledTimes(1);
  });

  it('returns null when signed out', async () => {
    mocks.auth.getSession.mockResolvedValueOnce(ok({ session: null }));
    expect(await getSession(prodEnv())).toBeNull();
  });

  it('maps server errors to AuthOperationError', async () => {
    mocks.auth.getSession.mockResolvedValueOnce(serverError('Refresh token not found', 'refresh_token_not_found', 400));
    await expect(getSession(prodEnv())).rejects.toMatchObject({ code: 'refresh_token_not_found' });
  });
});

describe('onAuthStateChange', () => {
  it('registers the handler and unsubscribes exactly once', () => {
    const unsubscribe = vi.fn();
    mocks.auth.onAuthStateChange.mockReturnValueOnce({ data: { subscription: { unsubscribe } } });
    const handler = vi.fn();
    const stop = onAuthStateChange(handler, prodEnv());
    expect(mocks.auth.onAuthStateChange).toHaveBeenCalledWith(handler);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('repeated unsubscribe calls are safe and stop after the first', () => {
    const unsubscribe = vi.fn();
    mocks.auth.onAuthStateChange.mockReturnValueOnce({ data: { subscription: { unsubscribe } } });
    const stop = onAuthStateChange(vi.fn(), prodEnv());
    stop();
    stop();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects password reset and password update in demo mode (AuthNotAvailableError, demo-mode)', async () => {
    await expect(
      requestPasswordReset('person@example.test', 'https://app.example.test/auth/reset-callback', DEMO_ENV),
    ).rejects.toMatchObject({ name: 'AuthNotAvailableError', reason: 'demo-mode' });
    await expect(updatePassword('new-password-99', DEMO_ENV)).rejects.toMatchObject({
      name: 'AuthNotAvailableError',
      reason: 'demo-mode',
    });
    expect(mocks.auth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(mocks.auth.updateUser).not.toHaveBeenCalled();
  });

  it('throws AuthNotAvailableError in demo mode without registering anything', () => {
    expect(() => onAuthStateChange(vi.fn(), DEMO_ENV)).toThrow(AuthNotAvailableError);
    expect(mocks.auth.onAuthStateChange).not.toHaveBeenCalled();
  });
});

describe('requestPasswordReset', () => {
  it('sends the request with an explicit absolute redirect URL', async () => {
    mocks.auth.resetPasswordForEmail.mockResolvedValueOnce(ok({}));
    await requestPasswordReset(' person@example.test ', 'https://app.example.test/auth/reset-callback', prodEnv());
    expect(mocks.auth.resetPasswordForEmail).toHaveBeenCalledWith('person@example.test', {
      redirectTo: 'https://app.example.test/auth/reset-callback',
    });
  });

  it('rejects blank emails locally', async () => {
    await expect(
      requestPasswordReset('  ', 'https://app.example.test/auth/reset-callback', prodEnv()),
    ).rejects.toBeInstanceOf(AuthInputError);
    expect(mocks.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('rejects non-absolute or non-http(s) redirect URLs locally', async () => {
    for (const badRedirect of ['not-a-url', '/auth/reset-callback', 'javascript:alert(1)', '']) {
      await expect(requestPasswordReset('person@example.test', badRedirect, prodEnv()))
        .rejects.toBeInstanceOf(AuthInputError);
    }
    expect(mocks.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('maps server errors to AuthOperationError', async () => {
    mocks.auth.resetPasswordForEmail.mockResolvedValueOnce(
      serverError('Redirect URL not on allow-list', 'redirect_url_not_allowed', 422),
    );
    await expect(
      requestPasswordReset('person@example.test', 'https://app.example.test/auth/reset-callback', prodEnv()),
    ).rejects.toMatchObject({ code: 'redirect_url_not_allowed', status: 422 });
  });
});

describe('updatePassword', () => {
  it('updates the password and returns the user id', async () => {
    mocks.auth.updateUser.mockResolvedValueOnce(ok({ user: { id: 'auth-user-id' } }));
    expect(await updatePassword('new-password-99', prodEnv())).toBe('auth-user-id');
    expect(mocks.auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-99' });
  });

  it('rejects a blank password locally', async () => {
    await expect(updatePassword('  ', prodEnv())).rejects.toBeInstanceOf(AuthInputError);
    expect(mocks.auth.updateUser).not.toHaveBeenCalled();
  });

  it('maps a missing/expired session to AuthOperationError', async () => {
    mocks.auth.updateUser.mockResolvedValueOnce(serverError('Auth session missing', 'session_missing', 401));
    const error = await updatePassword('new-password-99', prodEnv()).catch(e => e);
    expect(error).toBeInstanceOf(AuthOperationError);
    expect(error.code).toBe('session_missing');
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('new-password-99');
  });
});
