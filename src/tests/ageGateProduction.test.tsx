// Age of consent (18+) in PRODUCTION mode: nothing reaches Supabase Auth until the age rule is met,
// and the date of birth itself is never sent — only the 18+ confirmation is recorded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { confirmAge } from './ageGate';

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

const renderAt = (path: string) => render(<AppProviders><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></AppProviders>);

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  Object.values(svc).forEach(fn => fn.mockReset());
  svc.onAuthStateChange.mockImplementation(() => svc.unsubscribe);
  svc.getSession.mockResolvedValue(null);
  svc.signUp.mockResolvedValue({ userId: 'u-1', email: 'adult@example.test', session: null, emailConfirmationRequired: true });
  vi.stubEnv('VITE_APP_MODE', 'production');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://age-gate-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'age-gate-publishable-key');
  vi.stubEnv('VITE_AUTH_RESET_REDIRECT_URL', 'https://app.example.test/auth/reset-callback');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('production sign-in', () => {
  it('does not contact Supabase until the 18+ confirmation is ticked', async () => {
    renderAt('/signin');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'adult@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-real-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You must be 18 or older to sign in.');
    expect(svc.signIn).not.toHaveBeenCalled();
    svc.signIn.mockRejectedValueOnce(new Error('stop here'));
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(svc.signIn).toHaveBeenCalledTimes(1));
    expect(svc.signIn.mock.calls[0][0]).toBe('adult@example.test');
  });
});

describe('production sign-up', () => {
  const fill = async (dob: string) => {
    renderAt('/signup');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'adult@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-real-1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw-real-1' } });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  };

  it('refuses an under-18 date of birth without creating an Auth user', async () => {
    const year = new Date().getUTCFullYear() - 17;
    await fill(`${year}-12-31`);
    expect(await screen.findByRole('alert')).toHaveTextContent('You must be 18 or older to create a Gulf Mover account.');
    expect(svc.signUp).not.toHaveBeenCalled();
  });

  it('records only the 18+ confirmation — the date of birth is never sent', async () => {
    await fill('1990-05-01');
    await waitFor(() => expect(svc.signUp).toHaveBeenCalledTimes(1));
    const input = svc.signUp.mock.calls[0][0];
    expect(input).toMatchObject({ email: 'adult@example.test', ageConfirmed: true });
    expect(JSON.stringify(svc.signUp.mock.calls[0])).not.toContain('1990-05-01');
  });
});
