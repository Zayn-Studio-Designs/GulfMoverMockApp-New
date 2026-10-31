import { confirmAge } from './ageGate';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createTickets, createSeededTickets, ticketScanPayload } from '../domain/tickets';
import { initialBookings } from '../data/demoData';

const PERSIST_KEY = 'gm-demo-state-v1';

interface SavedTicket { id: string; leg: string; passengerName: string; status: string }
interface SavedBooking { ref: string; tickets: SavedTicket[] }

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

async function renderApp(path = '/') {
  const view = renderSignedOut(path);
  // A previous render in the same test may already have signed the demo guest in.
  const guest = screen.queryByRole('button', { name: 'Explore as demo guest' });
  if (guest) { confirmAge(); fireEvent.click(guest); }
  await screen.findAllByRole('navigation', { name: 'Main navigation' });
  return view;
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const savedBookings = (): SavedBooking[] => {
  const raw = localStorage.getItem(PERSIST_KEY);
  return raw ? (JSON.parse(raw).bookings as SavedBooking[]) : [];
};
const resultFacts = () =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLElement>('.result-fact')].map(row => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ]),
  );
const qrCards = () => [...document.querySelectorAll<HTMLElement>('.ticket-qr-card')];
const payloadsOnScreen = () => [...document.querySelectorAll('.qr-payload')].map(el => el.textContent ?? '');

/** Walks the real booking wizard (service → journey → details → review → payment → result). */
async function bookTickets({ pax = 1, addReturn = false } = {}) {
  const view = await renderApp('/book');
  await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' });
  fireEvent.click(screen.getByRole('button', { name: /Passenger transfer/ }));
  click(/Continue/); // → journey
  if (pax > 1) fireEvent.change(screen.getByLabelText(/Passengers/), { target: { value: String(pax) } });
  if (addReturn) fireEvent.click(screen.getByLabelText('Add a return leg'));
  click(/Continue/); // → details
  fireEvent.change(screen.getByRole('textbox', { name: /^Full name/ }), { target: { value: 'Lead Passenger' } });
  fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'tickets@example.test' } });
  fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '+966 500 000 031' } });
  for (let n = 2; n <= pax; n++) {
    fireEvent.change(screen.getByLabelText(`Passenger ${n} name`), { target: { value: `Second Passenger ${n}` } });
  }
  click(/Continue/); // → review
  fireEvent.click(screen.getByLabelText('I have reviewed the demo policy placeholder.'));
  fireEvent.click(screen.getByLabelText('I understand a booking/ticket does not authorize port entry or sailing.'));
  click(/Continue to payment simulation/);
  click(/Simulate payment recorded/);
  click('Show booking result');
  await screen.findByRole('heading', { name: 'Booking confirmed (demo)' });
  const ref = document.querySelector('.result-fact dd.mono')?.textContent ?? '';
  const ids = [...document.querySelectorAll('.ticket-qr-card .ticket-id')].map(el => el.textContent ?? '');
  return { view, ref, ids, payloads: payloadsOnScreen() };
}

describe('ticket identity', () => {
  test('every ticket gets its own id and payload, even for the same passenger and leg', () => {
    const outbound = createTickets('outbound', ['Same Passenger', 'Same Passenger']);
    const ret = createTickets('return', ['Same Passenger', 'Same Passenger']);
    const all = [...outbound, ...ret];
    const ids = all.map(t => t.id);
    const payloads = ids.map(ticketScanPayload);
    expect(new Set(ids).size).toBe(4);
    expect(new Set(payloads).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^GMTK-[0-9a-z]+$/);
  });

  test('an id already used by another ticket is rejected and replaced', () => {
    const first = createTickets('outbound', ['A', 'B']);
    const seen = new Set(first.map(t => t.id));
    const second = createTickets('outbound', ['A', 'B'], id => seen.has(id));
    for (const ticket of second) expect(seen.has(ticket.id)).toBe(false);
    expect(new Set([...first, ...second].map(t => t.id)).size).toBe(4);
  });

  test('the scan payload is derived from the ticket id and never changes', () => {
    const [ticket] = createTickets('outbound', ['Stable Passenger']);
    const payload = ticketScanPayload(ticket.id);
    expect(payload).toBe(`GM-VERIFY-1|${ticket.id}`);
    expect(ticketScanPayload(ticket.id)).toBe(payload);
    expect(payload).not.toContain('Stable Passenger');
  });

  test('seeded sample tickets are stable and do not collide across bookings', () => {
    const seeded = initialBookings().flatMap(b => b.tickets ?? []);
    const again = initialBookings().flatMap(b => b.tickets ?? []);
    expect(seeded.map(t => t.id)).toEqual(again.map(t => t.id));
    expect(new Set(seeded.map(t => t.id)).size).toBe(seeded.length);
    expect(createSeededTickets({ ref: 'GM-DEMO-0248', leg: 'outbound', count: 1, leadName: 'Lead' })[0].id)
      .toBe(seeded[0].id);
  });
});

