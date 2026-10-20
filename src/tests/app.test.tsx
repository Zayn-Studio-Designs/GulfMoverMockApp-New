import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';

function renderSignedOut(path = '/') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

/** Opens the app at `path` signed in as the built-in demo guest. */
async function renderApp(path = '/') {
  const view = renderSignedOut(path);
  fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
  await screen.findAllByRole('navigation', { name: 'Main navigation' });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});

const heading = () => screen.getByRole('heading', { level: 1 });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('navigation', () => {
  test('customer view shows only customer destinations', async () => {
    await renderApp();
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
    for (const name of ['Home', 'Book Transfer', 'My Bookings', 'Account']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: 'Operations' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Boarding Desk' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Materials' })).toBeNull();
  });

  test('staff view exposes management destinations', async () => {
    await renderApp();
    click('ATCO staff (demo)');
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
    const expected: Array<[string, string]> = [
      ['My Bookings', 'My bookings'], ['Corporate / Agent', 'Corporate & agent workspace'], ['Operations', 'Operations overview'],
      ['Boarding Desk', 'Boarding desk'], ['Materials', 'Materials review'], ['Fleet', 'Fleet & boat bookings'], ['Book Transfer', 'Book a marine transfer'],
    ];
    for (const [link, title] of expected) {
      fireEvent.click(within(nav).getByRole('link', { name: link }));
      expect(heading()).toHaveTextContent(title);
    }
  });

  test('demo view choice persists across a reload', async () => {
    const view = await renderApp();
    click('ATCO staff (demo)');
    expect(localStorage.getItem('gm-demo-workspace')).toBe('staff');
    view.unmount();
    renderSignedOut();
    const nav = (await screen.findAllByRole('navigation', { name: 'Main navigation' }))[0];
    expect(within(nav).getByRole('link', { name: 'Operations' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Boarding Desk' })).toBeInTheDocument();
  });

  test('unknown routes fall back to the customer home', async () => {
    await renderApp('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  });
});

describe('customer home', () => {
  test('shows the booking CTA and the next demo trip', async () => {
    await renderApp('/');
    expect(screen.getByRole('button', { name: 'Book a marine transfer' })).toBeInTheDocument();
    // The sample bookings habit is fictional but present: next-trip card shows the first ref.
    expect(screen.getByText('GM-DEMO-0248')).toBeInTheDocument();
    expect(screen.getAllByText('Awaiting ATCO decision').length).toBeGreaterThan(0);
  });

  test('the CTA opens the booking wizard', async () => {
    await renderApp('/');
    click('Book a marine transfer');
    expect(await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' })).toBeInTheDocument();
    expect(screen.getByText('What do you need to arrange?')).toBeInTheDocument();
  });
});

describe('language toggle', () => {
  test('Arabic translates the UI and switches to RTL; English restores it', async () => {
    await renderApp('/operations');
    click('العربية');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(heading()).toHaveTextContent('نظرة عامة على العمليات');
    expect(screen.getAllByText('منطقة الرسو المعتمدة أ (تجريبي)').length).toBeGreaterThan(0);
    expect(screen.queryByText('Approved Anchorage A (Demo)')).toBeNull();
    click('EN');
    expect(document.documentElement.dir).toBe('ltr');
    expect(heading()).toHaveTextContent('Operations overview');
  });

  test('demo state survives a language switch', async () => {
    await renderApp('/book');
    click(/Material transfer/);
    click('العربية');
    expect(screen.getByRole('button', { name: /نقل مواد/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('booking flow', () => {
  test('return leg doubles the fare and statuses stay separate', async () => {
    await renderApp('/');
    click('Book a marine transfer');
    await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' });
    click(/Continue/);
    fireEvent.change(screen.getByLabelText(/Passengers/), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('Add a return leg'));
    expect(screen.getByText('Return sailing')).toBeInTheDocument();
    click(/Continue/);

    click(/Continue/);
    expect(screen.getByRole('alert')).toHaveTextContent('Please complete the name, email and phone fields.');
    // pax = 2 also renders a per-ticket “Passenger 2 name” field, so target the textbox role.
    fireEvent.change(screen.getByRole('textbox', { name: /^Full name/ }), { target: { value: 'Demo Passenger' } });
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'demo@example.test' } });
    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '+966 500 000 000' } });
    click(/Continue/);

    expect(screen.getByText('Return leg')).toBeInTheDocument();
    expect(screen.getByText('SAR 2,000')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('I have reviewed the demo policy placeholder.'));
    fireEvent.click(screen.getByLabelText('I understand a booking/ticket does not authorize port entry or sailing.'));
    click(/Continue to payment simulation/);

    expect(screen.getByRole('button', { name: 'Show booking result' })).toBeDisabled();
    click(/Simulate payment recorded/);
    click('Show booking result');

    expect(screen.getByText('Booking result')).toBeInTheDocument();
    // 07:00 already holds 2 tickets; this booking adds 2 more → minimum met across bookings.
    expect(screen.getAllByText('Minimum met (demo)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Awaiting ATCO decision').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0);
    expect(screen.getByText(/separate sailing and ticket/)).toBeInTheDocument();
  });

  test('demo bookings persist in localStorage across an app remount', async () => {
    const view = await renderApp('/');
    click('Book a marine transfer');
    await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' });
    click(/Continue/);
    click(/Continue/);
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'Persist Passenger' } });
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'persist@example.test' } });
    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '+966 500 000 009' } });
    click(/Continue/);
    fireEvent.click(screen.getByLabelText('I have reviewed the demo policy placeholder.'));
    fireEvent.click(screen.getByLabelText('I understand a booking/ticket does not authorize port entry or sailing.'));
    click(/Continue to payment simulation/);
    click(/Simulate payment recorded/);
    click('Show booking result');
    expect(screen.getByText('GM-DEMO-3203')).toBeInTheDocument();
    view.unmount();
    renderSignedOut('/bookings');
    await screen.findAllByRole('navigation', { name: 'Main navigation' });
    expect(await screen.findByText('GM-DEMO-3203')).toBeInTheDocument();
  });
});

