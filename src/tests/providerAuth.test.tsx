import { confirmAge, enterAdultDob } from './ageGate';
import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';

// The provider simulation runs on a short deterministic timeline (connect + success beats).
const FLOW_MS = 2000; // comfortably above the full ~1.75s sequence; tests use real timers

function renderAuth(path = '/signin') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});

const demoAccounts = () => JSON.parse(localStorage.getItem('gm-demo-accounts') ?? '[]') as Array<{ email: string }>;

describe('provider sign-in buttons', () => {
  test('sign-in screen offers Google and Apple with provider-correct labels', () => {
    renderAuth();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeInTheDocument();
    // The existing email/password flow stays untouched.
    expect(screen.getByLabelText('Email or username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explore as demo guest' })).toBeInTheDocument();
  });

  test('sign-up screen switches the labels to "Sign up with …"', async () => {
    renderAuth('/signup');
    expect(screen.getByRole('button', { name: 'Sign up with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up with Apple' })).toBeInTheDocument();
    // And the email/password form is still there for the real product's flow.
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
  });
});

describe('simulated provider flow (frontend only — no real OAuth)', () => {
  test('Google: disabled while running, connecting → success → signed in to the demo', async () => {
    renderAuth();
    const google = screen.getByRole('button', { name: 'Sign in with Google' });
    confirmAge();
    fireEvent.click(google);

    // Duplicate clicks are blocked: the provider buttons are disabled during the sequence.
    expect(google).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeDisabled();
    expect(screen.getByTestId('provider-connecting')).toBeInTheDocument();
    expect(screen.getByText('Demo mode — no real account is created and nothing is sent to Google or Apple.')).toBeInTheDocument();

    // The connecting state resolves into the success state on screen.
    await waitFor(() => expect(screen.getByText('Signed in with Google')).toBeInTheDocument(), { timeout: FLOW_MS });

    // Then the app continues into its existing signed-in flow.
    await waitFor(() => expect(screen.getAllByRole('navigation', { name: 'Main navigation' })[0]).toBeInTheDocument(), { timeout: FLOW_MS });

    // Demo-only session: a labelled demo account marker in the existing demo store, never a
    // user-entered email/password, and nothing beyond the browser.
    expect(demoAccounts()).toContainEqual(expect.objectContaining({ email: 'provider-google@demo.test' }));
    expect(JSON.parse(localStorage.getItem('gm-demo-session') ?? 'null')).toBeTruthy();
  });

  test('Apple on sign-up shows "Account created with Apple" and completes', async () => {
    renderAuth('/signup');
    enterAdultDob();
    fireEvent.click(screen.getByRole('button', { name: 'Sign up with Apple' }));
    const appleButton = screen.getByRole('button', { name: 'Sign up with Apple' });
    expect(appleButton).toBeDisabled();

    await waitFor(() => expect(screen.getByText('Account created with Apple')).toBeInTheDocument(), { timeout: FLOW_MS });
    await waitFor(() => expect(screen.getAllByRole('navigation', { name: 'Main navigation' })[0]).toBeInTheDocument(), { timeout: FLOW_MS });
    expect(demoAccounts()).toContainEqual(expect.objectContaining({ email: 'provider-apple@demo.test' }));
  });

  test('cancelling during the connecting state keeps the user signed out', async () => {
    renderAuth();
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(screen.getByTestId('provider-connecting')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Overlay closes; no session was started.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled());
    expect(JSON.parse(localStorage.getItem('gm-demo-session') ?? 'null')).toBeNull();
    expect(demoAccounts()).toHaveLength(0);
  });

  test('sign-out after a provider session returns the logged-out screen', async () => {
    renderAuth();
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Apple' }));
    await screen.findAllByRole('navigation', { name: 'Main navigation' }, { timeout: FLOW_MS });
    // Sign out from the header's account menu, like a real user would.
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument(), { timeout: FLOW_MS });
    expect(JSON.parse(localStorage.getItem('gm-demo-session') ?? 'null')).toBeNull();
  });
});
