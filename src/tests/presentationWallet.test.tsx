import { confirmAge } from './ageGate';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PresentationApp } from '../presentation/PresentationApp';
import { AppProviders, AppRoutes } from '../App';
import { connectHostForTests } from '../components/wallet/WalletHostBridge';
import { buildPassView } from '../components/wallet/passView';
import { initialBookings, type Booking } from '../data/demoData';
import { createTickets, ticketScanPayload } from '../domain/tickets';
import { translateKey, translateText } from '../i18n/translate';
import type { TicketEntry } from '../hooks/useTicketIndex';
import type { PassView, ShellToApp } from '../presentation/walletProtocol';
import { DOUBLE_PRESS_MS } from '../presentation/wallet/hooks';
import { OS_TEXT } from '../presentation/wallet/osText';

// jsdom has no ResizeObserver; the previewer only uses it to fit the device to the window.
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver ??= NoopResizeObserver;

const ORIGIN = window.location.origin;
const last = <T,>(items: T[]): T => items[items.length - 1];

/** Passes built from real demo data: one booking with an outbound and a separate return ticket. */
function demoPasses(): PassView[] {
  const seed = initialBookings()[0];
  const booking: Booking = {
    ...seed,
    return: { date: seed.date, time: '13:00', dest: seed.dest, boatId: seed.boatId },
    tickets: [...createTickets('outbound', ['Mariam Demo']), ...createTickets('return', ['Mariam Demo'])],
  };
  const t = (k: string) => translateKey('en', k);
  const tx = (s: string) => translateText('en', s);
  return booking.tickets!.map(ticket => {
    const isReturn = ticket.leg === 'return';
    const entry: TicketEntry = {
      ticket, booking, leg: ticket.leg,
      legDate: isReturn ? booking.return!.date : booking.date,
      legTime: isReturn ? booking.return!.time : booking.time,
    };
    return buildPassView(entry, t, tx, 'en', true);
  });
}