describe('boarding', () => {
  test('a repeated verification is rejected and does not board twice', async () => {
    await renderApp('/boarding');
    // The real demo ticket list supplies an opaque ticket ID (no passenger data in it).
    const ticketId = screen.getAllByText(/GMTK-/)[0].textContent as string;
    const input = screen.getByLabelText('QR payload, ticket ID or booking reference');
    fireEvent.change(input, { target: { value: ticketId } });
    click('Verify');
    expect(screen.getAllByText(/Boarding recorded for this ticket/).length).toBeGreaterThan(0);
    fireEvent.change(input, { target: { value: ticketId } });
    click('Verify');
    expect(screen.getAllByText(/This ticket was already boarded/).length).toBeGreaterThan(0);
  });
});

describe('materials', () => {
  test('a decision requires a reason before it is recorded', async () => {
    await renderApp('/materials');
    click('Approve with conditions');
    click('Confirm');
    expect(screen.getByText('Please enter a reason to continue.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason / notes'), { target: { value: 'Demo condition' } });
    click('Confirm');
    expect(screen.getAllByText('Approved with conditions (demo)').length).toBeGreaterThan(0);
  });
});

describe('reset demo data', () => {
  test('restores the initial sample after a change', async () => {
    await renderApp('/operations');
    fireEvent.click(screen.getAllByRole('button', { name: 'Suspend sailing' })[0]);
    fireEvent.change(screen.getByLabelText('Reason / notes'), { target: { value: 'Weather (demo)' } });
    click('Confirm');
    expect(screen.getAllByText('Suspended (demo)').length).toBeGreaterThan(0);
    click('Reset demo data');
    expect(screen.queryAllByText('Suspended (demo)').filter((el: HTMLElement) => el.tagName === 'SPAN')).toHaveLength(0);
  });
});

describe('boats cannot be double-booked', () => {
  const boat = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

  test('a chartered boat cannot be booked, and a new charter takes the boat', async () => {
    await renderApp('/');
    click('Book a marine transfer');
    await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' });
    click(/Dedicated trip \/ charter/);
    click(/Continue/);
    fireEvent.change(screen.getByLabelText(/Departure time/), { target: { value: '13:00' } });
    // Boat 3 is already chartered at 1:00 PM; Boat 1 already has passengers; Boat 2 is free.
    expect(boat('Boat 3')).toBeDisabled();
    expect(boat('Boat 3')).toHaveTextContent('Taken — chartered');
    expect(boat('Boat 1')).toBeDisabled();
    expect(boat('Boat 2')).toBeEnabled();
    fireEvent.click(boat('Boat 2'));
    click(/Continue/);
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'Demo Charterer' } });
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'charter@example.test' } });
    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '+966 500 000 001' } });
    click(/Continue/);
    fireEvent.click(screen.getByLabelText('I have reviewed the demo policy placeholder.'));
    fireEvent.click(screen.getByLabelText('I understand a booking/ticket does not authorize port entry or sailing.'));
    click(/Submit charter request/);
    expect(heading()).toHaveTextContent('Fleet & boat bookings');

    // Now a passenger booking for Boat 2 at the same time is blocked.
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
    fireEvent.click(within(nav).getByRole('link', { name: 'Book Transfer' }));
    click(/Continue/);
    fireEvent.change(screen.getByLabelText(/Departure time/), { target: { value: '13:00' } });
    expect(boat('Boat 2')).toBeDisabled();
    expect(boat('Boat 1')).toBeEnabled();
  });

  test('departure times cover 24 hours in AM/PM', async () => {
    await renderApp('/');
    click('Book a marine transfer');
    await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' });
    click(/Continue/);
    const options = within(screen.getByLabelText(/Departure time/)).getAllByRole('option');
    expect(options).toHaveLength(25);
    expect(options[0]).toHaveTextContent('12:00 AM');
    expect(options.some(o => /1:00 PM/.test(o.textContent ?? ''))).toBe(true);
    expect(options.some(o => /11:00 PM/.test(o.textContent ?? ''))).toBe(true);
  });

  test('fleet page lists each boat and its bookings', async () => {
    await renderApp('/fleet');
    expect(screen.getAllByText('Boat 1 (name pending)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Boat 3 (name pending)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Demo Charter Client (fictional)').length).toBeGreaterThan(0);
  });
});

