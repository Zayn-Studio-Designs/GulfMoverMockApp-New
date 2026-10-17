import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';

function renderApp(path = '/') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

const heading = () => screen.getByRole('heading', { level: 1 });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('navigation', () => {
  test('every sidebar link opens its view', () => {
    renderApp();
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
    const expected: Array<[string, string]> = [
      ['My Bookings', 'My bookings'], ['Corporate / Agent', 'Corporate & agent workspace'], ['Operations', 'Operations overview'],
      ['Boarding Desk', 'Boarding desk'], ['Materials', 'Materials review'], ['Book Transfer', 'Book a marine transfer'],
    ];
    for (const [link, title] of expected) {
      fireEvent.click(within(nav).getByRole('link', { name: link }));
      expect(heading()).toHaveTextContent(title);
    }
  });

  test('unknown routes fall back to booking', () => {
    renderApp('/nope');
    expect(heading()).toHaveTextContent('Book a marine transfer');
  });
});

describe('language toggle', () => {
  test('Arabic translates the UI and switches to RTL; English restores it', () => {
    renderApp('/operations');
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

  test('demo state survives a language switch', () => {
    renderApp('/');
    click(/Material transfer/);
    click('العربية');
    expect(screen.getByRole('button', { name: /نقل مواد/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('booking flow', () => {
  test('return leg doubles the fare and statuses stay separate', () => {
    renderApp('/');
    click(/Continue/);
    fireEvent.change(screen.getByLabelText(/Passengers/), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('Add a return leg'));
    expect(screen.getByText('Return sailing')).toBeInTheDocument();
    click(/Continue/);

    click(/Continue/);
    expect(screen.getByRole('alert')).toHaveTextContent('Please complete the name, email and phone fields.');
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'Demo Passenger' } });
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
});

describe('boarding', () => {
  test('a repeated scan is rejected and does not board twice', () => {
    renderApp('/boarding');
    click('Simulate valid QR scan');
    click('Scan the same ticket again');
    expect(screen.getAllByText(/Already scanned — exception required/).length).toBeGreaterThan(0);
    const boarded = screen.getByText('Boarded (demo)').parentElement!;
    expect(within(boarded).getByText('1')).toBeInTheDocument();
  });
});

describe('materials', () => {
  test('a decision requires a reason before it is recorded', () => {
    renderApp('/materials');
    click('Approve with conditions');
    click('Confirm');
    expect(screen.getByText('Please enter a reason to continue.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason / notes'), { target: { value: 'Demo condition' } });
    click('Confirm');
    expect(screen.getAllByText('Approved with conditions (demo)').length).toBeGreaterThan(0);
  });
});

describe('reset demo data', () => {
  test('restores the initial sample after a change', () => {
    renderApp('/operations');
    fireEvent.click(screen.getAllByRole('button', { name: 'Suspend sailing' })[0]);
    fireEvent.change(screen.getByLabelText('Reason / notes'), { target: { value: 'Weather (demo)' } });
    click('Confirm');
    expect(screen.getAllByText('Suspended (demo)').length).toBeGreaterThan(0);
    click('Reset demo data');
    expect(screen.queryAllByText('Suspended (demo)').filter(el => el.tagName === 'SPAN')).toHaveLength(0);
  });
});