describe('presentation device Wallet (shell)', () => {
  let appWindow: Window;
  let postSpy: ReturnType<typeof vi.fn>;

  function renderShell() {
    const view = render(<PresentationApp />);
    const iframe = view.container.querySelector('iframe') as HTMLIFrameElement;
    appWindow = iframe.contentWindow as Window;
    postSpy = vi.fn();
    appWindow.postMessage = postSpy as unknown as Window['postMessage'];
    return { ...view, iframe };
  }
  /** A message from the app in the device frame (same window, same origin). */
  const fromApp = (data: unknown, origin = ORIGIN, source: Window = appWindow) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin, source })); });
  const sent = (type: ShellToApp['type']) => postSpy.mock.calls.map(c => c[0]).filter(m => m.type === type);
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const sideButton = () => screen.getByRole('button', { name: /Side button/ });
  const doubleClick = () => { fireEvent.click(sideButton()); fireEvent.click(sideButton()); };
  const appleWallet = () => screen.queryByRole('dialog', { name: 'Apple Wallet (simulated)' });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  test('device switching tells the app; only the iPhone has the interactive side button', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: /Side button/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    expect(last(sent('gm-host:device'))).toEqual({ type: 'gm-host:device', device: 'iphone' });
    expect(sideButton()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Android' }));
    expect(last(sent('gm-host:device'))).toEqual({ type: 'gm-host:device', device: 'android' });
    expect(screen.queryByRole('button', { name: /Side button/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mac' }));
    expect(last(sent('gm-host:device'))).toEqual({ type: 'gm-host:device', device: 'mac' });
  });

  test('a single side-button click does not open Wallet; a double-click does', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    fireEvent.click(sideButton());
    advance(DOUBLE_PRESS_MS + 50);
    expect(appleWallet()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Double-click the side button to open Wallet');
    // Two presses further apart than the threshold are two single presses.
    fireEvent.click(sideButton());
    advance(DOUBLE_PRESS_MS + 50);
    fireEvent.click(sideButton());
    advance(DOUBLE_PRESS_MS + 50);
    expect(appleWallet()).toBeNull();
    doubleClick();
    expect(appleWallet()).toBeInTheDocument();
  });

  /** Swipe the open card carousel by `dx` pixels (pointer events: mouse and touch alike). */
  const swipe = (carousel: HTMLElement, dx: number) => {
    fireEvent.pointerDown(carousel, { pointerId: 1, button: 0, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(carousel, { pointerId: 1, clientX: 200 + dx / 2, clientY: 302 });
    fireEvent.pointerMove(carousel, { pointerId: 1, clientX: 200 + dx, clientY: 303 });
    fireEvent.pointerUp(carousel, { pointerId: 1, clientX: 200 + dx, clientY: 303 });
  };
  const counter = (wallet: HTMLElement) => wallet.querySelector('.aw-bar-count')!.textContent;

  test('Apple Wallet: example cards and the saved passes together; swipe to the pass and its own QR', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    const [outbound, ret] = demoPasses();
    fromApp({ type: 'gm-wallet:state', lang: 'en', passes: [outbound, ret] });
    doubleClick();
    const wallet = appleWallet()!;
    expect(within(wallet).getByRole('heading', { name: 'Wallet' })).toBeInTheDocument();
    // Stack: three fictional demo cards, then the two Gulf Mover passes (no duplicates).
    const stack = within(wallet).getAllByRole('button', { name: /•••• \d{4}|→/ });
    expect(stack.map(b => b.getAttribute('aria-label'))).toEqual([
      'Meridian Express Gold Card, •••• 1007', 'Gulf Coast Bank Signature, •••• 4821', 'Dhahran Digital World, •••• 5530',
      expect.stringContaining(`${outbound.from} → ${outbound.to}`), expect.stringContaining(`${ret.from} → ${ret.to}`),
    ]);
    expect(wallet.querySelectorAll('.cc-demo')).toHaveLength(3);
    expect(outbound.from).toBe(ret.to); // the return leg runs the other way

    // Open the first card, then swipe through to the outbound pass.
    fireEvent.click(stack[0]);
    expect(within(wallet).getByText(/cannot make payments/)).toBeInTheDocument();
    expect(counter(wallet)).toBe('1 of 5');
    const carousel = within(wallet).getByRole('group', { name: 'Cards and passes' });
    swipe(carousel, -160);
    expect(counter(wallet)).toBe('2 of 5');
    swipe(carousel, 160);
    expect(counter(wallet)).toBe('1 of 5');
    fireEvent.keyDown(carousel, { key: 'ArrowRight' });
    fireEvent.keyDown(carousel, { key: 'ArrowRight' });
    fireEvent.keyDown(carousel, { key: 'ArrowRight' });
    expect(counter(wallet)).toBe('4 of 5');
    const activePass = wallet.querySelector('.aw-slide.is-active')!;
    expect(within(activePass as HTMLElement).getByRole('img', { name: `Scannable QR verification code ${outbound.ticketId}`, hidden: true })).toBeInTheDocument();
    const panel = wallet.querySelector('.aw-panel') as HTMLElement; // pass information under the card
    expect(within(panel).getByText(outbound.ticketId)).toBeInTheDocument();
    expect(within(panel).getByText(outbound.ref)).toBeInTheDocument();

    // A dot jumps straight to the return pass, which carries its own, different QR.
    fireEvent.click(within(wallet).getByRole('button', { name: new RegExp(`^5 of 5: .*${ret.legLabel}`) }));
    expect(within(wallet.querySelector('.aw-slide.is-active') as HTMLElement).getByText(ticketScanPayload(ret.ticketId))).toBeInTheDocument();
    expect(within(wallet.querySelector('.aw-slide.is-active') as HTMLElement).queryByText(ticketScanPayload(outbound.ticketId))).toBeNull();

    // A swipe never counts as a tap on a card.
    swipe(carousel, 160);
    expect(counter(wallet)).toBe('4 of 5');

    fireEvent.click(within(wallet).getByRole('button', { name: 'Done' }));
    expect(within(wallet).getByRole('heading', { name: 'Wallet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Gulf Mover' }));
    advance(400);
    expect(appleWallet()).toBeNull();

    // Reopen: same five items; a side press while open puts Wallet away again.
    doubleClick();
    expect(within(appleWallet()!).getAllByRole('button', { name: /•••• \d{4}|→/ })).toHaveLength(5);
    fireEvent.click(sideButton());
    advance(400);
    expect(appleWallet()).toBeNull();
  });

  test('Add to Apple Wallet: confirms once, green “Added”, then side-button guidance until Wallet is opened', () => {
    const { iframe } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    const [outbound, ret] = demoPasses();
    fromApp({ type: 'gm-wallet:request-add', pass: { ...outbound, saved: false } });
    expect(iframe).toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' })); // a second tap is ignored
    expect(sent('gm-wallet:confirm-add')).toEqual([{ type: 'gm-wallet:confirm-add', ticketId: outbound.ticketId }]);
    advance(600);
    expect(screen.getByText('Added to Apple Wallet')).toBeInTheDocument();
    advance(1700);
    expect(screen.queryByText('Added to Apple Wallet')).toBeNull();
    // Guidance points at the side button, which is highlighted; the app stays usable.
    expect(screen.getByText('Double-click the side button to open Wallet')).toBeInTheDocument();
    expect(sideButton()).toHaveClass('is-hinting');
    expect(iframe).not.toHaveAttribute('inert');
    fromApp({ type: 'gm-wallet:state', lang: 'en', passes: [outbound] });
    doubleClick();
    expect(appleWallet()).toBeInTheDocument();
    expect(screen.queryByText('Double-click the side button to open Wallet')).toBeNull();
    expect(sideButton()).not.toHaveClass('is-hinting');
    fireEvent.keyDown(document, { key: 'Escape' });
    advance(400);

    // Already saved: View instead of a second Add; it opens that pass. No more guidance needed.
    fromApp({ type: 'gm-wallet:request-add', pass: { ...outbound, saved: false } });
    expect(screen.getByText('This pass is already in Wallet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    advance(400);
    expect(sent('gm-wallet:confirm-add')).toHaveLength(1);
    expect(counter(appleWallet()!)).toBe('4 of 4');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    advance(400);

    // A further add after Wallet has been used: confirmation only, no guidance.
    fromApp({ type: 'gm-wallet:request-add', pass: { ...ret, saved: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    advance(2400);
    expect(screen.queryByText('Double-click the side button to open Wallet')).toBeNull();

    // "View in Wallet" from the app opens that pass directly.
    fromApp({ type: 'gm-wallet:request-open', ticketId: outbound.ticketId });
    expect(within(appleWallet()!).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  test('Android has its own Google Wallet: save confirmation, status-bar guidance, card carousel, never Apple', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Android' }));
    const [outbound, ret] = demoPasses();
    fromApp({ type: 'gm-wallet:request-add', pass: { ...outbound, saved: false } });
    const sheet = screen.getByRole('dialog', { name: 'Google Wallet (simulated)' });
    expect(sheet).toHaveTextContent('Save this pass to Google Wallet');
    expect(sheet.textContent).not.toMatch(/Apple/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(sheet).toHaveTextContent('Saving…');
    expect(sent('gm-wallet:confirm-add')).toEqual([{ type: 'gm-wallet:confirm-add', ticketId: outbound.ticketId }]);
    advance(700);
    expect(within(sheet).getByRole('status')).toHaveTextContent('Added to Google Wallet');
    fromApp({ type: 'gm-wallet:state', lang: 'en', passes: [outbound, ret] });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    advance(300);

    // Guidance points at the status bar (Quick Settings pull-down), which glows.
    expect(screen.getByText('Swipe down from the top of the screen')).toBeInTheDocument();
    const statusBar = screen.getByRole('button', { name: /Open Quick Settings/ });
    expect(statusBar).toHaveClass('is-hinting');
    fireEvent.click(statusBar);
    expect(screen.queryByText('Swipe down from the top of the screen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Google Wallet' }));
    advance(300);

    const wallet = screen.getByRole('dialog', { name: 'Google Wallet (simulated)' });
    expect(wallet.textContent).not.toMatch(/Apple/);
    // Carousel opens on the newest pass; swipe back through the demo cards and forward again.
    const carousel = within(wallet).getByRole('group', { name: 'Cards and passes' });
    const activeLabel = () => wallet.querySelector('.gw-slide.is-active')!.getAttribute('aria-label');
    expect(activeLabel()).toContain(ret.legLabel);
    swipe(carousel, 160);
    expect(activeLabel()).toContain(outbound.legLabel);
    swipe(carousel, 160);
    expect(activeLabel()).toBe('Dhahran Digital World, •••• 5530');
    expect(within(wallet).getByText(/Hold to reader to pay \(demo\)/)).toBeInTheDocument();
    swipe(carousel, -160);
    fireEvent.click(within(wallet).getByRole('button', { name: 'View pass' }));
    expect(within(wallet).getByRole('heading', { name: 'Pass details' })).toBeInTheDocument();
    expect(within(wallet).getByText(ticketScanPayload(outbound.ticketId))).toBeInTheDocument();

    // Back to the home screen: the Passes list still has both tickets; then close.
    fireEvent.click(within(wallet).getByRole('button', { name: 'Back to passes' }));
    expect(within(wallet).getAllByText(/Gulf Mover · Marine transfer/)).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    advance(300);
    expect(screen.queryByRole('dialog', { name: 'Google Wallet (simulated)' })).toBeNull();
  });

  test('switching device closes any open Wallet; messages from elsewhere are ignored', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    const [outbound] = demoPasses();
    fromApp({ type: 'gm-wallet:request-add', pass: outbound }, 'https://example.invalid');
    fromApp({ type: 'gm-wallet:request-add', pass: outbound }, ORIGIN, window);
    expect(screen.queryByRole('dialog')).toBeNull();
    doubleClick();
    expect(appleWallet()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Android' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mac' }));
    fromApp({ type: 'gm-wallet:request-open', ticketId: outbound.ticketId });
    expect(screen.queryByRole('dialog')).toBeNull(); // no phone Wallet on the Mac
  });

  test('keyboard: Enter twice opens Wallet, Escape closes it and focus returns to the side button', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    sideButton().focus();
    doubleClick(); // Enter/Space on a button fire click events
    expect(appleWallet()).toBeInTheDocument();
    expect(appleWallet()!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    advance(400);
    expect(appleWallet()).toBeNull();
    expect(document.activeElement).toBe(sideButton());
  });

  test('reduced motion: Wallet closes without waiting for an animation', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    doubleClick();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Gulf Mover' }));
    advance(0);
    expect(appleWallet()).toBeNull();
  });

  test('without reduced motion the closing animation plays first', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    doubleClick();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Gulf Mover' }));
    advance(100);
    expect(appleWallet()).toHaveClass('is-closing');
    advance(300);
    expect(appleWallet()).toBeNull();
  });

  test('Arabic: Wallet follows the app language and right-to-left layout', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }));
    fromApp({ type: 'gm-wallet:state', lang: 'ar', passes: [] });
    fireEvent.click(screen.getByRole('button', { name: /الزر الجانبي/ }));
    fireEvent.click(screen.getByRole('button', { name: /الزر الجانبي/ }));
    const wallet = screen.getByRole('dialog', { name: 'Apple Wallet (محاكاة)' });
    expect(wallet).toHaveAttribute('dir', 'rtl');
    expect(within(wallet).getByRole('heading', { name: 'المحفظة' })).toBeInTheDocument();
  });

  test('every device Wallet text has an Arabic version', () => {
    const missing = Object.entries(OS_TEXT.en).filter(([k]) => !OS_TEXT.ar[k as keyof typeof OS_TEXT.ar]);
    expect(missing).toEqual([]);
  });
});

