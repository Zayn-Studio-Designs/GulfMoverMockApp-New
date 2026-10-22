// Messages between the presentation shell (the mock device) and the app running inside it.
//
// The shell owns everything the *phone* does — side button, status bar, the simulated
// Apple Wallet / Google Wallet screens and their system sheets. The app owns the demo
// data: bookings, tickets and saved passes stay in DemoContext (and its localStorage),
// and the app sends the shell display-ready pass details built from that live data.
// Both sides are the same origin; every message is checked for source and origin.

export type HostDevice = 'mac' | 'iphone' | 'android';

/** One ticket as a Wallet pass, already resolved and translated by the app. */
export interface PassView {
  ticketId: string;
  ref: string;
  leg: 'outbound' | 'return';
  legLabel: string;
  from: string;
  to: string;
  date: string;
  time: string;
  boat?: string;
  passenger: string;
  statusKind: 'valid' | 'boarded' | 'blocked';
  statusLabel: string;
  saved: boolean;
}

export type ShellToApp =
  | { type: 'gm-host:device'; device: HostDevice }
  /** Toolbar "Home": the app navigates itself back to its start screen (works for every router and host). */
  | { type: 'gm-host:home' }
  | { type: 'gm-wallet:confirm-add'; ticketId: string };

export type AppToShell =
  | { type: 'gm-app:ready' }
  | { type: 'gm-app:theme'; theme: 'light' | 'dark' }
  | { type: 'gm-wallet:state'; lang: 'en' | 'ar'; passes: PassView[] }
  | { type: 'gm-wallet:request-add'; pass: PassView }
  | { type: 'gm-wallet:request-open'; ticketId: string };

/**
 * Opened from a downloaded file, the two frames report their origins as "file://" or "null"
 * (it varies by frame and browser), and postMessage cannot address either. Messages are then
 * sent with "*"; the receiver's check of the exact source window keeps them between the frames.
 */
const isLocalFile = () => window.location.origin === 'null' || window.location.protocol === 'file:';

export const messageTargetOrigin = () => (isLocalFile() ? '*' : window.location.origin);

/** Same-origin check for received messages (both local-file spellings count as one origin). */
export function fromOwnOrigin(origin: string): boolean {
  return origin === window.location.origin || (isLocalFile() && (origin === 'null' || origin === 'file://'));
}

const TYPES = new Set(['gm-host:device', 'gm-host:home', 'gm-wallet:confirm-add', 'gm-app:ready', 'gm-app:theme', 'gm-wallet:state', 'gm-wallet:request-add', 'gm-wallet:request-open']);

export function isProtocolMessage(data: unknown): data is ShellToApp | AppToShell {
  return typeof data === 'object' && data !== null && TYPES.has((data as { type?: unknown }).type as string);
}
