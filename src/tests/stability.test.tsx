// Regression tests for the 0-2 stability batch: crash recovery, damaged saved data, the tour
// bounce-back, the signed-out help button, the camera off/on race and spreadsheet formula injection.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { AppCrashScreen, ErrorBoundary } from '../components/ErrorBoundary';
import { Layout } from '../components/Layout';
import AuthView from '../pages/AuthView';
import CustomerHome from '../pages/CustomerHome';
import { csvEscape, toCsv } from '../domain/csv';
import { useCameraScanner } from '../hooks/useCameraScanner';

function renderSignedOut(path = '/') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

async function renderApp(path = '/') {
  const view = renderSignedOut(path);
  fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
  await screen.findAllByRole('navigation', { name: 'Main navigation' });
  return view;
}

const heading = () => screen.getByRole('heading', { level: 1 });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

/** Render errors are expected in some tests; keep the test output readable. */
function silenceErrors() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mockRestore();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});

describe('spreadsheet exports', () => {
  test('text that a spreadsheet would run as a formula is exported as plain text', () => {
    expect(csvEscape('=HYPERLINK("http://example.test","x")')).toBe('"\'=HYPERLINK(""http://example.test"",""x"")"');
    expect(csvEscape('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvEscape('+1+2')).toBe('"\'+1+2"');
    expect(csvEscape('-2+3')).toBe('"\'-2+3"');
    expect(csvEscape('\t=1')).toBe('"\'\t=1"');
  });

  test('ordinary values and plain numbers are unchanged', () => {
    expect(csvEscape('Mariam Demo')).toBe('"Mariam Demo"');
    expect(csvEscape(-5)).toBe('"-5"');
    expect(csvEscape('-12.5')).toBe('"-12.5"');
    expect(csvEscape('+966500000010')).toBe('"+966500000010"');
    expect(toCsv(['Name'], [['=1+1']])).toBe('"Name"\r\n"\'=1+1"');
  });
});

describe('damaged saved data', () => {
  test('a non-list accounts value does not stop the app from starting', async () => {
    localStorage.setItem('gm-demo-accounts', '{"oops":true}');
    await renderApp('/');
    expect(heading()).toHaveTextContent('Home');
  });

  test('a damaged accounts entry is skipped, valid accounts still sign in, and the original is kept', async () => {
    // Create a real demo account, then damage the saved list around it.
    const first = renderSignedOut('/');
    click(/^Create an account$/);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'keep@example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'keep.me' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Keep Co.' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'harbour2026' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'harbour2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    first.unmount();

    const saved = JSON.parse(localStorage.getItem('gm-demo-accounts') as string) as unknown[];
    const damaged = JSON.stringify([null, 7, { id: 'U-x' }, ...saved]);
    localStorage.setItem('gm-demo-accounts', damaged);
    localStorage.removeItem('gm-demo-session');
    sessionStorage.clear();

    renderSignedOut('/signin');
    fireEvent.change(await screen.findByLabelText('Email or username'), { target: { value: 'keep.me' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'harbour2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    // Loading never rewrites the saved list, and a copy of the damaged original is kept.
    expect(localStorage.getItem('gm-demo-accounts')).toBe(damaged);
    expect(localStorage.getItem('gm-demo-accounts-damaged')).toBe(damaged);
  });

  test('a damaged "tour seen" list does not stop a new account from starting (the tour still opens once)', async () => {
    localStorage.setItem('gm-demo-tour-seen', '{}');
    renderSignedOut('/');
    click(/^Create an account$/);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'tour@example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'tour.user' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Tour Co.' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'harbour2026' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'harbour2026' } });
    const restore = silenceErrors();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    } finally { restore(); }
    expect(screen.getByRole('dialog', { name: 'Welcome to ATCO Marine' })).toBeInTheDocument();
  });

  test('damaged booking data falls back to the sample data and keeps a copy of the original', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    const damaged = JSON.stringify({ savedAt: today, sailings: [], bookings: [null], boatSlots: [], materials: [], audit: [], passes: [] });
    localStorage.setItem('gm-demo-state-v1', damaged);
    const restore = silenceErrors();
    try {
      await renderApp('/bookings');
    } finally { restore(); }
    expect(heading()).toHaveTextContent('My bookings');
    expect(localStorage.getItem('gm-demo-state-v1-damaged')).toBe(damaged);
  });
});

