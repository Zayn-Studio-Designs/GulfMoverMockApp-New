// Production-readiness audit — area 2 (error tracking): redaction, grouping, flood control,
// failed-request capture in the browser, and the edge functions' server-side logger.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_EVENTS_PER_PAGE, buildEvent, fingerprintOf, reportError, resetMonitoringThrottle, scrub, shouldSend } from '../lib/monitoring';
import { DataServiceError, run } from '../lib/dataService';
import { buildServerEvent, fingerprint, logServerEvent, scrub as serverScrub, timingSafeEqual } from '../../supabase/functions/_shared/observability';

const SECRETS = [
  'traveller@example.test', '+966 50 123 4567', 'Bearer abc.def-ghi', 'sb_secret_abcDEF123', 'sb_publishable_XYZ789abc',
  'sk_live_51Habc', 'GMT1:' + 'a'.repeat(64), 'TK-0123456789ABCDEF01234567', 'SA0380000000608010167519', '4111 1111 1111 1111',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
];

describe('redaction (browser and server use the same rules)', () => {
  for (const [name, fn] of [['browser', scrub], ['server', (t: string) => serverScrub(t)]] as const) {
    it(`${name}: no secret or personal value survives`, () => {
      const out = fn(`failure for ${SECRETS.join(' and ')}`);
      for (const secret of SECRETS) expect(out).not.toContain(secret);
    });
  }
  it('keeps the non-sensitive part of the message for debugging', () => {
    expect(scrub('sailing_full: not enough seats on GM-1A2B3C4D')).toContain('sailing_full: not enough seats');
  });
});

describe('grouping new vs repeated errors', () => {
  it('the same error with different ids/numbers has one fingerprint; a different error has another', () => {
    const a = fingerprintOf('Booking 3f2a9c1e-1111-4111-8111-111111111111 failed after 3 tries', 'api:500:-', 'at x (app.js:10:5)');
    const b = fingerprintOf('Booking 9d9d9d9d-2222-4222-8222-222222222222 failed after 7 tries', 'api:500:-', 'at x (app.js:10:5)');
    const c = fingerprintOf('Invoice missing', 'api:500:-', 'at x (app.js:10:5)');
    expect(a).toBe(b); expect(a).not.toBe(c);
    expect(fingerprint('payments', '/checkout', 'timeout 1')).toBe(fingerprint('payments', '/checkout', 'timeout 2'));
  });
  it('events carry the path only (no query string with recovery tokens)', () => {
    const e = buildEvent(new Error('x'), 'ctx', '/auth/reset-callback?token=secret#access_token=abc', 'r1');
    expect(e.path).toBe('/auth/reset-callback');
    expect(e.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('flood control', () => {
  beforeEach(() => resetMonitoringThrottle());
  it('sends a repeated error once a minute and caps the events per page', () => {
    expect(shouldSend('f1', 0)).toBe(true);
    expect(shouldSend('f1', 30_000)).toBe(false);
    expect(shouldSend('f1', 61_000)).toBe(true);
    for (let i = 0; i < 100; i++) shouldSend(`other-${i}`, 100_000);
    expect(shouldSend('fresh', 200_000)).toBe(false);
    expect(MAX_EVENTS_PER_PAGE).toBe(25);
  });
});

describe('browser reporting', () => {
  const beacon = vi.fn(() => true);
  beforeEach(() => {
    resetMonitoringThrottle();
    vi.stubEnv('VITE_ERROR_REPORTING_URL', 'https://collector.example.test/intake');
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    beacon.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('posts one scrubbed event per distinct error and none for an immediate repeat', async () => {
    reportError(new Error('Checkout failed for traveller@example.test'), 'checkout');
    reportError(new Error('Checkout failed for traveller@example.test'), 'checkout');
    expect(beacon).toHaveBeenCalledTimes(1);
    const body = await ((beacon.mock.calls[0] as unknown as [string, Blob])[1]).text();
    expect(body).not.toContain('traveller@example.test');
    expect(JSON.parse(body)).toMatchObject({ context: 'checkout', level: 'error' });
  });

  it('reports server failures from API calls, but not expected user outcomes', async () => {
    await expect(run(Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' }, status: 503 }))).rejects.toBeInstanceOf(DataServiceError);
    expect(beacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await ((beacon.mock.calls[0] as unknown as [string, Blob])[1]).text());
    expect(body.context).toBe('api:503:XX000');
    beacon.mockClear();
    await expect(run(Promise.resolve({ data: null, error: { message: 'sailing_full: not enough seats', code: 'P0001' }, status: 400 }))).rejects.toThrow();
    await expect(run(Promise.resolve({ data: null, error: { message: 'not authorized', code: '42501' }, status: 403 }))).rejects.toThrow();
    // Abuse limits are an expected outcome with their own message, not a bug report.
    await expect(run(Promise.resolve({ data: null, error: { message: 'rate_limited: too many bookings', code: '54000' }, status: 400 })))
      .rejects.toMatchObject({ kind: 'rate-limited' });
    await expect(run(Promise.resolve({ data: null, error: { message: 'too_many_unpaid_holds: pay first', code: '54000' }, status: 400 })))
      .rejects.toMatchObject({ kind: 'too-many-holds' });
    expect(beacon).not.toHaveBeenCalled();
  });

  it('sends nothing at all when no collector is configured', () => {
    vi.stubEnv('VITE_ERROR_REPORTING_URL', '');
    reportError(new Error('offline'), 'x');
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe('edge-function logger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one scrubbed JSON line and forwards it when a collector is configured', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: string) => { lines.push(l); });
    const fetcher = vi.fn(async () => new Response('ok'));
    const event = buildServerEvent('payments', '/checkout', new Error('provider rejected card for traveller@example.test'), 'error', { status: 502 }, 'r1');
    await logServerEvent(event, { ERROR_REPORTING_URL: 'https://collector.example.test/intake' }, fetcher);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('traveller@example.test');
    expect(JSON.parse(lines[0])).toMatchObject({ fn: 'payments', context: '/checkout', level: 'error', detail: { status: 502 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never throws or blocks the request when the collector is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => { throw new Error('collector down'); });
    await expect(logServerEvent(buildServerEvent('notifications-dispatch', 'run', 'x'), { ERROR_REPORTING_URL: 'https://c.example.test' }, fetcher)).resolves.toBeUndefined();
  });

  it('compares the dispatcher secret in constant time', () => {
    expect(timingSafeEqual('Bearer abc', 'Bearer abc')).toBe(true);
    expect(timingSafeEqual('Bearer abc', 'Bearer abd')).toBe(false);
    expect(timingSafeEqual('Bearer abc', 'Bearer abcd')).toBe(false);
    expect(timingSafeEqual('', 'Bearer abc')).toBe(false);
  });
});