describe('accounts', () => {
  test('signed-out visitors see the sign-in page', () => {
    renderSignedOut('/operations');
    expect(heading()).toHaveTextContent('Sign in');
  });

  test('sign up validates input, then signs the user in', async () => {
    renderSignedOut('/');
    click(/^Create an account$/);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ops.user' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Example Marine Co.' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 8 characters');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'harbour2026' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'harbour2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(localStorage.getItem('gm-demo-accounts')).not.toContain('harbour2026');
  });

  test('settings: edit profile, change password, sign out and sign back in', async () => {
    renderSignedOut('/');
    click(/^Create an account$/);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'agent@example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'agent1' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Agent Demo Co.' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'firstpass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'firstpass1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    click('Account menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile' }));
    expect(heading()).toHaveTextContent('Settings');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'agent2' } });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Sample Agent' } });
    click('Save changes');
    click('Company');
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Renamed Co.' } });
    fireEvent.change(screen.getByLabelText('Website (optional)'), { target: { value: 'not a site' } });
    click('Save changes');
    expect(screen.getByRole('alert')).toHaveTextContent('valid website');
    fireEvent.change(screen.getByLabelText('Website (optional)'), { target: { value: 'www.renamed.example' } });
    click('Save changes');
    click('Account menu');
    expect(screen.getByRole('menu')).toHaveTextContent('Sample Agent');
    expect(screen.getByRole('menu')).toHaveTextContent('Renamed Co.');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Security & password' }));

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrongpass1' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'secondpass2' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'secondpass2' } });
    click('Update password');
    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'firstpass1' } });
    click('Update password');
    await screen.findByText('Password updated.');

    click('Account');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'agent2' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'firstpass1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('incorrect');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secondpass2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  });

  async function signUpAs(email: string, username: string, password: string) {
    renderSignedOut('/');
    click(/^Create an account$/);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Example Marine Co.' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    // From the customer home, go through the account menu like a real user.
    click('Account menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to ATCO staff view' }));
    expect(await screen.findByRole('link', { name: 'Operations' })).toBeInTheDocument();
  }

  test('settings: change email needs the current password', async () => {
    await signUpAs('first@example.test', 'emailer', 'harbour2026');
    click('Account menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Security & password' }));
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'second@example.test' } });
    fireEvent.change(screen.getByLabelText('Current password (to confirm)'), { target: { value: 'wrongpass1' } });
    click('Change email');
    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Current password (to confirm)'), { target: { value: 'harbour2026' } });
    click('Change email');
    expect(await screen.findByText('second@example.test')).toBeInTheDocument();
    expect(localStorage.getItem('gm-demo-accounts')).toContain('second@example.test');
  });

  test('forgot password: a reset code is required to set a new password', async () => {
    await signUpAs('reset@example.test', 'resetter', 'harbour2026');
    click('Account menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    click('Forgot password?');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'reset@example.test' } });
    click('Send reset code');
    const code = (await screen.findByText(/^\d{6}$/)).textContent!;
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: code === '000000' ? '111111' : '000000' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass2027' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'newpass2027' } });
    click('Set new password');
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong or has expired');
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: code } });
    click('Set new password');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await waitFor(() => expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'resetter' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'newpass2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  });
});

describe('ATCO branding', () => {
  test('booking page shows ATCO branding, the Dammam city choice and a compact Contact ATCO link', async () => {
    await renderApp('/book');
    expect(screen.getAllByText('ATCO Marine').length).toBeGreaterThan(0);
    expect(screen.getByText('ATCO Marine transfers, booked in minutes.')).toBeInTheDocument();
    // The full details no longer sit at the bottom of the page…
    expect(screen.queryByRole('link', { name: '+966 13 833 5588' })).toBeNull();
    // …Contact ATCO opens Settings → ATCO information, which has them, with a way back.
    fireEvent.click(screen.getByRole('link', { name: /Contact ATCO/ }));
    expect(await screen.findByRole('heading', { name: 'ATCO information' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+966 13 833 5588' })).toHaveAttribute('href', 'tel:+966138335588');
    expect(screen.getByRole('link', { name: 'marine.info@atco.com.sa' })).toBeInTheDocument();
    click(/Back/);
    expect(await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' })).toBeInTheDocument();
    click(/Passenger transfer/);
    click(/Continue/);
    const city = screen.getByLabelText(/^City/) as HTMLSelectElement;
    expect([...city.options].map(o => o.textContent)).toEqual(['Dammam']);
  });
});

describe('Contact ATCO before sign-in', () => {
  test('the sign-in page links to Settings → ATCO information without requiring an account', async () => {
    renderSignedOut('/signin');
    fireEvent.click(screen.getByRole('link', { name: /Contact ATCO/ }));
    expect(await screen.findByRole('heading', { name: 'ATCO information' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'marine.info@atco.com.sa' })).toBeInTheDocument();
    click(/Back/);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});