describe('guided tour and help button', () => {
  test('following the highlighted button during the tour does not bounce back', async () => {
    await renderApp('/');
    click('Take the tour');
    click(/^Next/);
    expect(screen.getByRole('dialog', { name: 'Your home screen' })).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-tour="home-book"]') as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' })).toBeInTheDocument();
    await act(() => new Promise(r => setTimeout(r, 50)));
    expect(heading()).toHaveTextContent('Book a marine transfer');
    // The tour is still open and Next still moves it forward from where the user is.
    expect(screen.getByRole('dialog', { name: 'Your home screen' })).toBeInTheDocument();
  });

  test('signed-out visitors on the public ATCO page get no help/tour button', async () => {
    renderSignedOut('/settings?tab=atco');
    expect(await screen.findByRole('heading', { name: 'ATCO information' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take the tour' })).toBeNull();
  });

  test('signed-in users still get the help/tour button', async () => {
    await renderApp('/');
    expect(screen.getByRole('button', { name: 'Take the tour' })).toBeInTheDocument();
  });
});

describe('Boarding Desk camera', () => {
  type Track = { stop: ReturnType<typeof vi.fn> };
  const pending: Array<{ resolve: (s: MediaStream) => void; tracks: Track[] }> = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  beforeEach(() => {
    pending.length = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => new Promise<MediaStream>(resolve => {
          const tracks: Track[] = [{ stop: vi.fn() }];
          pending.push({ resolve, tracks });
        }),
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  const streamOf = (tracks: Track[]) => ({ getTracks: () => tracks }) as unknown as MediaStream;

  test('a quick off/on never leaves an earlier camera stream running', async () => {
    const { rerender, result, unmount } = renderHook(({ on }) => useCameraScanner(on, () => {}), { initialProps: { on: true } });
    // Pretend a video element is mounted.
    result.current.videoRef.current = Object.assign(document.createElement('video'), { play: () => Promise.resolve() });
    rerender({ on: false });
    rerender({ on: true });
    expect(pending).toHaveLength(2);
    // The first permission request resolves only after the camera was turned back on.
    await act(async () => { pending[0].resolve(streamOf(pending[0].tracks)); });
    expect(pending[0].tracks[0].stop).toHaveBeenCalled();
    await act(async () => { pending[1].resolve(streamOf(pending[1].tracks)); });
    expect(pending[1].tracks[0].stop).not.toHaveBeenCalled();
    unmount();
    expect(pending[1].tracks[0].stop).toHaveBeenCalled();
  });
});

describe('crash recovery', () => {
  const Boom = () => { throw new Error('screen failed'); };

  test('a page that fails shows a recovery card; the menu still works and another page loads', async () => {
    const restore = silenceErrors();
    try {
      render(
        <AppProviders>
          <MemoryRouter initialEntries={['/boom']}>
            <Routes>
              <Route path="/signin" element={<AuthView />} />
              <Route element={<Layout />}>
                <Route path="/" element={<CustomerHome />} />
                <Route path="/boom" element={<Boom />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AppProviders>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Explore as demo guest' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('This screen could not be shown');
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
      fireEvent.click(within(nav).getByRole('link', { name: 'Home' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
      expect(screen.queryByText('This screen could not be shown')).toBeNull();
    } finally { restore(); }
  });

  test('a failure outside any page shows the whole-app recovery screen instead of a blank page', () => {
    const restore = silenceErrors();
    try {
      render(<ErrorBoundary fallback={() => <AppCrashScreen />}><Boom /></ErrorBoundary>);
    } finally { restore(); }
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in the demo');
    expect(screen.getByRole('button', { name: /Reload/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reset demo bookings/ })).toBeInTheDocument();
  });
});
