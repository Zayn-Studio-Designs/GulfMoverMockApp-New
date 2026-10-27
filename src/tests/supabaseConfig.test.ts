import { describe, expect, it } from 'vitest';
import {
  APP_MODE_VARIABLE,
  SupabaseConfigError,
  SUPABASE_ANON_KEY_VARIABLE,
  SUPABASE_URL_VARIABLE,
  getAppConfig,
  getSupabaseClient,
  isSupabaseConfigured,
  resolveAppMode,
  validateSupabaseConfig,
} from '../lib/supabase';

/** Synthetic JWT builder for legacy-format key tests. NO real credentials. */
function base64Url(object: object): string {
  return btoa(JSON.stringify(object))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const syntheticJwt = (payload: object) =>
  [base64Url({ alg: 'HS256', typ: 'JWT' }), base64Url(payload), 'not-a-real-signature'].join('.');

/** P0-2 configuration foundation tests. Pure functions; no env mutation, no network. */

const env = (values: Record<string, string | undefined>) => values;

const VALID_URL = 'https://example-project.supabase.co';
const VALID_KEY = 'test-publishable-anon-key';

const validEnv = () => env({
  [SUPABASE_URL_VARIABLE]: VALID_URL,
  [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
  [APP_MODE_VARIABLE]: 'production',
});

describe('isSupabaseConfigured', () => {
  it('is false when both variables are missing', () => {
    expect(isSupabaseConfigured(env({}))).toBe(false);
  });

  it('is false when either variable is missing or blank', () => {
    expect(isSupabaseConfigured(env({ [SUPABASE_URL_VARIABLE]: VALID_URL }))).toBe(false);
    expect(isSupabaseConfigured(env({ [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY }))).toBe(false);
    expect(isSupabaseConfigured(env({ [SUPABASE_URL_VARIABLE]: '  ' }))).toBe(false);
  });

  it('is true when both variables are present and non-blank', () => {
    expect(isSupabaseConfigured(validEnv())).toBe(true);
    // Even without production mode explicitly selected: presence, not mode, is asked.
    expect(isSupabaseConfigured(env({
      [SUPABASE_URL_VARIABLE]: VALID_URL,
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toBe(true);
  });
});

describe('validateSupabaseConfig', () => {
  it('fails with both missing issues when nothing is set', () => {
    const result = validateSupabaseConfig(env({}));
    expect(result).toEqual({ ok: false, issues: ['missing-url', 'missing-anon-key'] });
  });

  it('rejects a malformed URL and a missing key independently', () => {
    expect(validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: 'not-a-url',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: false, issues: ['invalid-url'] });
    expect(validateSupabaseConfig(env({ [SUPABASE_URL_VARIABLE]: VALID_URL })))
      .toEqual({ ok: false, issues: ['missing-anon-key'] });
  });

  it('accepts a local Supabase stack URL (http)', () => {
    const result = validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: 'http://127.0.0.1:54321',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }));
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:54321', anonKey: VALID_KEY });
  });

  it('accepts a valid complete configuration, trimming whitespace', () => {
    const result = validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: `  ${VALID_URL}  `,
      [SUPABASE_ANON_KEY_VARIABLE]: ` ${VALID_KEY} `,
    }));
    expect(result).toEqual({ ok: true, url: VALID_URL, anonKey: VALID_KEY });
  });

  it('still reports a clear missing-anon-key error for a whitespace-only key', () => {
    expect(validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: VALID_URL,
      [SUPABASE_ANON_KEY_VARIABLE]: '   ',
    }))).toEqual({ ok: false, issues: ['missing-anon-key'] });
  });
});

describe('validateSupabaseConfig — secret-key safeguard (best-effort, not a guarantee)', () => {
  it('rejects an sb_secret_ key', () => {
    const secretKey = 'sb_secret_TOPSECRETVALUE';
    const result = validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: VALID_URL,
      [SUPABASE_ANON_KEY_VARIABLE]: secretKey,
    }));
    expect(result).toEqual({ ok: false, issues: ['secret-key-detected'] });
  });

  it('rejects a legacy JWT whose payload role is service_role', () => {
    const serviceJwt = syntheticJwt({ role: 'service_role', iss: 'supabase', ref: 'demo-ref' });
    const result = validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: VALID_URL,
      [SUPABASE_ANON_KEY_VARIABLE]: serviceJwt,
    }));
    expect(result).toEqual({ ok: false, issues: ['secret-key-detected'] });
  });

  it('accepts a legacy JWT whose payload role is anon when the rest is valid', () => {
    const anonJwt = syntheticJwt({ role: 'anon', iss: 'supabase', ref: 'demo-ref' });
    const result = validateSupabaseConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: VALID_URL,
      [SUPABASE_ANON_KEY_VARIABLE]: anonJwt,
    }));
    expect(result).toEqual({ ok: true, url: VALID_URL, anonKey: anonJwt });
  });

  it('does not crash on malformed JWTs (treated as opaque keys)', () => {
    const malformedKeys = [
      'aaa.@@@not-base64@@@.sig',   // undecodable payload
      '4part.head.payload.signature', // wrong segment count
      'a..b',                      // empty segment
      '.@@@.sig',                  // empty header segment
    ];
    for (const key of malformedKeys) {
      const result = validateSupabaseConfig(env({
        [SUPABASE_URL_VARIABLE]: VALID_URL,
        [SUPABASE_ANON_KEY_VARIABLE]: key,
      }));
      expect(result).toEqual({ ok: true, url: VALID_URL, anonKey: key });
    }
  });

  it('never includes the supplied secret value in the error', () => {
    const secretKey = 'sb_secret_VERYSECRET история-値-§§';
    const config = getAppConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: VALID_URL,
      [SUPABASE_ANON_KEY_VARIABLE]: secretKey,
    }));
    if ('error' in config && config.error) {
      const leaked: string = config.error.message;
      const serviceJwt = syntheticJwt({ role: 'service_role' });
      const jwtError = validateSupabaseConfig(env({
        [SUPABASE_URL_VARIABLE]: VALID_URL,
        [SUPABASE_ANON_KEY_VARIABLE]: serviceJwt,
      }));
      expect(jwtError.ok).toBe(false);
      // Error text carries variable NAMES, never values:
      expect(leaked + (config.error.name ?? '')).not.toContain(secretKey);
      expect(leaked).toContain(SUPABASE_ANON_KEY_VARIABLE);
    } else {
      expect.unreachable('expected a configuration error');
    }
  });
});

