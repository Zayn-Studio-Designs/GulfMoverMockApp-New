// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEvent, scrub } from '../lib/monitoring';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('security headers', () => {
  it('the CSP hash matches the inline theme script exactly (no unsafe-inline scripts)', () => {
    const html = read('index.html');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const hash = createHash('sha256').update(script).digest('base64');
    for (const file of ['public/_headers', 'deploy/nginx.conf']) {
      const text = read(file);
      expect(text).toContain(`'sha256-${hash}'`);
      expect(text).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(text).toContain("frame-ancestors 'none'");
      expect(text).toContain('Strict-Transport-Security');
    }
  });
});

describe('service worker privacy', () => {
  it('never caches API, auth, storage or cross-origin responses', () => {
    const sw = read('public/sw.js');
    expect(sw).toContain('if (url.origin !== self.location.origin) return;');
    expect(sw).toContain("if (request.method !== 'GET') return;");
    expect(sw).not.toMatch(/supabase|rest\/v1|auth\/v1|functions\/v1/);
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
  });
});

describe('error monitoring scrubbing', () => {
  it('redacts e-mails, phone numbers, JWTs, QR secrets and keys; drops query strings', () => {
    const qr = `GMT1:${'a'.repeat(64)}`;
    const text = scrub(`fail for sara@example.test +966 50 123 4567 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop ${qr} sk_live_abc123`);
    expect(text).not.toMatch(/sara@|123 4567|eyJhbGci|GMT1:a|sk_live_abc/);
    const event = buildEvent(new Error('boom sara@example.test'), 'ctx', '/auth/reset-callback?token=secret#x', 'r1');
    expect(event.path).toBe('/auth/reset-callback');
    expect(event.message).toBe('boom [email]');
  });
});

describe('release environment checker', () => {
  const run = (env: Record<string, string>, args: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', ['scripts/release/check-env.mjs', ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const good = { VITE_APP_MODE: 'production', VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_publishable_x', VITE_AUTH_RESET_REDIRECT_URL: 'https://app.example/auth/reset-callback', VITE_PAYMENTS_FUNCTION_URL: 'https://abc.supabase.co/functions/v1/payments', VITE_ERROR_REPORTING_URL: 'https://errors.example/intake' };
  it('accepts a complete production configuration', () => {
    expect(run(good, ['production']).code).toBe(0);
  });
  it('rejects server keys or secret-looking names in browser variables, http URLs and live payments outside production', () => {
    expect(run({ ...good, VITE_SUPABASE_ANON_KEY: 'sb_secret_abc' }, ['production']).out).toMatch(/SERVER key/);
    expect(run({ ...good, VITE_STRIPE_SECRET: 'x' }, ['production']).code).toBe(1);
    expect(run({ ...good, VITE_SUPABASE_URL: 'http://abc.supabase.co' }, ['staging']).out).toMatch(/https/);
    const fnEnv = { ...good, SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's', GM_PUBLIC_APP_URL: 'p', GM_FUNCTIONS_PUBLIC_URL: 'f', GM_PAYMENTS_LIVE_ENABLED: 'true' };
    expect(run(fnEnv, ['staging', '--functions']).out).toMatch(/only allowed in production/);
    expect(run(fnEnv, ['production', '--functions']).out).toMatch(/without live provider credentials/);
  });
  it('never prints variable values', () => {
    const out = run({ ...good, VITE_SUPABASE_ANON_KEY: 'sb_secret_SHOULD_NOT_APPEAR' }, ['production']).out;
    expect(out).not.toContain('SHOULD_NOT_APPEAR');
  });
});