describe('app inside the device (bridge)', () => {
  let host: Window;
  let hostPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    host = frame.contentWindow as Window;
    hostPost = vi.fn();
    host.postMessage = hostPost as unknown as Window['postMessage'];
    connectHostForTests(host);
  });
  afterEach(() => { connectHostForTests(null); });

  const fromShell = (data: unknown) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: ORIGIN, source: host })); });
  const posted = (type: string) => hostPost.mock.calls.map(c => c[0]).filter(m => m.type === type);

  async function openFirstBookingTickets(device: 'iphone' | 'android' | 'mac') {
    render(<AppProviders><MemoryRouter initialEntries={['/bookings']}><AppRoutes /></MemoryRouter></AppProviders>);
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
    await screen.findAllByRole('navigation', { name: 'Main navigation' });
    fromShell({ type: 'gm-host:device', device });
    const card = screen.getByText('GM-DEMO-0248').closest('.booking-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'View details' }));
    await screen.findByText('Tickets with scan codes (demo)');
    const row = document.querySelector('.ticket-qr-card') as HTMLElement;
    const payload = row.querySelector('.qr-payload')!.textContent!;
    return { row, ticketId: payload.split('|')[1] };
  }

  test('on the iPhone the app hands the real ticket to the device Wallet, saves it once and persists it', async () => {
    const { row, ticketId } = await openFirstBookingTickets('iphone');
    expect(posted('gm-app:ready')).toHaveLength(1);
    fireEvent.click(within(row).getByRole('button', { name: 'Add to Apple Wallet' }));
    const [request] = posted('gm-wallet:request-add');
    expect(request.pass).toMatchObject({ ticketId, ref: 'GM-DEMO-0248', leg: 'outbound', saved: false });
    expect(request.pass.from).toBe('Ras Tanura Service Pier');
    // No in-site sheet: the device shows its own.
    expect(screen.queryByText('Add pass to Wallet')).toBeNull();

    fromShell({ type: 'gm-wallet:confirm-add', ticketId });
    fromShell({ type: 'gm-wallet:confirm-add', ticketId });
    const latest = last(posted('gm-wallet:state'));
    expect(latest.passes.map((p: PassView) => p.ticketId)).toEqual([ticketId]);
    expect(JSON.parse(localStorage.getItem('gm-demo-state-v1')!).passes).toHaveLength(1);

    fireEvent.click(within(row).getByRole('button', { name: 'View in Wallet' }));
    expect(posted('gm-wallet:request-open')).toEqual([{ type: 'gm-wallet:request-open', ticketId }]);
  });

  test('on Android the buttons say Google Wallet, never Apple', async () => {
    const { row } = await openFirstBookingTickets('android');
    expect(within(row).getByRole('button', { name: 'Add to Google Wallet' })).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/Apple/);
  });

  test('on the Mac preview the regular site behaviour is unchanged', async () => {
    const { row } = await openFirstBookingTickets('mac');
    fireEvent.click(within(row).getByRole('button', { name: 'Add to Apple Wallet' }));
    expect(await screen.findByText('Add pass to Wallet')).toBeInTheDocument();
    expect(posted('gm-wallet:request-add')).toHaveLength(0);
  });
});

