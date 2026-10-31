#!/usr/bin/env node
// Writes the real origins into the shipped Content-Security-Policy after `vite build`.
//
// public/_headers (copied to dist/_headers) and deploy/nginx.conf contain the placeholder
// host YOUR-PROJECT-REF.supabase.co. Shipped as-is, the CSP would block every Supabase call
// and every error report. This rewrites dist/_headers (and, with --nginx-headers <out>, the nginx
// security-header snippet) so connect-src allows exactly: the Supabase project (https + wss), the payments
// function host and the error collector — and nothing else.
//
//   node scripts/release/write-csp.mjs [--nginx-headers dist/gulf-mover-security-headers.conf]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const v = name => (process.env[name] ?? '').trim();
const origin = url => { try { return new URL(url).origin; } catch { return ''; } };
const PLACEHOLDER = 'YOUR-PROJECT-REF.supabase.co';

export function applyCsp(text, envGet = v) {
  const supabase = origin(envGet('VITE_SUPABASE_URL'));
  if (!supabase) throw new Error('VITE_SUPABASE_URL is required to write the CSP');
  const host = new URL(supabase).host;
  let out = text.split(PLACEHOLDER).join(host);
  const extra = [origin(envGet('VITE_PAYMENTS_FUNCTION_URL')), origin(envGet('VITE_ERROR_REPORTING_URL'))]
    .filter(o => o && o !== supabase && /^https:\/\//.test(o));
  if (extra.length) {
    out = out.replace(/connect-src ([^;"]*)/g, (m, list) => {
      const have = new Set(list.split(/\s+/));
      return `connect-src ${[list.trim(), ...extra.filter(o => !have.has(o))].join(' ')}`;
    });
  }
  return out;
}

export function cspAllows(text, url) {
  const o = origin(url);
  const m = /connect-src ([^;"]*)/.exec(text);
  return Boolean(o && m && m[1].split(/\s+/).includes(o));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync('dist/_headers')) { console.error('dist/_headers missing: run the build first'); process.exit(1); }
  const headers = applyCsp(readFileSync('dist/_headers', 'utf8'));
  writeFileSync('dist/_headers', headers);
  const i = process.argv.indexOf('--nginx-headers');
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], applyCsp(readFileSync('deploy/nginx-security-headers.conf', 'utf8')));
  for (const name of ['VITE_SUPABASE_URL', 'VITE_PAYMENTS_FUNCTION_URL', 'VITE_ERROR_REPORTING_URL']) {
    if (v(name) && !cspAllows(headers, v(name))) { console.error(`error: CSP connect-src does not allow ${name}`); process.exit(1); }
  }
  if (headers.includes(PLACEHOLDER)) { console.error('error: CSP still contains the placeholder project host'); process.exit(1); }
  console.log('csp: connect-src written for the configured origins');
}
