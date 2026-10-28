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
}

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/GMT1:[0-9a-f]{64}/g, '[ticket-qr]'],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]+/g, '[key]'],
  [/\+?\d[\d\s()-]{7,}\d/g, '[phone]'],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.slice(0, 4000);
}

export function buildEvent(error: unknown, context: string, path: string, release: string): MonitoringEvent {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    level: 'error', message: scrub(err.message), stack: scrub(err.stack ?? ''), context: scrub(context),
    // Query strings can carry recovery tokens: report the path only.
    path: path.split('?')[0].split('#')[0], release, at: new Date().toISOString(),
  };
}

export function reportError(error: unknown, context = ''): void {
  const endpoint = (import.meta.env?.VITE_ERROR_REPORTING_URL as string | undefined) ?? '';
  const event = buildEvent(error, context, typeof location === 'undefined' ? '' : location.pathname, (import.meta.env?.VITE_RELEASE as string | undefined) ?? 'dev');
  console.error('Gulf Mover error', event.message);
  if (!endpoint || !/^https:\/\//.test(endpoint)) return;
  try {
    const body = JSON.stringify(event);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
    else void fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
  } catch { /* monitoring must never break the app */ }
}
