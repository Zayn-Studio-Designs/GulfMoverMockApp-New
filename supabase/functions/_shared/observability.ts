// Server-side error tracking for the edge functions (Deno). One JSON line per event is
// written to the function log (Supabase → Edge Functions → Logs, searchable and
// alertable); when the ERROR_REPORTING_URL secret is set, the same scrubbed event is
// also POSTed to the operator's collector (Sentry/Datadog intake). Request bodies,
// headers and provider responses are never logged; personal data and secrets are
// redacted from every message before it leaves the function.

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, '[supabase-key]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g, '[key]'],
  [/GMT1:[0-9a-f]{64}/g, '[ticket-qr]'],
  [/\bTK-[0-9A-F]{24}\b/g, '[ticket-ref]'],
  [/\bSA\d{2}[0-9A-Z]{18,22}\b/g, '[iban]'],
  [/\+?\d[\d\s()-]{7,}\d/g, '[number]'],
];

export function scrub(text: string, max = 2000): string {
  let out = String(text);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.slice(0, max);
}

export interface ServerEvent {
  readonly level: 'error' | 'warning';
  readonly fn: string;
  readonly context: string;
  readonly message: string;
  readonly fingerprint: string;
  readonly release: string;
  readonly at: string;
  readonly detail?: Record<string, string | number | boolean | null>;
}

/** Stable grouping key so the collector can tell a NEW error from a REPEATED one. */
export function fingerprint(fn: string, context: string, message: string): string {
  const normalized = `${fn}|${context}|${message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/\d+/g, ':n')}`;
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i++) { h ^= normalized.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildServerEvent(fn: string, context: string, error: unknown, level: 'error' | 'warning' = 'error',
  detail?: ServerEvent['detail'], release = 'unknown'): ServerEvent {
  const message = scrub(error instanceof Error ? error.message : String(error), 300);
  const safeDetail = detail ? Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === 'string' ? scrub(v, 200) : v])) : undefined;
  return { level, fn, context, message, fingerprint: fingerprint(fn, context, message), release, at: new Date().toISOString(), ...(safeDetail ? { detail: safeDetail } : {}) };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Logs (and optionally forwards) a scrubbed event. Never throws, never blocks longer than ~2 s. */
export async function logServerEvent(event: ServerEvent, env: Record<string, string | undefined>, fetcher: FetchLike = fetch): Promise<void> {
  const line = JSON.stringify(event);
  if (event.level === 'error') console.error(line); else console.warn(line);
  const endpoint = env.ERROR_REPORTING_URL ?? '';
  if (!/^https:\/\//.test(endpoint)) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: line, signal: ctrl.signal }).catch(() => undefined);
    clearTimeout(timer);
  } catch { /* monitoring must never break a payment or a dispatch run */ }
}

/** Constant-time string comparison for shared secrets (no early exit on the first mismatch). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a); const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
