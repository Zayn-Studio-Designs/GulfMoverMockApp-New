#!/usr/bin/env node
// Phase 18 — register_company full behaviour on the real disposable stack.
// No mocks, no route interception. Covers the Section 4 gap left open after
// Phase 17: valid pending creation, same-key idempotency, changed-payload
// rejection, cross-user key rejection, same-key concurrency, suspended-user
// denial (first call AND replay), rollback on failure, and auth.uid() identity.
//
// Env: GM_E2E_SUPABASE_URL, GM_E2E_ANON_KEY, GM_E2E_SERVICE_KEY.
// Safety: loopback-only; anything else aborts (exit 2).
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.GM_E2E_SUPABASE_URL ?? '';
const ANON = process.env.GM_E2E_ANON_KEY ?? '';
const SERVICE = process.env.GM_E2E_SERVICE_KEY ?? '';

const loopback = (u) => { try { const h = new globalThis.URL(u).hostname; return h === '127.0.0.1' || h === 'localhost'; } catch { return false; } };
if (!loopback(SUPABASE_URL) || /supabase\.co$/i.test(SUPABASE_URL)) {
  console.error('REFUSAL: GM_E2E_SUPABASE_URL is not an isolated loopback stack; aborting.');
  process.exit(2);
}
if (!ANON || !SERVICE) { console.error('Missing GM_E2E_ANON_KEY / GM_E2E_SERVICE_KEY'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const errText = e => `${e?.message ?? e ?? ''} ${e?.code ?? ''}`;
const tag = `p18-${Date.now().toString(36)}`;
const email = n => `${tag}-${n}@example.test`;
const PASSWORD = `Fictional-${randomUUID().slice(0, 8)}-pw`;

const anonClient = () => createClient(SUPABASE_URL, ANON);
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function mustSingle(promise, what) {
  const r = await promise;
  if (r.error || !r.data) throw new Error(`fixture ${what}: ${errText(r.error) || 'no row returned'}`);
  return r.data;
}

const regArgs = (key, legal) => ({
  p_registration_key: key, p_legal_name: legal, p_profile_display_name: 'Fictional Founder',
  p_display_name: null, p_registration_number: null, p_billing_contact: null,
  p_contact_email: null, p_contact_phone: null, p_language: 'en',
});

async function main() {
  const ping = await anonClient().rpc('health_ping');
  check('stack health_ping answers ok', !ping.error && ping.data?.status === 'ok', errText(ping.error));

  // ---- fixtures: founder, stranger, suspended user, ops reader ----
  const mkUser = async (n) => {
    const r = await admin.auth.admin.createUser({ email: email(n), password: PASSWORD, email_confirm: true });
    if (r.error || !r.data.user) throw new Error(`fixture user ${n}: ${errText(r.error)}`);
    await mustSingle(admin.from('profiles').upsert(
      { id: r.data.user.id, display_name: `Fictional ${n}`, preferred_language: 'en', status: 'active' },
      { onConflict: 'id' }).select('id').single(), `profile ${n}`);
    return r.data.user.id;
  };
  const founderId = await mkUser('founder');
  const strangerId = await mkUser('stranger');
  const suspId = await mkUser('susp');
  const opsId = await mkUser('ops');
  await mustSingle(admin.from('role_assignments').insert(
    { user_id: opsId, organization_id: null, role: 'operations', status: 'active' }
  ).select('id').single(), 'ops role');
  const signIn = async (n) => {
    const c = anonClient();
    const r = await c.auth.signInWithPassword({ email: email(n), password: PASSWORD });
    if (r.error) throw new Error(`signin ${n}: ${r.error.message}`);
    return c;
  };
  const cFounder = await signIn('founder');
  const cStranger = await signIn('stranger');
  const cSusp = await signIn('susp');
  const cOps = await signIn('ops');
  check('fixtures ready (4 users, ops role)', !!(founderId && strangerId && suspId && opsId));

  const orgsByKey = async (key) =>
    (await admin.from('organizations').select('id,created_by,status').eq('registration_key', key)).data ?? [];
  const membersOf = async (orgId) =>
    (await admin.from('organization_memberships').select('id').eq('organization_id', orgId)).data ?? [];
  const eventsOf = async (orgId) =>
    (await cOps.from('approval_events').select('id,decision').eq('subject_type', 'organization').eq('subject_id', orgId)).data ?? [];

  // ---- A. valid creation is pending by default, identity = auth.uid() ----
  const keyA = randomUUID();
  const legalA = `Fictional Acme ${tag} LLC`;
  const first = await cFounder.rpc('register_company', regArgs(keyA, legalA));
  check('valid registration accepted (outcome created)', !first.error && first.data?.[0]?.outcome === 'created', errText(first.error));
  const orgIdA = first.data?.[0]?.id;
  check('new company starts pending', first.data?.[0]?.status === 'pending', JSON.stringify(first.data?.[0]));
  const rowA = orgIdA ? (await admin.from('organizations').select('id,created_by,status').eq('id', orgIdA).single()).data : null;
  check('created_by equals the caller auth.uid() (no client-supplied identity)', !!rowA && rowA.created_by === founderId, JSON.stringify(rowA));
  const mineA = await cFounder.rpc('my_company_memberships');
  check('founder sees the new company via my_company_memberships', !mineA.error && (mineA.data ?? []).some(m => m.organization_id === orgIdA), errText(mineA.error));
  check('exactly one company_admin membership provisioned', (await membersOf(orgIdA)).length === 1);
  const evA = await eventsOf(orgIdA);
  check('exactly one submitted audit event (ops-identity read)', evA.length === 1 && evA[0].decision === 'submitted', `got=${JSON.stringify(evA).slice(0, 160)}`);

  // ---- B. same-key replay is idempotent ----
  const replay = await cFounder.rpc('register_company', regArgs(keyA, legalA));
  check('same-key replay returns the same company (outcome replayed)', !replay.error && replay.data?.[0]?.id === orgIdA && replay.data?.[0]?.outcome === 'replayed', errText(replay.error));
  check('replay creates no duplicate company or membership', (await orgsByKey(keyA)).length === 1 && (await membersOf(orgIdA)).length === 1);
  check('replay writes no extra audit event', (await eventsOf(orgIdA)).length === 1);

  // ---- C. same key + changed payload is rejected, with no extra writes ----
  const mismatch = await cFounder.rpc('register_company', regArgs(keyA, `${legalA} DIFFERENT`));
  check('changed payload on the same key fails payload_mismatch', !!mismatch.error && /payload_mismatch/.test(errText(mismatch.error)), errText(mismatch.error));
  check('payload_mismatch leaves company, membership and audit counts unchanged',
    (await orgsByKey(keyA)).length === 1 && (await membersOf(orgIdA)).length === 1 && (await eventsOf(orgIdA)).length === 1);

  // ---- D. another user cannot replay the key ----
  const cross = await cStranger.rpc('register_company', regArgs(keyA, legalA));
  check('key belongs to another user is rejected', !!cross.error && /belongs to another user/.test(errText(cross.error)), errText(cross.error));
  const strangerMine = await cStranger.rpc('my_company_memberships');
  check('stranger gains no membership from the rejected replay', !strangerMine.error && !(strangerMine.data ?? []).some(m => m.organization_id === orgIdA), JSON.stringify(strangerMine.data)?.slice(0, 160));

  // ---- E. concurrency: same-key race creates exactly one company ----
  const keyE = randomUUID();
  const legalE = `Fictional Race ${tag} LLC`;
  const race = await Promise.all(Array.from({ length: 6 }, () => cFounder.rpc('register_company', regArgs(keyE, legalE))));
  const outcomes = race.map(r => r.data?.[0]?.outcome).sort();
  const raceErrors = race.filter(r => r.error);
  check('6-way same-key race yields 1 created + 5 replayed, no other errors',
    raceErrors.length === 0 && outcomes.join(',') === 'created,replayed,replayed,replayed,replayed,replayed',
    `outcomes=${outcomes.join(',')} errors=${raceErrors.map(r => errText(r.error)).join(';').slice(0, 200)}`);
  const orgsE = await orgsByKey(keyE);
  check('race creates exactly one company row', orgsE.length === 1, `count=${orgsE.length}`);
  check('race creates exactly one membership and one audit event',
    (await membersOf(orgsE[0]?.id)).length === 1 && (await eventsOf(orgsE[0]?.id)).length === 1);
  // Control: distinct keys under concurrency do not falsely conflict.
  const distinctKeys = Array.from({ length: 4 }, () => randomUUID());
  const distinct = await Promise.all(distinctKeys.map((k, i) => cFounder.rpc('register_company', regArgs(k, `Fictional Distinct ${tag}-${i} LLC`))));
  check('4-way distinct-key concurrency all succeed (no false conflicts)',
    distinct.every(r => !r.error && r.data?.[0]?.outcome === 'created'), distinct.map(r => errText(r.error)).join(';').slice(0, 200));

  // ---- F. suspended users are denied (first call AND replay) ----
  await mustSingle(admin.from('profiles').update({ status: 'suspended' }).eq('id', suspId).select('id').single(), 'suspend profile');
  const suspFirst = await cSusp.rpc('register_company', regArgs(randomUUID(), `Fictional Susp ${tag} LLC`));
  check('suspended account cannot register a company', !!suspFirst.error && /profile_suspended/.test(errText(suspFirst.error)), errText(suspFirst.error));
  // A suspended user replaying the founder's key must ALSO be denied (guard runs before replay).
  const suspReplay = await cSusp.rpc('register_company', regArgs(keyA, legalA));
  check('suspended account cannot replay either (guard precedes replay branch)', !!suspReplay.error && /profile_suspended|belongs to another user/.test(errText(suspReplay.error)), errText(suspReplay.error));
  const suspOrgs = (await admin.from('organizations').select('id').eq('created_by', suspId)).data ?? [];
  check('suspended attempts leave zero companies for that user', suspOrgs.length === 0, `count=${suspOrgs.length}`);
  // Recovery: re-activate and prove a fresh key succeeds (denial was policy, not corruption).
  await mustSingle(admin.from('profiles').update({ status: 'active' }).eq('id', suspId).select('id').single(), 'restore profile');
  const suspRecover = await cSusp.rpc('register_company', regArgs(randomUUID(), `Fictional Recovered ${tag} LLC`));
  check('restored account registers normally (denial was policy, not corruption)', !suspRecover.error && suspRecover.data?.[0]?.outcome === 'created', errText(suspRecover.error));

  // ---- G. rollback: failed validation writes nothing; retry works ----
  const keyG = randomUUID();
  const bad = await cFounder.rpc('register_company', regArgs(keyG, '   '));
  check('empty legal name is rejected', !!bad.error, 'empty legal name unexpectedly accepted');
  check('failed validation leaves zero companies for that key', (await orgsByKey(keyG)).length === 0);
  check('failed validation leaves zero audit events for that key',
    ((await cOps.from('approval_events').select('id').eq('subject_type', 'organization').eq('subject_id', keyG)).data ?? []).length === 0);
  const retryG = await cFounder.rpc('register_company', regArgs(randomUUID(), `Fictional Retry ${tag} LLC`));
  check('valid retry after a failure succeeds (no fake success, clean recovery)', !retryG.error && retryG.data?.[0]?.outcome === 'created', errText(retryG.error));

  // ---- H. client cannot supply its own identity ----
  const keyH = randomUUID();
  const forged = await cFounder.rpc('register_company', { ...regArgs(keyH, `Fictional Forge ${tag} LLC`), p_user_id: strangerId });
  const forgedOrgs = await orgsByKey(keyH);
  check('extra client-supplied identity parameter does not create a company for someone else',
    !!forged.error && forgedOrgs.length === 0, `err=${errText(forged.error)} rows=${forgedOrgs.length}`);
  const rowH = forgedOrgs[0];
  check('no forged created_by row exists', !rowH, JSON.stringify(rowH));

  console.log(`\nPHASE18-REGISTER-COMPANY: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(`FATAL: ${e?.stack ?? e}`); process.exit(1); });