describe('booking result tickets', () => {
  test('two passengers with a return leg get four distinct tickets', async () => {
    const { ids, payloads } = await bookTickets({ pax: 2, addReturn: true });
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(new Set(payloads).size).toBe(4);
    payloads.forEach((payload, i) => expect(payload).toBe(ticketScanPayload(ids[i])));

    await waitFor(() => {
      const saved = savedBookings().find(b => b.tickets.length === 4);
      expect(saved).toBeTruthy();
      expect(saved!.tickets.map(t => t.id)).toEqual(ids);
      expect(saved!.tickets.filter(t => t.leg === 'outbound')).toHaveLength(2);
      expect(saved!.tickets.filter(t => t.leg === 'return')).toHaveLength(2);
      expect(saved!.tickets.every(t => t.status === 'notBoarded')).toBe(true);
    });
  });

  test('the same ticket keeps its payload through a language switch and a reload', async () => {
    const { view, ids, payloads } = await bookTickets({ pax: 2 });

    // A language switch re-renders every ticket card; the encoded payload must not change.
    click('Account menu');
    fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(payloadsOnScreen()).toEqual(payloads);
    click('قائمة الحساب');
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(payloadsOnScreen()).toEqual(payloads);

    // Reloading the app re-reads the saved booking instead of issuing new tickets.
    view.unmount();
    await renderApp('/bookings');
    fireEvent.click(screen.getAllByRole('button', { name: 'View details' })[0]);
    await screen.findByRole('heading', { name: /GM-DEMO-/ });
    expect(payloadsOnScreen()).toEqual(payloads);
    expect([...document.querySelectorAll('.ticket-qr-card .ticket-id')].map(el => el.textContent)).toEqual(ids);
  });

  test('the route fact is labelled "Route" (not a destination claim), in English and Arabic', async () => {
    await bookTickets();

    const english = resultFacts();
    expect(english.Route).toBe('Ras Tanura Service Pier → Approved Anchorage A (Demo)');
    expect(Object.keys(english)).not.toContain('Approved destination (demo)');

    // The same field keeps an accurate label after switching to Arabic/RTL.
    click('Account menu');
    fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    const arabic = resultFacts();
    expect(Object.keys(arabic)).toContain('المسار');
    expect(arabic['المسار']).toContain('→');
    expect(Object.keys(arabic)).not.toContain('الوجهة المعتمدة (تجريبي)');
  });

  test('the result screen has one confirmation block, one ticket card per ticket and a single status list', async () => {
    await bookTickets({ pax: 2 });
    expect(screen.getByRole('heading', { name: 'Booking confirmed (demo)' })).toBeInTheDocument();
    expect(qrCards()).toHaveLength(2);
    for (const card of qrCards()) {
      expect(card.querySelector('.qr-code')).not.toBeNull();
      expect(card.querySelector('.ticket-id')?.textContent).toMatch(/^GMTK-/);
    }
    // Each status is shown once, in the status list (previously label + text + pill).
    expect(document.querySelectorAll('.result-status-list li')).toHaveLength(4);
    expect(screen.getAllByText('Payment recorded (demo)')).toHaveLength(1);
    expect(document.querySelectorAll('.result-flow > .card').length).toBeLessThanOrEqual(3);
  });

  test('tickets are centred compositions and cannot overflow on a phone', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/styles/wallet.css'), 'utf8');
    expect(css).toMatch(/\.ticket-qr-card\{[^}]*display:grid[^}]*justify-items:center/);
    expect(css).toMatch(/\.ticket-qr-card\{[^}]*min-width:0/);
    expect(css).toMatch(/\.ticket-id\{[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\.qr-code svg\{[^}]*max-width:100%/);
  });
});

