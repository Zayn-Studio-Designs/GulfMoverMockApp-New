// @vitest-environment node
// Production-readiness audit — areas 2 & 7: environment separation, release checks and CSP.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateSupabaseConfig } from '../lib/supabase';
// @ts-expect-error — plain .mjs release script without type declarations
import { applyCsp, cspAllows } from '../../scripts/release/write-csp.mjs';

const KEY = 'sb_publishable_local_test_key';
const dev = (url: string, extra: Record<string, string> = {}) =>
  validateSupabaseConfig({ MODE: 'development', VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: KEY, ...extra });

describe('development server cannot reach production data', () => {
  it('a local stack is always allowed', () => {
    expect(dev('http://127.0.0.1:54321').ok).toBe(true);
    expect(dev('http://localhost:54321').ok).toBe(true);
  });
  it('a hosted project needs an explicit opt-in for a NON-production project', () => {
    expect(dev('https://devproject1234.supabase.co')).toMatchObject({ ok: false, issues: ['remote-database-in-development'] });
    expect(dev('https://devproject1234.supabase.co', { VITE_ALLOW_REMOTE_DATABASE: 'true' }).ok).toBe(true);
  });
  it('the production project is refused even with the opt-in', () => {
    const r = dev('https://prodref5678.supabase.co', { VITE_ALLOW_REMOTE_DATABASE: 'true', VITE_PRODUCTION_PROJECT_REF: 'prodref5678' });
    expect(r).toMatchObject({ ok: false, issues: ['production-database-in-development'] });
  });
  it('tests and production builds are unaffected (guard is development-server only)', () => {
    expect(validateSupabaseConfig({ MODE: 'test', VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: KEY }).ok).toBe(true);
    expect(validateSupabaseConfig({ MODE: 'production', VITE_SUPABASE_URL: 'https://prodref5678.supabase.co', VITE_SUPABASE_ANON_KEY: KEY,
      VITE_PRODUCTION_PROJECT_REF: 'prodref5678' }).ok).toBe(true);
  });
  it('the test runner never inherits a developer .env.local (demo mode, no backend)', () => {
    expect(import.meta.env.VITE_APP_MODE).toBe('demo');
    expect(import.meta.env.VITE_SUPABASE_URL ?? '').toBe('');
  });
});

describe('release environment check (scripts/release/check-env.mjs)', () => {
  const run = (target: string, env: Record<string, string>) => {
    try {
      return { code: 0, out: execFileSync('node', ['scripts/release/check-env.mjs', target], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) { const err = e as { status: number; stderr: string; stdout: string }; return { code: err.status, out: `${err.stdout}${err.stderr}` }; }
  };
  const base = { VITE_APP_MODE: 'production', VITE_SUPABASE_ANON_KEY: KEY, VITE_AUTH_RESET_REDIRECT_URL: 'https://app.example.test/auth/reset-callback' };
  it('refuses a staging build that targets the production project', () => {
    const r = run('staging', { ...base, VITE_SUPABASE_URL: 'https://prodref5678.supabase.co', GM_PRODUCTION_PROJECT_REF: 'prodref5678' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/staging build points at the PRODUCTION Supabase project/);
    expect(r.out).not.toContain(KEY); // never prints values
  });
  it('refuses a production build that targets anything but production', () => {
    const r = run('production', { ...base, VITE_SUPABASE_URL: 'https://stagingref.supabase.co', GM_PRODUCTION_PROJECT_REF: 'prodref5678' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not point at the production Supabase project/);
  });
  it('accepts a correctly targeted production build', () => {
    expect(run('production', { ...base, VITE_SUPABASE_URL: 'https://prodref5678.supabase.co', GM_PRODUCTION_PROJECT_REF: 'prodref5678' }).code).toBe(0);
  });
});

describe('Content-Security-Policy written at release (scripts/release/write-csp.mjs)', () => {
  const template = "connect-src 'self' https://YOUR-PROJECT-REF.supabase.co wss://YOUR-PROJECT-REF.supabase.co; img-src https://YOUR-PROJECT-REF.supabase.co";
  const env = (vars: Record<string, string>) => (name: string) => vars[name] ?? '';
  it('replaces the placeholder project and allows the error collector', () => {
    const out = applyCsp(template, env({ VITE_SUPABASE_URL: 'https://prodref5678.supabase.co', VITE_ERROR_REPORTING_URL: 'https://o1.ingest.example/api/1' }));
    expect(out).not.toContain('YOUR-PROJECT-REF');
    expect(cspAllows(out, 'https://prodref5678.supabase.co/rest/v1/x')).toBe(true);
    expect(cspAllows(out, 'https://o1.ingest.example/api/1')).toBe(true);
    expect(out).toContain('wss://prodref5678.supabase.co');
  });
  it('without the rewrite, the template CSP would block the collector', () => {
    expect(cspAllows(template, 'https://o1.ingest.example/api/1')).toBe(false);
  });
});
