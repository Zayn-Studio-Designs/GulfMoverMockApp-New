#!/usr/bin/env node
// Phase 17b - REAL time-based email-link expiry on the disposable stack.
//
// The default stack configures otp_expiry = 3600 (1h); waiting out a full hour
// in CI is impractical, so CI restarts the disposable stack with an
// accelerated otp_expiry (60s) and this suite proves REAL GoTrue time-based
// enforcement - not a mock, not a frontend check, not a config-value readout:
//
//   A (fresh)  signs up and confirms immediately       -> works (control)
//   B (aged)   signs up + requests recovery, then both links are verified
//              AFTER the expiry window                  -> both rejected
//   C (fresh)  signs up after the wait and confirms
//              immediately                              -> works
//
// B-rejected + C-accepted under the SAME running GoTrue is the differential
// proof that the rejection is time-based. The script reads
// supabase/config.toml to record which otp_expiry the evidence was produced
// under, and aborts (rather than false-passing) if the configured window is
// longer than the wait.
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY,
//      GM_E2E_MAIL_URL (loopback mail catcher).
// Safety: loopback-only; anything else aborts (exit 2).
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';
const MAIL_URL = (process.env.GM_E2E_MAIL_URL ?? process.env.GM_E2E_INBUCKET_URL ?? '').replace(/\/+$/, '');

const loopback = (u) => { try { const h = new globalThis.URL(u).hostname; return h === '127.0.0.1' || h === 'localhost'; } catch { return false; } };
if (!loopback(SUPABASE_URL) || /supabase\.co$/i.test(SUPABASE_URL)) {
  console.error('REFUSAL: GM_E2E_SUPABASE_URL is not an isolated loopback stack; aborting.');
  process.exit(2);
}
if (!loopback(MAIL_URL)) {
  console.error('REFUSAL: GM_E2E_MAIL_URL is not a loopback mail catcher; aborting.');
  process.exit(2);
}
if (!ANON || !SERVICE) { console.error('Missing GM_E2E_ANON_KEY / GM_E2E_SERVICE_KEY'); process.exit(2); }