describe('presentation Home button', () => {
  test('Home asks the app to return to its start screen and never points the device frame at "/"', () => {
    const view = render(<PresentationApp />);
    const iframe = view.container.querySelector('iframe') as HTMLIFrameElement;
    const appWindow = iframe.contentWindow as Window;
    const postSpy = vi.fn();
    appWindow.postMessage = postSpy as unknown as Window['postMessage'];
    const srcBefore = iframe.getAttribute('src');
    const hrefBefore = appWindow.location.href;
    fireEvent.click(screen.getByRole('button', { name: /Home/ }));
    expect(postSpy.mock.calls.map(c => c[0]).filter(m => m.type === 'gm-host:home')).toHaveLength(1);
    // Opened from a file, "/" is the root of the computer's disk: the frame must not be sent there.
    expect(iframe.getAttribute('src')).toBe(srcBefore);
    expect(appWindow.location.href).toBe(hrefBefore);
  });

  describe('app side', () => {
    let host: Window;
    beforeEach(() => {
      localStorage.clear();
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      host = frame.contentWindow as Window;
      host.postMessage = vi.fn() as unknown as Window['postMessage'];
      connectHostForTests(host);
    });
    afterEach(() => { connectHostForTests(null); });
    const send = (data: unknown, source: Window) =>
      act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: ORIGIN, source })); });

    test('"home" from the presentation returns the app to Home through its own router', async () => {
      render(<AppProviders><MemoryRouter initialEntries={['/bookings']}><AppRoutes /></MemoryRouter></AppProviders>);
      confirmAge();
      fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'My bookings' })).toBeInTheDocument();
      send({ type: 'gm-host:home' }, window); // not the presentation window: ignored
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My bookings');
      send({ type: 'gm-host:home' }, host);
      expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    });
  });
});