describe('staff scan resolves the ticket it encodes', () => {
  const boardingInput = () => screen.getByLabelText('QR payload, ticket ID or booking reference');
  const resultCard = () => document.querySelector<HTMLElement>('.scan-state');

  test('each scanned payload boards exactly its own ticket, with the ticket details shown', async () => {
    const { view, ids, payloads } = await bookTickets({ pax: 2, addReturn: true });
    view.unmount();
    await renderApp('/boarding');

    // Ticket order is outbound (2) then return (2); index 3 is the second passenger's return leg.
    fireEvent.change(boardingInput(), { target: { value: payloads[3] } });
    click('Verify');
    await waitFor(() => expect(resultCard()).not.toBeNull());
    const card = resultCard()!;
    expect(within(card).getByText('Second Passenger 2')).toBeInTheDocument();
    expect(within(card).getByText('Return leg')).toBeInTheDocument();
    expect(within(card).getByText(ids[3])).toBeInTheDocument();
    expect(within(card).getByText('Boarded (demo)')).toBeInTheDocument();

    // Exactly one ticket changed state.
    await waitFor(() => {
      const saved = savedBookings().find(b => b.tickets.some(t => t.id === ids[3]))!;
      expect(saved.tickets.find(t => t.id === ids[3])!.status).toBe('boarded');
      expect(saved.tickets.filter(t => t.status === 'boarded')).toHaveLength(1);
    });

    // A second scan of the same ticket is refused and boards nothing further.
    fireEvent.change(boardingInput(), { target: { value: payloads[3] } });
    click('Verify');
    await waitFor(() => expect(resultCard()).toHaveTextContent('already boarded'));
    await waitFor(() => {
      const saved = savedBookings().find(b => b.tickets.some(t => t.id === ids[3]))!;
      expect(saved.tickets.filter(t => t.status === 'boarded')).toHaveLength(1);
    });

    // The other passenger's outbound ticket resolves to that passenger, not the first one.
    fireEvent.change(boardingInput(), { target: { value: payloads[1] } });
    click('Verify');
    await waitFor(() => expect(resultCard()).toHaveTextContent(ids[1]));
    expect(within(resultCard()!).getByText('Second Passenger 2')).toBeInTheDocument();
    expect(within(resultCard()!).getByText('Outbound leg')).toBeInTheDocument();
  });

  test('an unknown or malformed payload never boards anything', async () => {
    await renderApp('/boarding');
    for (const value of ['GM-VERIFY-1|GMTK-NOPE404', 'not a ticket', 'GM-VERIFY-2|GMTK-ABC123']) {
      fireEvent.change(boardingInput(), { target: { value } });
      click('Verify');
      await waitFor(() => expect(resultCard()).toHaveTextContent('Unknown ticket or booking reference'));
      expect(resultCard()!.querySelector('.scan-facts')).toBeNull();
    }
    const boarded = savedBookings().flatMap(b => b.tickets ?? []).filter(t => t.status === 'boarded');
    expect(boarded).toHaveLength(0);
  });

  test('a booking reference alone shows no single ticket', async () => {
    const { ref } = await bookTickets();
    await renderApp('/boarding');
    fireEvent.change(boardingInput(), { target: { value: ref } });
    click('Verify');
    await waitFor(() => expect(screen.getByText(/Boarding is checked at the pier/)).toBeInTheDocument());
    expect(resultCard()).toBeNull();
  });
});
