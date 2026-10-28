#!/usr/bin/env node
// Release-time environment validation for Gulf Mover.
//
//   node scripts/release/check-env.mjs <development|staging|production> [--functions]
//
// Reads variables from the process environment (CI secrets / the host's build settings).
// Prints only variable NAMES and problems — never values. Exit code 1 on any error.
// --functions additionally checks the edge-function secrets expected for that environment.
const env = process.argv[2];
const checkFunctions = process.argv.includes('--functions');
if (!['development', 'staging', 'production'].includes(env)) {
  console.error('usage: check-env.mjs <development|staging|production> [--functions]');
  process.exit(2);
}
const v = name => (process.env[name] ?? '').trim();
const errors = [];
const warnings = [];
const isLocal = url => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);

function decodeJwtRole(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role ?? null; } catch { return null; }
}

// 1. Browser build variables (embedded in the bundle: public values only).
if (env !== 'development' && v('VITE_APP_MODE') !== 'production') errors.push('VITE_APP_MODE must be "production"');
const url = v('VITE_SUPABASE_URL');
if (v('VITE_APP_MODE') === 'production') {
  if (!url) errors.push('VITE_SUPABASE_URL is required');
  else if (env !== 'development' && !/^https:\/\//.test(url)) errors.push('VITE_SUPABASE_URL must use https outside development');
  else if (env !== 'development' && isLocal(url)) errors.push('VITE_SUPABASE_URL points at a local stack');
  const anon = v('VITE_SUPABASE_ANON_KEY');
  if (!anon) errors.push('VITE_SUPABASE_ANON_KEY is required');
  if (anon.startsWith('sb_secret_') || decodeJwtRole(anon) === 'service_role') errors.push('VITE_SUPABASE_ANON_KEY holds a SERVER key — never ship it to browsers');
  const reset = v('VITE_AUTH_RESET_REDIRECT_URL');
  if (!reset) errors.push('VITE_AUTH_RESET_REDIRECT_URL is required');
  else if (env !== 'development' && !/^https:\/\//.test(reset)) errors.push('VITE_AUTH_RESET_REDIRECT_URL must use https');
}
for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith('VITE_')) continue;
  if (/SERVICE|SECRET|PRIVATE|WEBHOOK|TOKEN/i.test(name)) errors.push(`${name}: secret-looking variable must not be a VITE_* (browser) variable`);
  if (/^(sk_live_|sk_test_|sb_secret_)/.test(value ?? '')) errors.push(`${name}: contains a secret key`);
}
const fn = v('VITE_PAYMENTS_FUNCTION_URL');
if (fn && env !== 'development' && !/^https:\/\//.test(fn)) errors.push('VITE_PAYMENTS_FUNCTION_URL must use https');
if (!fn && env === 'production') warnings.push('VITE_PAYMENTS_FUNCTION_URL unset: only the sandbox simulator is available');
const report = v('VITE_ERROR_REPORTING_URL');
if (report && !/^https:\/\//.test(report)) errors.push('VITE_ERROR_REPORTING_URL must use https');
if (!report && env !== 'development') warnings.push('VITE_ERROR_REPORTING_URL unset: browser errors are not collected');

// 2. Edge-function secrets (server side only).
if (checkFunctions) {
  for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GM_PUBLIC_APP_URL', 'GM_FUNCTIONS_PUBLIC_URL']) {
    if (!v(name)) errors.push(`${name} is required for edge functions`);
  }
  const live = v('GM_PAYMENTS_LIVE_ENABLED') === 'true';
  if (env !== 'production' && live) errors.push('GM_PAYMENTS_LIVE_ENABLED=true is only allowed in production');
  if (live && !((v('MOYASAR_LIVE_SECRET_KEY') && v('MOYASAR_LIVE_WEBHOOK_TOKEN')) || v('TAP_LIVE_SECRET_KEY'))) errors.push('live payments enabled without live provider credentials');
  if (!live && (v('MOYASAR_LIVE_SECRET_KEY') || v('TAP_LIVE_SECRET_KEY'))) warnings.push('live provider keys present while live payments are disabled — remove until authorised');
  for (const name of ['MOYASAR_TEST_SECRET_KEY', 'TAP_TEST_SECRET_KEY']) if (v(name) && !v(name).startsWith('sk_test_')) errors.push(`${name} is not a test key`);
  if (!v('GM_SANDBOX_WEBHOOK_SECRET') && env !== 'production') warnings.push('GM_SANDBOX_WEBHOOK_SECRET unset: sandbox webhooks are refused');
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(`${env}: ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