// The wait must exceed the stack otp_expiry. CI restarts the disposable
// stack with otp_expiry = 60 before running this suite.
const EXPIRY_WAIT_SEC = Number(process.env.GM_E2E_EXPIRY_WAIT_SEC ?? '120');
const configuredOtpExpiry = () => {
  try {
    const m = readFileSync('supabase/config.toml', 'utf8').match(/^otp_expiry\s*=\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const errText = e => `${e?.message ?? e ?? ''} ${e?.code ?? ''}`;
const tag = `p17b-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;

const anonClient = () => createClient(SUPABASE_URL, ANON);

// ---- mail-catcher helpers (same disposable probe as Phases 15/17a) ----
let MAIL_KIND = '';
async function detectMailKind() {
  try { const r = await fetch(`${MAIL_URL}/api/v1/mailboxes`); if (r.ok) return 'inbucket'; } catch { /* not inbucket */ }
  try { const r = await fetch(`${MAIL_URL}/api/v1/messages?limit=1`); if (r.ok) return 'mailpit'; } catch { /* not mailpit */ }
  return '';
}
async function mailboxMessages(mailbox) {
  if (MAIL_KIND === 'mailpit') {
    try {
      const r = await fetch(`${MAIL_URL}/api/v1/messages?limit=50`);
      if (!r.ok) return [];
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.messages ?? []);
      const want = mailbox.toLowerCase();
      return list
        .filter(m => (m.To ?? []).some(t => (t.Address ?? '').toLowerCase() === want))
        .sort((a, b) => String(b.Created ?? '').localeCompare(String(a.Created ?? '')))
        .map(m => ({ ID: m.ID }));
    } catch { return []; }
  }
  for (const name of [mailbox, mailbox.split('@')[0]]) {
    try {
      const r = await fetch(`${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(name)}`);
      if (!r.ok) continue;
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.messages ?? j.data ?? j.mail ?? []);
      if (Array.isArray(list) && list.length) return list.slice().reverse().map(m => ({ _name: name, _id: m.id ?? m.ID ?? m.messageId }));
    } catch { /* try next form */ }
  }
  return [];
}
async function messageBody(entry) {
  if (MAIL_KIND === 'mailpit') {
    const r = await fetch(`${MAIL_URL}/api/v1/message/${entry.ID}`);
    if (!r.ok) return '';
    const m = await r.json();
    return m.HTML ?? m.Text ?? '';
  }
  const r = await fetch(`${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(entry._name)}/${entry._id}`);
  if (!r.ok) return '';
  const m = await r.json();
  return m.body?.html ?? m.body?.text ?? '';
}
function extractVerifyToken(html) {
  const m = html.match(/https?:\/\/[^\s"'<>]*\/auth\/v1\/verify\?[^\s"'<>]*/);
  if (!m) return null;
  try {
    const u = new globalThis.URL(m[0].replace(/&amp;/g, '&'));
    const token = u.searchParams.get('token');
    const type = u.searchParams.get('type');
    if (token && type) return { token, type };
  } catch { /* fall through */ }
  return null;
}
async function latestEmailBody(mailbox, type) {
  for (let i = 0; i < 25; i++) {
    const list = await mailboxMessages(mailbox);
    for (const entry of list) {
      const body = await messageBody(entry);
      if (body && extractVerifyToken(body)?.type === type) return body;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`no '${type}' email arrived for ${mailbox}`);
}

async function main() {
  const otpExpiry = configuredOtpExpiry();
  console.log(`stack otp_expiry from supabase/config.toml: ${otpExpiry ?? 'unknown'}s; planned wait: ${EXPIRY_WAIT_SEC}s`);
  check('accelerated otp_expiry is configured (shorter than the wait)', otpExpiry !== null && otpExpiry < EXPIRY_WAIT_SEC, `otp_expiry=${otpExpiry} wait=${EXPIRY_WAIT_SEC}`);
  if (otpExpiry === null || otpExpiry >= EXPIRY_WAIT_SEC) {
    console.log(`\nPHASE17B-EXPIRY: ${pass} passed, ${fail} failed (setup refuses a false pass: shorten otp_expiry or lengthen GM_E2E_EXPIRY_WAIT_SEC)`);
    process.exit(1);
  }
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));
  MAIL_KIND = await detectMailKind();
  check('disposable mail catcher reachable', MAIL_KIND === 'inbucket' || MAIL_KIND === 'mailpit', `got '${MAIL_KIND}'`);
  if (!MAIL_KIND) {
    console.log(`\nPHASE17B-EXPIRY: ${pass} passed, ${fail} failed (mail catcher unreachable, aborting)`);
    process.exit(1);
  }
  const clientA = anonClient();
  const signupA = await clientA.auth.signUp({ email: email('fresh-a'), password: PASSWORD });
  check('A: signup creates an unconfirmed user', !signupA.error && !!signupA.data.user && !signupA.data.session, errText(signupA.error));
  const linkA = extractVerifyToken(await latestEmailBody(email('fresh-a'), 'signup'));
  check('A: confirmation email carries a signup link', !!linkA, 'no link');
  const verA = await clientA.auth.verifyOtp({ token_hash: linkA.token, type: 'signup' });
  check('A: fresh confirmation link is accepted (control)', !verA.error && !!verA.data.session, errText(verA.error));
  const clientB = anonClient();
  const signupB = await clientB.auth.signUp({ email: email('aged-b'), password: PASSWORD });
  check('B: signup creates an unconfirmed user', !signupB.error && !!signupB.data.user, errText(signupB.error));
  const linkB = extractVerifyToken(await latestEmailBody(email('aged-b'), 'signup'));
  check('B: confirmation email captured before the wait', !!linkB, 'no link');
  const recReq = await anonClient().auth.resetPasswordForEmail(email('aged-b'));
  check('B: recovery request accepted before the wait', !recReq.error, errText(recReq.error));
  const recLinkB = extractVerifyToken(await latestEmailBody(email('aged-b'), 'recovery'));
  check('B: recovery email captured before the wait', !!recLinkB, 'no link');
  console.log(`waiting ${EXPIRY_WAIT_SEC}s so B links age past the ${otpExpiry}s otp_expiry...`);
  await new Promise(r => setTimeout(r, EXPIRY_WAIT_SEC * 1000));
  const verB = await anonClient().auth.verifyOtp({ token_hash: linkB.token, type: 'signup' });
  check('B: aged signup link is rejected (real time-based expiry)', !!verB.error && !verB.data.session, `GoTrue said: ${errText(verB.error) || 'ACCEPTED - expiry NOT enforced'}`);
  console.log(`note: aged-signup rejection message: ${errText(verB.error).slice(0, 160)}`);
  const recB = await anonClient().auth.verifyOtp({ token_hash: recLinkB.token, type: 'recovery' });
  check('B: aged recovery link is rejected (real time-based expiry)', !!recB.error && !recB.data.session, `GoTrue said: ${errText(recB.error) || 'ACCEPTED - expiry NOT enforced'}`);
  console.log(`note: aged-recovery rejection message: ${errText(recB.error).slice(0, 160)}`);
  const clientC = anonClient();
  const signupC = await clientC.auth.signUp({ email: email('fresh-c'), password: PASSWORD });
  check('C: signup works after the wait (control)', !signupC.error && !!signupC.data.user, errText(signupC.error));
  const linkC = extractVerifyToken(await latestEmailBody(email('fresh-c'), 'signup'));
  const verC = await clientC.auth.verifyOtp({ token_hash: linkC.token, type: 'signup' });
  check('C: fresh confirmation link is accepted after the wait (differential proof)', !verC.error && !!verC.data.session, errText(verC.error));
  const replayA = await anonClient().auth.verifyOtp({ token_hash: linkA.token, type: 'signup' });
  check('used link stays rejected under the short config (single-use)', !!replayA.error, 'replayed link unexpectedly accepted');
  const garbage = await anonClient().auth.verifyOtp({ token_hash: 'not-a-real-token', type: 'signup' });
  check('garbage token stays rejected under the short config', !!garbage.error, 'garbage token unexpectedly accepted');
  console.log(`\nPHASE17B-EXPIRY: ${pass} passed, ${fail} failed (otp_expiry=${otpExpiry}s, wait=${EXPIRY_WAIT_SEC}s)`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 400)); process.exit(1); });