describe('validateSupabaseConfig — URL safety rules', () => {
  it('rejects plain HTTP to an arbitrary remote host in production', () => {
    expect(validateSupabaseConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: 'http://some-remote-host.example.com',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: false, issues: ['url-insecure-http'] });
  });

  it('accepts production HTTPS URLs', () => {
    expect(validateSupabaseConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: 'https://demo-ref.supabase.co/auth/v1',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: true, url: 'https://demo-ref.supabase.co/auth/v1', anonKey: VALID_KEY });
  });

  it('accepts HTTP for documented local hosts only', () => {
    expect(validateSupabaseConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: 'http://localhost:54321',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: true, url: 'http://localhost:54321', anonKey: VALID_KEY });
    expect(validateSupabaseConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: 'http://127.0.0.1:54321',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: true, url: 'http://127.0.0.1:54321', anonKey: VALID_KEY });
  });

  it('rejects HTTP to a wrongly-shaped local host (e.g. 127.0.0.2)', () => {
    expect(validateSupabaseConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: 'http://127.0.0.2:54321',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: false, issues: ['url-insecure-http'] });
  });

  it('rejects URLs containing embedded username or password', () => {
    expect(validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: 'https://user:pass@example-project.supabase.co',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: false, issues: ['url-credentials'] });
    expect(validateSupabaseConfig(env({
      [SUPABASE_URL_VARIABLE]: 'https://someone@example-project.supabase.co',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }))).toEqual({ ok: false, issues: ['url-credentials'] });
  });

  it('never includes the configured URL in the error text', () => {
    const badUrl = 'http://some-remote-host.example.com';
    const config = getAppConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: badUrl,
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }));
    if ('error' in config && config.error) {
      expect(config.error.message).not.toContain(badUrl);
      expect(config.error.message).toContain(SUPABASE_URL_VARIABLE);
    } else {
      expect.unreachable('expected a configuration error');
    }
  });
});

describe('resolveAppMode', () => {
  it('defaults to demo when nothing (or anything other than "production") is set', () => {
    expect(resolveAppMode(env({}))).toBe('demo');
    expect(resolveAppMode(env({ [APP_MODE_VARIABLE]: undefined }))).toBe('demo');
    expect(resolveAppMode(env({ [APP_MODE_VARIABLE]: '' }))).toBe('demo');
    expect(resolveAppMode(env({ [APP_MODE_VARIABLE]: ' demo ' }))).toBe('demo');
    expect(resolveAppMode(env({ [APP_MODE_VARIABLE]: 'PRODUCTION' }))).toBe('demo'); // exact match only
  });

  it('selects production only for the exact "production" value', () => {
    expect(resolveAppMode(env({ [APP_MODE_VARIABLE]: 'production' }))).toBe('production');
  });
});

describe('getAppConfig / getSupabaseClient', () => {
  it('demo is the default: no client is created and demo behaviour is unchanged', () => {
    const config = getAppConfig(env({}));
    expect(config.mode).toBe('demo');
    expect(config.supabase).toBeNull();
    expect(getSupabaseClient(env({ [APP_MODE_VARIABLE]: 'demo' }))).toBeNull();
  });

  it('production without configuration returns a clear error and does NOT silently fall back to demo', () => {
    const config = getAppConfig(env({ [APP_MODE_VARIABLE]: 'production' }));
    expect(config.mode).toBe('production');
    expect('error' in config && config.error).toBeInstanceOf(SupabaseConfigError);
    if ('error' in config) {
      expect(config.error.issues).toEqual(['missing-url', 'missing-anon-key']);
      expect(config.error.message).toContain('VITE_SUPABASE_URL is missing');
    }
    expect(getSupabaseClient(env({ [APP_MODE_VARIABLE]: 'production' }))).toBeNull();
  });

  it('production with an invalid URL reports exactly that issue and no client', () => {
    const config = getAppConfig(env({
      [APP_MODE_VARIABLE]: 'production',
      [SUPABASE_URL_VARIABLE]: 'not-a-url',
      [SUPABASE_ANON_KEY_VARIABLE]: VALID_KEY,
    }));
    if ('error' in config) expect(config.error.issues).toEqual(['invalid-url']);
    else expect.unreachable('expected a configuration error');
  });

  it('production with valid configuration returns a real client (constructed offline)', () => {
    const client = getSupabaseClient(validEnv());
    expect(client).not.toBeNull();
    // Structural check only: constructing a client contacts nothing, and its
    // endpoint comes from the validated configuration (asserted above via
    // validateSupabaseConfig).
    expect(typeof client!.auth).toBe('object');
    expect(typeof client!.functions).toBe('object');
    expect(typeof client!.realtime).toBe('object');
  });
});
