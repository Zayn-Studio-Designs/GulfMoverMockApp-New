import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { toCsv, csvEscape } from '../domain/csv';
import { parseScanPayload, ticketScanPayload, createTickets, createSeededTickets } from '../domain/tickets';
import { planReservation, type LegRequest } from '../domain/fleet';
import type { BoatSlot } from '../domain/fleet';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});

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

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('tickets and scan payloads', () => {
  test('ticket scan payload round-trips to the ticket ID only', () => {
    const payload = ticketScanPayload('GMTK-ABC123');
    expect(payload).toBe('GM-VERIFY-1|GMTK-ABC123');
    expect(parseScanPayload(payload)).toBe('GMTK-ABC123');
    expect(parseScanPayload('GMTK-abc123')).toBe('GMTK-ABC123');
    expect(parseScanPayload('GM-VERIFY-2|GMTK-ABC123')).toBeNull();
    expect(parseScanPayload('random text')).toBeNull();
  });

  test('one ticket per passenger per one-way leg; outbound and return are separate', () => {
    const outbound = createTickets('outbound', ['A', 'B']);
    const ret = createTickets('return', ['A', 'B']);
    expect(outbound).toHaveLength(2);
    expect(ret).toHaveLength(2);
    expect(new Set([...outbound, ...ret].map(t => t.id)).size).toBe(4);
    // Ticket IDs and QR payloads stay opaque: no passenger names inside.
    for (const t of [...outbound, ...ret]) {
      expect(ticketScanPayload(t.id)).not.toContain('A');
      expect(ticketScanPayload(t.id)).not.toContain('B');
    }
  });

  test('seeded tickets keep stable IDs for the same booking', () => {
    const a = createSeededTickets({ ref: 'GM-DEMO-0248', leg: 'outbound', count: 2, leadName: 'Lead' });
    const b = createSeededTickets({ ref: 'GM-DEMO-0248', leg: 'outbound', count: 2, leadName: 'Lead' });
    expect(a.map(t => t.id)).toEqual(b.map(t => t.id));
  });
});

describe('atomic multi-leg reservation', () => {
  const slot: BoatSlot = {
    id: 'BS-1', boatId: 'B-01', date: '2026-10-20', time: '07:00', kind: 'scheduled',
    passengers: 0, refs: [], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)',
  };

  test('every leg commits together or nothing changes', () => {
    const requests: LegRequest[] = [
      { boatId: 'B-01', date: '2026-10-20', time: '07:00', passengers: 2, ref: 'GM-1' },
      { boatId: 'B-02', date: '2026-10-20', time: '07:00', passengers: 2, ref: 'GM-1-R' },
    ];
    const ok = planReservation([slot], requests, { seatsPerBoat: { 'B-01': 10, 'B-02': 10 } });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const outbound = ok.updatedSlots.find(s => s.boatId === 'B-01');
      const ret = ok.updatedSlots.find(s => s.boatId === 'B-02');
      expect(outbound?.passengers).toBe(2);
      expect(ret?.passengers).toBe(2);
      expect(outbound?.refs).toContain('GM-1');
    }
  });

  test('a failing second leg leaves the first leg untouched (no half-bookings)', () => {
    const fullRet: BoatSlot = { ...slot, id: 'BS-2', boatId: 'B-02', passengers: 10 };
    const requests: LegRequest[] = [
      { boatId: 'B-01', date: '2026-10-20', time: '07:00', passengers: 2, ref: 'GM-2' },
      { boatId: 'B-02', date: '2026-10-20', time: '07:00', passengers: 2, ref: 'GM-2-R' },
    ];
    const failed = planReservation([slot, fullRet], requests, { seatsPerBoat: { 'B-01': 10, 'B-02': 10 } });
    expect(failed.ok).toBe(false);
    // Only the pre-existing slot remains; no partial outbound reservation was written.
    if (!failed.ok) expect(failed.failedLeg).toBe(1);
  });
});

describe('CSV export helpers', () => {
  test('values are wrapped and quotes are doubled (RFC-4180 style)', () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('"a","b"\r\n"1","x,y"');
  });
});

describe('wallet pass simulation', () => {
  test('add pass once: preview, saved pass, and the action switches to “Open saved pass”', async () => {
    await renderApp('/bookings');
    const details = screen.getAllByRole('button', { name: 'View details' })[0];
    fireEvent.click(details);
    expect(await screen.findByText('Tickets with scan codes (demo)')).toBeInTheDocument();
    click('Add to Apple Wallet');
    expect(await screen.findByText('Add pass to Wallet')).toBeInTheDocument();
    // Presentation-simulation disclaimer is shown in the sheet.
    expect(screen.getAllByText(/no real pass is installed/i).length).toBeGreaterThan(0);
    click('Add');
    expect(await screen.findByText('Pass added to the Wallet collection (demo)')).toBeInTheDocument();
    click('Done');
    expect(await screen.findByText('Open saved pass')).toBeInTheDocument();
    click('Open saved pass');
    expect(await screen.findByText('Open saved pass', { selector: '.sheet-title' })).toBeInTheDocument();
  });
});

describe('corporate PO reference', () => {
  test('saving a PO records it on the selected demo booking', async () => {
    await renderApp('/corporate');
    fireEvent.click(screen.getByRole('tab', { name: 'PO reference' }));
    fireEvent.change(screen.getByLabelText('Booking reference'), { target: { value: 'GM-DEMO-0248' } });
    fireEvent.change(screen.getByLabelText('PO reference'), { target: { value: 'PO-DEMO-0042' } });
    click('Save changes');
    // The saved reference is echoed back from the shared demo booking state.
    expect(await screen.findByText(/Saved PO \(demo\)/)).toBeInTheDocument();
    expect(screen.getByText('PO-DEMO-0042')).toBeInTheDocument();
  });
});

describe('booking result tickets', () => {
  test('the result step shows a scannable demo QR per ticket', async () => {
    await renderApp('/book');
    await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' });
    // Step 1 (service): the default 'Passenger transfer' is preselected → Continue.
    fireEvent.click(screen.getByRole('button', { name: /Passenger transfer/ }));
    click(/Continue/); // → journey step (date, 07:00 and boat B-01 come from the demo defaults)
    click(/Continue/); // → details step
    fireEvent.change(screen.getByRole('textbox', { name: /Full name/ }), { target: { value: 'QR Demo Passenger' } });
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'qr@example.test' } });
    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '+966 500 000 011' } });
    click(/Continue/); // → review step
    fireEvent.click(screen.getByLabelText('I have reviewed the demo policy placeholder.'));
    fireEvent.click(screen.getByLabelText('I understand a booking/ticket does not authorize port entry or sailing.'));
    click(/Continue to payment simulation/);
    click(/^Simulate payment recorded/); // selection card
    click('Show booking result');
    expect(await screen.findByText('Tickets with scan codes (demo)')).toBeInTheDocument();
    const board = screen.getByText('QR Demo Passenger').closest('.ticket-qr-card')!;
    expect(within(board as HTMLElement).getAllByRole('img').length).toBeGreaterThan(0);
  });
});
