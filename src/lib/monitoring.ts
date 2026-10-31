/**
 * Error-monitoring integration point. Without VITE_ERROR_REPORTING_URL nothing
 * leaves the browser (console only). With it, a minimal, scrubbed event is POSTed
 * to the operator's collector (e.g. a Sentry/Datadog intake proxied by ATCO IT):
 * no request bodies, no tokens, and e-mail addresses / phone numbers / JWT-like
 * strings / ticket QR secrets are redacted from messages and stacks.
 */
export interface MonitoringEvent {
  readonly level: 'error' | 'warning';
  readonly message: string;
  readonly stack: string;
  readonly context: string;
  readonly path: string;
  readonly release: string;
  readonly at: string;
  /** Stable grouping key: lets the collector alert on NEW errors and count REPEATED ones. */
  readonly fingerprint: string;
}

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, '[supabase-key]'],
  [/GMT1:[0-9a-f]{64}/g, '[ticket-qr]'],
  [/\bTK-[0-9A-F]{24}\b/g, '[ticket-ref]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g, '[key]'],
  [/\bSA\d{2}[0-9A-Z]{18,22}\b/g, '[iban]'],
  // Phone numbers, card numbers and national/Iqama IDs are all long digit runs.
  [/\+?\d[\d\s()-]{7,}\d/g, '[phone]'],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.slice(0, 4000);
}

/** FNV-1a over the normalised message, context and first stack frame (ids and numbers removed). */
export function fingerprintOf(message: string, context: string, stack: string): string {
  const frame = stack.split('\n').find(l => /^\s*at\s|@/.test(l)) ?? '';
  const normalized = `${context}|${message}|${frame}`.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/\d+/g, ':n');
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i++) { h ^= normalized.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildEvent(error: unknown, context: string, path: string, release: string): MonitoringEvent {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = scrub(err.message); const stack = scrub(err.stack ?? ''); const ctx = scrub(context);
  return {
    level: 'error', message, stack, context: ctx,
    // Query strings can carry recovery tokens: report the path only.
    path: path.split('?')[0].split('#')[0], release, at: new Date().toISOString(),
    fingerprint: fingerprintOf(message, ctx, stack),
  };
}

/** Per page load: at most this many events, and the same fingerprint at most once a minute,
 *  so a render loop or an outage cannot flood (and run up the bill of) the collector. */
export const MAX_EVENTS_PER_PAGE = 25;
const REPEAT_WINDOW_MS = 60_000;
const lastSent = new Map<string, number>();
let sentCount = 0;
export function resetMonitoringThrottle(): void { lastSent.clear(); sentCount = 0; }
export function shouldSend(fingerprint: string, now = Date.now()): boolean {
  if (sentCount >= MAX_EVENTS_PER_PAGE) return false;
  const last = lastSent.get(fingerprint);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return false;
  lastSent.set(fingerprint, now); sentCount += 1;
  return true;
}

export function reportError(error: unknown, context = ''): void {
  const endpoint = (import.meta.env?.VITE_ERROR_REPORTING_URL as string | undefined) ?? '';
  const event = buildEvent(error, context, typeof location === 'undefined' ? '' : location.pathname, (import.meta.env?.VITE_RELEASE as string | undefined) ?? 'dev');
  console.error('Gulf Mover error', event.message);
  if (!endpoint || !/^https:\/\//.test(endpoint)) return;
  if (!shouldSend(event.fingerprint)) return;
  try {
    const body = JSON.stringify(event);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
    else void fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
  } catch { /* monitoring must never break the app */ }
}

/**
 * Failed API request (server error, unexpected response, backend not deployed). Only the
 * HTTP status and the database error code are reported — never the request body, the
 * response body or the user's input. User-input/validation failures are not errors.
 */
export function reportRequestFailure(kind: string, status: number | undefined, code: string): void {
  reportError(new Error(`API request failed: ${kind}`), `api:${status ?? 'network'}:${code || '-'}`);
}
