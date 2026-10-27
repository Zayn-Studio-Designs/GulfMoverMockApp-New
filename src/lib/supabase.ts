import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client foundation — configuration and mode selection ONLY.
 *
 * This module intentionally performs no authentication, no RPC calls, no
 * storage access and no network requests by itself (`createClient` builds an
 * HTTP-facade object; it contacts nothing until a call is made). Later phases
 * wire it into the application.
 *
 * Mode rules (P0-2):
 * - Demo mode is the DEFAULT: with no `VITE_APP_MODE` (or any value other than
 *   "production"), the existing localStorage demo runs exactly as before and
 *   no Supabase client is created.
 * - Production mode is selected ONLY by explicitly setting `VITE_APP_MODE=production`.
 *   It requires a valid `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
 * - If production mode is selected but the configuration is missing or
 *   invalid, `getAppConfig` returns `mode: 'production'` with a
 *   `SupabaseConfigError` — it never silently falls back to demo data or
 *   demo authentication.
 *
 * Security: only publishable values may be passed through Vite `VITE_*`
 * variables (they are embedded in the browser bundle). The service_role /
 * secret key must never appear here or in any bundled configuration. RLS is
 * what limits the publishable key's power.
 */

/** Environment-variable source, injectable so tests never mutate `import.meta.env`. */
export type EnvSource = Record<string, string | undefined>;

export type AppMode = 'demo' | 'production';

/** Machine-readable configuration problems, safe to show in an error screen. */
export type SupabaseConfigIssue =
  | 'missing-url'
  | 'missing-anon-key'
  | 'invalid-url'
  | 'url-credentials'
  | 'url-insecure-http'
  | 'secret-key-detected';

/** Vite environment variable that selects production mode. */
export const APP_MODE_VARIABLE = 'VITE_APP_MODE';
export const SUPABASE_URL_VARIABLE = 'VITE_SUPABASE_URL';
export const SUPABASE_ANON_KEY_VARIABLE = 'VITE_SUPABASE_ANON_KEY';

/** The only value that explicitly selects production mode; everything else is demo. */
export const PRODUCTION_MODE_VALUE = 'production';

/** Documents where the localhost rule appears in error text (WET so a change in one place updates the message). */
const LOCAL_HOSTS_RULE_TEXT = 'local hosts: localhost, *.localhost, 127.0.0.1, [::1]';
/**
 * Exactly one user-facing sentence per issue. Only variable names and rules
 * are ever described — the configured VALUES (URL or key) are never included,
 * because a secret key pasted into the anon-key variable must never surface
 * anywhere an error is displayed or logged.
 */
const ISSUE_DESCRIPTIONS: Record<SupabaseConfigIssue, string> = {
  'missing-url': `${SUPABASE_URL_VARIABLE} is missing`,
  'missing-anon-key': `${SUPABASE_ANON_KEY_VARIABLE} is missing`,
  'invalid-url': `${SUPABASE_URL_VARIABLE} is not a valid http(s) URL`,
  'url-credentials': `${SUPABASE_URL_VARIABLE} contains an embedded username or password, which is not allowed`,
  'url-insecure-http': `${SUPABASE_URL_VARIABLE} uses plain HTTP to a non-local host (HTTP is only allowed for ${LOCAL_HOSTS_RULE_TEXT})`,
  'secret-key-detected': `${SUPABASE_ANON_KEY_VARIABLE} looks like a secret/service key, not the publishable anon key (best-effort safeguard, not a guarantee)`,
};

export class SupabaseConfigError extends Error {
  readonly issues: readonly SupabaseConfigIssue[];

  constructor(issues: readonly SupabaseConfigIssue[]) {
    const parts = Array.from(new Set(issues)).map(issue => ISSUE_DESCRIPTIONS[issue]);
    super(`Supabase configuration error (production mode selected): ${parts.join('; ')}. Set the required variables in the environment or .env, or run without ${APP_MODE_VARIABLE}=${PRODUCTION_MODE_VALUE} to use the demo.`);
    this.name = 'SupabaseConfigError';
    this.issues = issues;
  }
}

export type SupabaseConfig =
  | { readonly ok: true; readonly url: string; readonly anonKey: string }
  | { readonly ok: false; readonly issues: readonly SupabaseConfigIssue[] };

export type AppConfig =
  | { readonly mode: 'demo'; readonly supabase: null }
  | { readonly mode: 'production'; readonly supabase: SupabaseClient }
  | { readonly mode: 'production'; readonly supabase: null; readonly error: SupabaseConfigError };

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * The explicit local-development rule for plain HTTP (RFC 6761 reserves
 * *.localhost as loopback): 'localhost' and its subdomains, the loopback
 * literal 127.0.0.1, and IPv6 loopback [::1]. Every other host — including
 * any other 127.x address or an intranet name — must serve HTTPS.
 */
function isLocalhostHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith('.localhost');
}

/** Best-effort probe result for a legacy JWT-shaped anon key. */
type JwtProbe = 'not-jwt' | { readonly role: string };

/**
 * SAFEGUARD ONLY — NOT A GUARANTEE. Key-format checks recognise the Supabase
 * secret-key prefix and legacy JWT keys whose payload role is 'service_role'.
 * A key in any other format, a tampered JWT, or an obfuscated secret can evade
 * detection — nothing here proves a supplied key is publishable. The
 * environment (or .env) must remain public-values-only and the Supabase
 * dashboard remains the source of truth for key rotation.
 */
const SECRET_KEY_PREFIX = 'sb_secret_';

function decodeBase64UrlJson(segment: string): unknown {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Malformed JWT: treated as an opaque key, reported and stored without a crash.
    return null;
  }
}

function probeLegacyJwtRole(key: string): JwtProbe {
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) return 'not-jwt';
  const payload = decodeBase64UrlJson(parts[1]);
  if (payload !== null && typeof payload === 'object'
    && typeof (payload as { role?: unknown }).role === 'string') {
    return { role: (payload as { role: string }).role };
  }
  return 'not-jwt';
}

/** 'secret' means a recognisable secret key was supplied; anything else passes through. */
function probeRecognizedSecret(key: string): 'unknown' | 'secret' {
  if (key.startsWith(SECRET_KEY_PREFIX)) return 'secret';
  const probe = probeLegacyJwtRole(key);
  return probe === 'not-jwt' ? 'unknown' : (probe.role === 'service_role' ? 'secret' : 'unknown');
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * True when both required Supabase variables are present and non-blank.
 * Does NOT validate their format (see `validateSupabaseConfig`); it answers
 * "is there anything configured at all".
 */
export function isSupabaseConfigured(env: EnvSource = import.meta.env): boolean {
  return emptyToUndefined(env[SUPABASE_URL_VARIABLE]) !== undefined
    && emptyToUndefined(env[SUPABASE_ANON_KEY_VARIABLE]) !== undefined;
}

/**
 * Validates the required variables. No network requests are made — everything
 * here is local parsing/probing. The configured values themselves are never
 * placed in returned issues or error text.
 *
 * URL rules:
 * - must be present, non-blank and a syntactically valid http(s) URL;
 * - must NOT embed a username or password (userinfo in the URL);
 * - HTTPS hosts: always accepted;
 * - plain HTTP: accepted only for the documented local-development rule
 *   (`${LOCAL_HOSTS_RULE_TEXT}`); any other HTTP host is rejected, in every
 *   mode (such URLs are not valid Supabase configuration anywhere).
 *
 * Anon key rules:
 * - must be present and non-blank; the correct key is enforced by the client
 *   itself on first use, not here;
 * - SAFEGUARD ONLY (best-effort): recognized secret formats (the `sb_secret_`
 *   prefix; legacy JWTs with payload role 'service_role') are rejected.
 *   Malformed JWTs do not crash — they are treated as opaque keys (which the
 *   client will reject on first use).
 */
export function validateSupabaseConfig(env: EnvSource = import.meta.env): SupabaseConfig {
  const url = emptyToUndefined(env[SUPABASE_URL_VARIABLE]);
  const anonKey = emptyToUndefined(env[SUPABASE_ANON_KEY_VARIABLE]);
  const issues: SupabaseConfigIssue[] = [];

  if (url === undefined) {
    issues.push('missing-url');
  } else {
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      issues.push('invalid-url');
    } else if (parsed.username !== '' || parsed.password !== '') {
      issues.push('url-credentials');
    } else if (parsed.protocol === 'http:' && !isLocalhostHost(parsed.hostname)) {
      issues.push('url-insecure-http');
    }
  }

  if (anonKey === undefined) {
    issues.push('missing-anon-key');
  } else if (probeRecognizedSecret(anonKey) === 'secret') {
    issues.push('secret-key-detected');
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, url: url as string, anonKey: anonKey as string };
}

/** Explicit production selection: only the exact value counts; unset/anything else is demo. */
export function resolveAppMode(env: EnvSource = import.meta.env): AppMode {
  return emptyToUndefined(env[APP_MODE_VARIABLE]) === PRODUCTION_MODE_VALUE ? 'production' : 'demo';
}

/**
 * Module-level client cache (Checkpoint 1): every consumer — the auth service
 * today, the application shell in later checkpoints — shares ONE constructed
 * client per identical validated configuration, so no independent duplicate
 * clients are ever built. Demo mode never creates or caches a client, so the
 * demo default and all existing configuration-validation behaviour are
 * unchanged. Growth is bounded by the number of distinct valid configurations
 * in a page session (exactly one in any realistic deployment).
 */
const clientCache = new Map<string, SupabaseClient>();

function getOrCreateClient(url: string, anonKey: string): SupabaseClient {
  const cacheKey = `${url}\u0000${anonKey}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = createClient(url, anonKey);
    clientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Creates the typed Supabase client. Returns null in any non-production demo
 * situation and never falls back to a client on invalid configuration.
 * Valid configurations share a memoized client (see `getOrCreateClient`).
 */
export function getSupabaseClient(env: EnvSource = import.meta.env): SupabaseClient | null {
  if (resolveAppMode(env) !== 'production') return null;
  const config = validateSupabaseConfig(env);
  if (!config.ok) return null;
  return getOrCreateClient(config.url, config.anonKey);
}

/**
 * The whole application-mode decision in one call:
 * - default (unset/other mode): demo, supabase null — demo behaviour unchanged;
 * - production with valid config: production, real client;
 * - production without valid config: production with a clear SupabaseConfigError.
 */
export function getAppConfig(env: EnvSource = import.meta.env): AppConfig {
  if (resolveAppMode(env) !== 'production') return { mode: 'demo', supabase: null };
  const config = validateSupabaseConfig(env);
  if (!config.ok) return { mode: 'production', supabase: null, error: new SupabaseConfigError(config.issues) };
  return { mode: 'production', supabase: getOrCreateClient(config.url, config.anonKey) };
}
