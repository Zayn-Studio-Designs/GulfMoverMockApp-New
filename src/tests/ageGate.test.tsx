// Age of consent (18+): the date rule itself and the demo-mode sign-in / sign-up screens.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { MINIMUM_AGE, ageOn, checkDateOfBirth, latestEligibleDateOfBirth, todayInRiyadh } from '../domain/age';
import { confirmAge, enterAdultDob } from './ageGate';

describe('age rule (domain)', () => {
  it('the minimum age is 18', () => { expect(MINIMUM_AGE).toBe(18); });

  it('counts whole years, turning a year older on the birthday itself', () => {
    expect(ageOn('2008-10-31', '2026-10-30')).toBe(17);
    expect(ageOn('2008-10-31', '2026-10-31')).toBe(18);
    expect(ageOn('2008-10-31', '2026-11-01')).toBe(18);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageOn('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('rejects impossible, malformed, future and implausible dates', () => {
    const now = new Date('2026-10-31T09:00:00Z');
    for (const bad of ['', 'not-a-date', '2001-02-30', '1990-13-01', '31/10/1990', '2030-01-01', '1890-01-01']) {
      expect(checkDateOfBirth(bad, now)).toBe('invalid');
    }
  });

  it('accepts exactly 18 and refuses 17 years 364 days', () => {
    const now = new Date('2026-10-31T09:00:00Z');
    expect(checkDateOfBirth('2008-10-31', now)).toBe('ok');
    expect(checkDateOfBirth('2008-11-01', now)).toBe('under-age');
    expect(checkDateOfBirth('1980-06-15', now)).toBe('ok');
  });

  it('uses the Saudi calendar date, not the device time zone', () => {
    // 21:30 UTC on 30 Oct is already 00:30 on 31 Oct in Riyadh (UTC+3).
    const now = new Date('2026-10-30T21:30:00Z');
    expect(todayInRiyadh(now)).toBe('2026-10-31');
    expect(checkDateOfBirth('2008-10-31', now)).toBe('ok');
  });

  it('the date picker limit is the latest eligible birthday (leap-day safe)', () => {
    expect(latestEligibleDateOfBirth(new Date('2026-10-31T09:00:00Z'))).toBe('2008-10-31');
    expect(latestEligibleDateOfBirth(new Date('2028-02-29T09:00:00Z'))).toBe('2010-02-28');
  });
});

function renderAt(path: string) {
  return render(<AppProviders><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></AppProviders>);
}
const SESSION_KEY = 'gm-demo-session';
const accounts = () => JSON.parse(localStorage.getItem('gm-demo-accounts') ?? '[]') as Array<{ email: string }>;

describe('sign-in screen (demo mode)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); document.documentElement.dir = 'ltr'; document.documentElement.lang = 'en'; });

  it('shows an unticked 18+ confirmation on the sign-in form', async () => {
    renderAt('/signin');
    const box = await screen.findByRole('checkbox', { name: 'I confirm that I am 18 years of age or older.' });
    expect(box).not.toBeChecked();
  });

  it('refuses the demo guest until the user confirms they are 18 or older', async () => {
    renderAt('/signin');
    fireEvent.click(await screen.findByRole('button', { name: 'Explore as demo guest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You must be 18 or older to sign in. Confirm your age to continue.');
    expect(screen.queryAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(0);
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
    expect((await screen.findAllByRole('navigation', { name: 'Main navigation' })).length).toBeGreaterThan(0);
  });

  it('refuses a simulated provider sign-in until age is confirmed', async () => {
    renderAt('/signin');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You must be 18 or older to sign in.');
    expect(screen.queryByText('Connecting to Google…')).toBeNull();
  });

  it('refuses a correct password without the age confirmation, then signs in once confirmed', async () => {
    const first = renderAt('/signup');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'adult@example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'adult.user' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Demo Co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-demo-1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw-demo-1' } });
    enterAdultDob();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findAllByRole('navigation', { name: 'Main navigation' });
    first.unmount();
    localStorage.removeItem(SESSION_KEY); sessionStorage.clear(); // signed out, account kept

    renderAt('/signin');
    fireEvent.change(await screen.findByLabelText('Email or username'), { target: { value: 'adult@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-demo-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You must be 18 or older to sign in.');
    expect(screen.queryAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(0);
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findAllByRole('navigation', { name: 'Main navigation' })).length).toBeGreaterThan(0);
  });
});

describe('sign-up screen (demo mode)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  const fill = async (dob: string) => {
    renderAt('/signup');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'young@example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'young.user' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Demo Co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-demo-1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw-demo-1' } });
    if (dob) fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  };

  it('asks for a date of birth and says it is not stored', async () => {
    renderAt('/signup');
    expect(await screen.findByLabelText('Date of birth')).toHaveAttribute('type', 'date');
    expect(screen.getByText(/only used to check your age and is not stored/)).toBeInTheDocument();
  });

  it('refuses an under-18 date of birth and creates no account', async () => {
    const seventeen = `${Number(todayInRiyadh().slice(0, 4)) - 17}-01-01`;
    await fill(seventeen);
    expect(await screen.findByRole('alert')).toHaveTextContent('You must be 18 or older to create a Gulf Mover account.');
    expect(accounts().some(a => a.email === 'young@example.test')).toBe(false);
  });

  it('requires a date of birth', async () => {
    await fill('');
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid date of birth.');
    expect(accounts()).toHaveLength(0);
  });

  it('creates the account for an adult and never stores the date of birth', async () => {
    await fill('1990-05-01');
    await screen.findAllByRole('navigation', { name: 'Main navigation' });
    expect(accounts().some(a => a.email === 'young@example.test')).toBe(true);
    expect(localStorage.getItem('gm-demo-accounts')).not.toContain('1990-05-01');
  });

  it('is fully translated in Arabic', async () => {
    renderAt('/signin');
    fireEvent.click(await screen.findByRole('button', { name: 'العربية' }));
    expect(await screen.findByRole('checkbox', { name: 'أؤكد أن عمري 18 عاماً أو أكثر.' })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
  });
});
