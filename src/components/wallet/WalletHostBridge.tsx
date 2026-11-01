import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import { useDemo } from '../../context/DemoContext';
import { useTicketIndex, type TicketEntry } from '../../hooks/useTicketIndex';
import { fromOwnOrigin, isProtocolMessage, messageTargetOrigin, type AppToShell, type HostDevice } from '../../presentation/walletProtocol';
import { buildPassView } from './passView';

/*
 * App side of the presentation bridge. Only active when the app runs inside the
 * presentation shell's device frame (a same-origin parent window); the standalone
 * website never sees any of this and keeps its own Wallet sheets.
 */

let hostWindow: Window | null | undefined;
let hostDevice: HostDevice | null = null;
const listeners = new Set<() => void>();

function getHostWindow(): Window | null {
  if (hostWindow === undefined) {
    try { hostWindow = window.parent !== window ? window.parent : null; } catch { hostWindow = null; }
  }
  return hostWindow;
}

/** Tests stand in for the presentation shell with their own window. */
export function connectHostForTests(win: Window | null) {
  hostWindow = win;
  setHostDevice(null);
}

function setHostDevice(device: HostDevice | null) {
  hostDevice = device;
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The mock device the app is shown in, or null on the normal website. */
export function useHostDevice(): HostDevice | null {
  return useSyncExternalStore(subscribe, () => hostDevice, () => null);
}

function postToHost(message: AppToShell) {
  getHostWindow()?.postMessage(message, messageTargetOrigin());
}

/** Keeps the device's Wallet in step with the demo: saved passes, language, and confirmed adds. */
export function WalletHostBridge() {
  const { t, tx, lang } = useLanguage();
  const { pref, effective: theme } = useTheme();
  const { bookings, passes, addWalletPass, boats } = useDemo();
  const { entries } = useTicketIndex(bookings);
  const addRef = useRef(addWalletPass);
  addRef.current = addWalletPass;

  const savedViews = useMemo(() => passes
    .map(p => entries.find(e => e.ticket.id === p.ticketId))
    .filter((e): e is TicketEntry => Boolean(e))
    .map(e => buildPassView(e, t, tx, lang, true, boats)), [passes, entries, t, tx, lang, boats]);
  const stateRef = useRef<AppToShell>({ type: 'gm-wallet:state', lang, passes: savedViews });
  stateRef.current = { type: 'gm-wallet:state', lang, passes: savedViews };

  useEffect(() => {
    const host = getHostWindow();
    if (!host) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== host || !fromOwnOrigin(e.origin) || !isProtocolMessage(e.data)) return;
      if (e.data.type === 'gm-host:device') {
        setHostDevice(e.data.device);
        postToHost(stateRef.current);
      } else if (e.data.type === 'gm-wallet:confirm-add') {
        addRef.current(e.data.ticketId); // refuses duplicates
      }
    };
    window.addEventListener('message', onMessage);
    postToHost({ type: 'gm-app:ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => { if (getHostWindow()) postToHost(stateRef.current); }, [savedViews, lang]);

  /* Tell the shell what theme the screen is showing (System / Auto resolved here in the app),
     so the device frame's boot surface and chrome agree with the app without a reload. */
  const themeState = useRef({ type: 'gm-app:theme' as const, theme });
  themeState.current = { type: 'gm-app:theme', theme };
  useEffect(() => { if (getHostWindow()) postToHost(themeState.current); }, [theme, pref]);

  return null;
}

/**
 * Wallet button for a ticket when the app is shown in the mock iPhone or Android:
 * hands the pass to the device's own (simulated) Wallet sheet. Renders nothing on
 * the Mac preview and the normal website.
 */
/**
 * Lets the presentation's Home button return the app to its start screen through the app's own
 * router. The shell used to push "/" into the frame's history and, failing that, load "/" in the
 * frame — which in a presentation opened from a file is the root of the computer's disk.
 * Rendered inside the router (see AppRoutes).
 */
export function HostHomeBridge() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const host = getHostWindow();
    if (!host) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== host || !fromOwnOrigin(e.origin) || !isProtocolMessage(e.data)) return;
      if (e.data.type === 'gm-host:home') navigateRef.current('/');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return null;
}

export function DeviceWalletButton({ entry, saved }: { entry: TicketEntry; saved: boolean }) {
  const device = useHostDevice();
  const { t, tx, lang } = useLanguage();
  const { boats } = useDemo();
  if (device !== 'iphone' && device !== 'android') return null;
  const google = device === 'android';
  if (saved) {
    return (
      <button type="button" className="btn btn-outline btn-small" onClick={() => postToHost({ type: 'gm-wallet:request-open', ticketId: entry.ticket.id })}>
        {t(google ? 'walletViewGoogle' : 'walletViewApple')}
      </button>
    );
  }
  return (
    <button type="button" className={`btn btn-small device-wallet-btn${google ? ' is-google' : ''}`}
      onClick={() => postToHost({ type: 'gm-wallet:request-add', pass: buildPassView(entry, t, tx, lang, false, boats) })}>
      {t(google ? 'walletAddGoogle' : 'walletAdd')}
    </button>
  );
}
