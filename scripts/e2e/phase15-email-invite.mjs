#!/usr/bin/env node
// Phase 15 — email confirmation, password reset, and invitations over the
// isolated disposable Supabase stack (real GoTrue + PostgREST + Inbucket).
//
// A. Signup confirmation via the captured local email; token reuse and
//    garbage tokens rejected.
// B. Password recovery via captured email; password change; old password and
//    old refresh token rejected, new password works.
// C. GoTrue staff invitation via captured email; invitee sets a password and
//    holds no company permissions until granted.
// D. In-app company-invitation lifecycle RPCs: idempotent invite, visibility
//    isolation, non-admin denial, accept, double-accept, cancel, accept after
//    cancel, invalid id, expired invite, self-invite, member revoke, audit rows,
//    and booker-role permission boundaries.
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY,
//      GM_E2E_INBUCKET_URL (Inbucket base URL for the disposable stack).
// Safety: Supabase and Inbucket URLs MUST be loopback; anything else aborts.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';
// Disposable mail catcher base URL (Inbucket or Mailpit — the stack decides;
// the script probes which API answers). GM_E2E_INBUCKET_URL kept as fallback.
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
let MAIL_KIND = '';
if (!ANON || !SERVICE) { console.error('Missing GM_E2E_ANON_KEY / GM_E2E_SERVICE_KEY'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const errText = e => `${e?.message ?? e ?? ''} ${e?.code ?? ''}`;
const tag = `p15-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;
const NEW_PASSWORD = `Changed-${randomUUID().slice(0, 8)}-pw`;

const anonClient = () => createClient(SUPABASE_URL, ANON);
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
async function mustSingle(promise, what) {
  const r = await promise;
  if (r.error || !r.data) throw new Error(`fixture ${what}: ${errText(r.error) || 'no row returned'}`);
  return r.data;
}

// ---- Disposable mail-catcher helpers (Inbucket or Mailpit) ----
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
      if (Array.isArray(list) && list.length) {
        return list.slice().reverse().map(m => ({ _name: name, _id: m.id ?? m.ID ?? m.messageId }));
      }
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
// Returns the newest captured email that carries a /verify link of `type`
// (newest first: signup confirmations and recovery mails share a mailbox).
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

async function main() {
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));
  MAIL_KIND = await detectMailKind();
  check('disposable mail catcher API reachable (inbucket or mailpit)', MAIL_KIND === 'inbucket' || MAIL_KIND === 'mailpit', `is GM_E2E_MAIL_URL correct? got '${MAIL_KIND}'`);
  if (!MAIL_KIND) {
    console.log(`\nPHASE15-EMAIL-INVITE: ${pass} passed, ${fail} failed (mail catcher unreachable, aborting)`);
    process.exit(1);
  }
  console.log(`mail catcher kind: ${MAIL_KIND}`);

  // ---- A. signup confirmation via captured email ----
  const fresh = anonClient();
  const signupRes = await fresh.auth.signUp({ email: email('confirm-me'), password: PASSWORD });
  check('signup creates an unconfirmed user (no session yet)', !signupRes.error && !!signupRes.data.user && !signupRes.data.session, errText(signupRes.error));
  const confirmBody = await latestEmailBody(email('confirm-me'), 'signup');
  const confirmLink = extractVerifyToken(confirmBody);
  check('confirmation email arrives with a signup verify link', !!confirmLink && confirmLink.type === 'signup', confirmLink ? confirmLink.type : 'no link found');
  const verifyRes = await fresh.auth.verifyOtp({ token_hash: confirmLink.token, type: 'signup' });
  check('signup confirmation link activates the session', !verifyRes.error && !!verifyRes.data.session, errText(verifyRes.error));
  const meAfter = await fresh.auth.getUser();
  check('confirmed identity matches', !meAfter.error && meAfter.data.user?.email === email('confirm-me'), errText(meAfter.error));
  const signinAfter = await anonClient().auth.signInWithPassword({ email: email('confirm-me'), password: PASSWORD });
  check('confirmed user can sign in with the password', !signinAfter.error && !!signinAfter.data.session, errText(signinAfter.error));
  const reuseRes = await anonClient().auth.verifyOtp({ token_hash: confirmLink.token, type: 'signup' });
  check('used confirmation link is rejected on replay', !!reuseRes.error, 'replayed link unexpectedly accepted');
  const garbageRes = await anonClient().auth.verifyOtp({ token_hash: 'not-a-real-token', type: 'signup' });
  check('garbage confirmation token is rejected', !!garbageRes.error, 'garbage token unexpectedly accepted');

  // ---- B. password recovery via captured email ----
  const recReq = await anonClient().auth.resetPasswordForEmail(email('confirm-me'));
  check('password-recovery request accepted', !recReq.error, errText(recReq.error));
  const recBody = await latestEmailBody(email('confirm-me'), 'recovery');
  const recLink = extractVerifyToken(recBody);
  check('recovery email arrives with a recovery link', !!recLink && recLink.type === 'recovery', recLink ? recLink.type : 'no link found');
  const recClient = anonClient();
  const recVerify = await recClient.auth.verifyOtp({ token_hash: recLink.token, type: 'recovery' });
  check('recovery link yields a session', !recVerify.error && !!recVerify.data.session?.refresh_token, errText(recVerify.error));
  if (!recVerify.data?.session?.refresh_token) {
    console.log(`\nPHASE15-EMAIL-INVITE: ${pass} passed, ${fail} failed (recovery session missing, aborting)`);
    process.exit(1);
  }
  const oldRefresh = recVerify.data.session.refresh_token;
  const pwChange = await recClient.auth.updateUser({ password: NEW_PASSWORD });
  check('password change succeeds through the recovery session', !pwChange.error, errText(pwChange.error));
  const oldPw = await anonClient().auth.signInWithPassword({ email: email('confirm-me'), password: PASSWORD });
  check('old password is rejected after the change', !!oldPw.error, 'old password unexpectedly accepted');
  const newPw = await anonClient().auth.signInWithPassword({ email: email('confirm-me'), password: NEW_PASSWORD });
  check('new password signs in', !newPw.error && !!newPw.data.session, errText(newPw.error));
  const oldRef = await anonClient().auth.refreshSession({ refresh_token: oldRefresh });
  check('pre-change refresh token is rejected after password change', !!oldRef.error, 'old refresh token unexpectedly accepted');

  // ---- C. GoTrue invitation via captured email ----
  const invEmail = email('invited-u');
  const gotrueInv = await admin.auth.admin.inviteUserByEmail(invEmail);
  check('GoTrue invitation accepted', !gotrueInv.error && !!gotrueInv.data.user, errText(gotrueInv.error));
  const invBody = await latestEmailBody(invEmail, 'invite');
  const invLink = extractVerifyToken(invBody);
  check('invitation email arrives with an invite link', !!invLink && invLink.type === 'invite', invLink ? invLink.type : 'no link found');
  const invClient = anonClient();
  const invVerify = await invClient.auth.verifyOtp({ token_hash: invLink.token, type: 'invite' });
  check('invite link yields a session', !invVerify.error && !!invVerify.data.session, errText(invVerify.error));
  const invPw = await invClient.auth.updateUser({ password: PASSWORD });
  check('invited user sets a password', !invPw.error, errText(invPw.error));
  const invSignin = await anonClient().auth.signInWithPassword({ email: invEmail, password: PASSWORD });
  check('invited user signs in with the new password', !invSignin.error && !!invSignin.data.session, errText(invSignin.error));
  await admin.from('profiles').insert({ id: invSignin.data.user.id, display_name: 'Fictional Invited', preferred_language: 'en', status: 'active' });
  const invSnap = await invClient.rpc('my_company_memberships');
  check('invited user holds no company memberships yet', !invSnap.error && (invSnap.data ?? []).length === 0, JSON.stringify(invSnap.data)?.slice(0, 120));

  // ---- D. in-app company-invitation lifecycle ----
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error) throw new Error(`fixture user ${n}: ${r.error.message}`);
    await admin.from('profiles').insert({ id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' });
    return r.data.user.id;
  };
  const adminUid = await mkUser('l-admin'), bookerUid = await mkUser('l-booker'), otherUid = await mkUser('l-other');
  const org = await mustSingle(admin.from('organizations').insert({
    legal_name: `Fictional LifeCo ${tag} LLC`, display_name: 'LifeCo', status: 'approved',
    account_type: 'corporate', contact_email: `lifeco-${tag}@example.test`, created_by: adminUid,
  }).select('id').single(), 'lifecycle org insert');
  await admin.from('organization_memberships').insert([
    { organization_id: org.id, user_id: adminUid, membership_role: 'company_admin', status: 'active' },
    { organization_id: org.id, user_id: bookerUid, membership_role: 'company_booker', status: 'active' },
  ]);
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cAdmin = await signIn('l-admin'), cBooker = await signIn('l-booker'), cOther = await signIn('l-other');

  const inviteeEmail = email('invitee');
  await mkUser('invitee');
  const cInvitee = await signIn('invitee');
  const inv1 = await cAdmin.rpc('invite_company_member', { p_org: org.id, p_email: inviteeEmail });
  check('admin invites a new member (id returned)', !inv1.error && !!inv1.data, errText(inv1.error));
  const inv2 = await cAdmin.rpc('invite_company_member', { p_org: org.id, p_email: inviteeEmail.toUpperCase() });
  check('duplicate invite is idempotent (same id)', !inv2.error && inv2.data === inv1.data, `${errText(inv2.error)} ${inv2.data}`);
  const seenByInvitee = await cInvitee.from('company_invitations').select('id').eq('id', inv1.data);
  check('invitee can see their own invitation (RLS)', !seenByInvitee.error && seenByInvitee.data.length === 1, errText(seenByInvitee.error));
  const seenByOther = await cOther.from('company_invitations').select('id').eq('id', inv1.data);
  check('unrelated user cannot see the invitation (RLS)', !seenByOther.error && seenByOther.data.length === 0, errText(seenByOther.error));
  const bookerInvite = await cBooker.rpc('invite_company_member', { p_org: org.id, p_email: email('l-other') });
  check('non-admin member cannot invite', !!bookerInvite.error && /not authorized|42501/.test(errText(bookerInvite.error)), errText(bookerInvite.error));
  const selfInvite = await cAdmin.rpc('invite_company_member', { p_org: org.id, p_email: email('l-admin') });
  check('self-invite is rejected', !!selfInvite.error && /invalid email/.test(errText(selfInvite.error)), errText(selfInvite.error));
  const accept1 = await cInvitee.rpc('accept_company_invitation', { p_id: inv1.data });
  check('invitee accepts (recorded)', !accept1.error && accept1.data === 'recorded', errText(accept1.error));
  const memberRow = await mustSingle(admin.from('organization_memberships').select('membership_role,status').eq('organization_id', org.id).eq('user_id', (await cInvitee.auth.getUser()).data.user.id).single(), 'accepted membership row');
  check('accepted invitee is an active company_booker', memberRow.membership_role === 'company_booker' && memberRow.status === 'active', JSON.stringify(memberRow));
  const accept2 = await cInvitee.rpc('accept_company_invitation', { p_id: inv1.data });
  check('double accept is idempotent (unchanged)', !accept2.error && accept2.data === 'unchanged', errText(accept2.error));
  const inviteeInvite = await cInvitee.rpc('invite_company_member', { p_org: org.id, p_email: email('l-other') });
  check('booker cannot invite others', !!inviteeInvite.error, 'booker invite unexpectedly accepted');

  const cancelEmail = email('cancelled');
  await mkUser('cancelled');
  const cCancelled = await signIn('cancelled');
  const invC = await cAdmin.rpc('invite_company_member', { p_org: org.id, p_email: cancelEmail });
  check('second invitation created for cancel flow', !invC.error && !!invC.data, errText(invC.error));
  const cancel1 = await cAdmin.rpc('cancel_company_invitation', { p_id: invC.data });
  check('admin cancels the invitation (recorded)', !cancel1.error && cancel1.data === 'recorded', errText(cancel1.error));
  const cancel2 = await cAdmin.rpc('cancel_company_invitation', { p_id: invC.data });
  check('double cancel is idempotent (unchanged)', !cancel2.error && cancel2.data === 'unchanged', errText(cancel2.error));
  const acceptAfterCancel = await cCancelled.rpc('accept_company_invitation', { p_id: invC.data });
  check('accept after cancel is rejected', !!acceptAfterCancel.error && /invalid_transition/.test(errText(acceptAfterCancel.error)), errText(acceptAfterCancel.error));

  const badAccept = await cInvitee.rpc('accept_company_invitation', { p_id: randomUUID() });
  check('accept with an unknown id fails', !!badAccept.error, 'unknown-id accept unexpectedly succeeded');
  const wrongAccept = await cOther.rpc('accept_company_invitation', { p_id: inv1.data });
  check('another user cannot accept someone else invitation', !!wrongAccept.error, 'cross-user accept unexpectedly succeeded');

  const expEmail = email('expired');
  await mkUser('expired');
  const cExpired = await signIn('expired');
  const invE = await cAdmin.rpc('invite_company_member', { p_org: org.id, p_email: expEmail });
  await admin.from('company_invitations').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', invE.data);
  const acceptExpired = await cExpired.rpc('accept_company_invitation', { p_id: invE.data });
  check('expired invitation is rejected', !!acceptExpired.error && /invalid_transition/.test(errText(acceptExpired.error)), errText(acceptExpired.error));

  const memberId = (await admin.from('organization_memberships').select('id').eq('organization_id', org.id).eq('user_id', (await cInvitee.auth.getUser()).data.user.id).single()).data.id;
  const revoke1 = await cAdmin.rpc('revoke_company_member', { p_id: memberId });
  check('admin revokes the member (recorded)', !revoke1.error && revoke1.data === 'recorded', errText(revoke1.error));
  const revokedRow = (await admin.from('organization_memberships').select('status').eq('id', memberId).single()).data;
  check('revoked member shows suspended', revokedRow?.status === 'suspended', JSON.stringify(revokedRow));
  const selfRevoke = await cAdmin.rpc('revoke_company_member', { p_id: (await admin.from('organization_memberships').select('id').eq('organization_id', org.id).eq('user_id', adminUid).single()).data.id });
  check('admin cannot revoke themselves', !!selfRevoke.error, 'self-revoke unexpectedly accepted');

  const events = await admin.from('membership_events').select('action').eq('organization_id', org.id);
  const actions = (events.data ?? []).map(e => e.action);
  check('membership audit trail records the lifecycle', !events.error && ['invited', 'accepted', 'invitation_revoked', 'membership_revoked'].every(a => actions.includes(a)), actions.join(','));

  console.log(`\nPHASE15-EMAIL-INVITE: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', String(e?.message ?? e).slice(0, 400)); process.exit(1); });
