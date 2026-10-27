import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fake, fakeClient } from './helpers/fakeSupabase';
import {
  CompanyServiceError, buildRegisterCompanyArgs, classifyPostgrestError, clearRegistrationKey,
  deriveOnboardingState, fetchOnboardingSnapshot, loadRegistrationKey, newRegistrationKey, registerCompany,
  saveRegistrationKey, validateRegistrationInput, type CompanyRegistrationInput, type OnboardingSnapshot,
} from '../lib/companyService';

/**
 * Company-registration service tests. `@supabase/supabase-js` is replaced by the in-memory
 * fake, so no request ever leaves the process; the real configuration/mode logic in
 * `src/lib/supabase.ts` runs unmocked with an injected environment.
 */
vi.mock('@supabase/supabase-js', async () => (await import('./helpers/fakeSupabase')).fakeSupabaseModule);

const PROD_ENV = {
  VITE_APP_MODE: 'production',
  VITE_SUPABASE_URL: 'https://company-service.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'company-service-publishable-key',
};
const DEMO_ENV = { VITE_APP_MODE: 'demo' };
const KEY = '3f1c2b8e-1d2a-4c5b-9e8f-0a1b2c3d4e5f';

const valid: CompanyRegistrationInput = {
  legalName: '  Gulf Test Logistics LLC ',
  profileDisplayName: ' Sara Test ',
  displayName: '',
  registrationNumber: '  ',
  billingContact: 'Accounts team',
  contactEmail: ' Ops@Example.TEST ',
  contactPhone: '+966 13 000 0000',
  language: 'ar',
};

const rpcOk = (outcome: 'created' | 'replayed', status = 'pending') =>
  ({ data: [{ id: 'org-1', legal_name: 'Gulf Test Logistics LLC', status, outcome }], error: null, status: 200 });

beforeEach(() => {
  fake.reset();
  sessionStorage.clear();
});

describe('input contract (mirrors register_company validation)', () => {
  it('accepts a valid registration', () => {
    expect(validateRegistrationInput(valid)).toEqual({});
  });

  it('requires the legal name and the registering person\'s name', () => {
    expect(validateRegistrationInput({ ...valid, legalName: '   ', profileDisplayName: '' }))
      .toEqual({ legalName: 'required', profileDisplayName: 'required' });
  });

  it('enforces the provisional length caps by characters, like PostgreSQL length()', () => {
    expect(validateRegistrationInput({ ...valid, legalName: 'a'.repeat(200) })).toEqual({});
    expect(validateRegistrationInput({ ...valid, legalName: 'a'.repeat(201) })).toEqual({ legalName: 'too-long' });
    // 80 astral characters are 160 UTF-16 units but 80 characters: allowed.
    expect(validateRegistrationInput({ ...valid, profileDisplayName: '🚢'.repeat(80) })).toEqual({});
    expect(validateRegistrationInput({ ...valid, registrationNumber: 'R'.repeat(65), billingContact: 'b'.repeat(201), displayName: 'd'.repeat(201) }))
      .toEqual({ registrationNumber: 'too-long', billingContact: 'too-long', displayName: 'too-long' });
  });

  it('rejects malformed e-mail, phone and language values', () => {
    expect(validateRegistrationInput({ ...valid, contactEmail: 'not-an-email', contactPhone: '12', language: 'fr' as 'en' }))
      .toEqual({ contactEmail: 'invalid-email', contactPhone: 'invalid-phone', language: 'invalid-language' });
  });

  it('builds exactly the nine RPC arguments: trimmed, blanks as null, e-mail lowercased, no identity fields', () => {
    const args = buildRegisterCompanyArgs(valid, KEY);
    expect(args).toEqual({
      p_registration_key: KEY,
      p_legal_name: 'Gulf Test Logistics LLC',
      p_profile_display_name: 'Sara Test',
      p_display_name: null,
      p_registration_number: null,
      p_billing_contact: 'Accounts team',
      p_contact_email: 'ops@example.test',
      p_contact_phone: '+966 13 000 0000',
      p_language: 'ar',
    });
    for (const forbidden of ['user_id', 'p_user_id', 'status', 'p_status', 'role', 'approved', 'created_by']) {
      expect(Object.keys(args)).not.toContain(forbidden);
    }
  });
});

describe('registerCompany', () => {
  it('calls only the register_company RPC with the authenticated session, and returns the server result', async () => {
    fake.rpc.mockResolvedValueOnce(rpcOk('created'));
    const result = await registerCompany(valid, KEY, PROD_ENV);
    expect(result).toEqual({ organizationId: 'org-1', legalName: 'Gulf Test Logistics LLC', status: 'pending', outcome: 'created' });
    expect(fakeClient.auth.getSession).toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.rpc).toHaveBeenCalledWith('register_company', buildRegisterCompanyArgs(valid, KEY));
    expect(fakeClient.from).not.toHaveBeenCalled(); // no direct table access at all
    expect(fake.writeAttempts).toEqual([]);
  });

  it('reports a replay of the same key as "replayed" (no duplicate is created by the server)', async () => {
    fake.rpc.mockResolvedValueOnce(rpcOk('replayed'));
    await expect(registerCompany(valid, KEY, PROD_ENV)).resolves.toMatchObject({ outcome: 'replayed', organizationId: 'org-1' });
  });

  it('never calls the protected RPC without a session (signed out or unconfirmed e-mail)', async () => {
    fake.session = null;
    await expect(registerCompany(valid, KEY, PROD_ENV)).rejects.toMatchObject({ kind: 'not-authenticated', uncertain: false });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('is unavailable in demo mode and with a broken production configuration — no client, no call', async () => {
    await expect(registerCompany(valid, KEY, DEMO_ENV)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(registerCompany(valid, KEY, { ...PROD_ENV, VITE_SUPABASE_URL: '' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('rejects locally invalid input and malformed keys before any network call', async () => {
    await expect(registerCompany({ ...valid, legalName: '' }, KEY, PROD_ENV)).rejects.toMatchObject({ kind: 'invalid-input', field: 'legalName' });
    await expect(registerCompany(valid, 'not-a-uuid', PROD_ENV)).rejects.toMatchObject({ kind: 'invalid-input', field: null });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: '22023', message: 'invalid legal name (required, <= 200 chars)' }, 400, 'invalid-input', 'legalName', false],
    [{ code: '22023', message: 'invalid contact phone' }, 400, 'invalid-input', 'contactPhone', false],
    [{ code: '22023', message: 'payload_mismatch: payload differs from the original registration for this key' }, 400, 'payload-mismatch', null, false],
    [{ code: '28000', message: 'profile_suspended: suspended accounts may not register a company' }, 400, 'account-suspended', null, false],
    [{ code: '28000', message: 'not authenticated' }, 400, 'not-authenticated', null, false],
    [{ code: '42501', message: 'registration key belongs to another user' }, 403, 'key-conflict', null, false],
    [{ code: '40001', message: 'registration attempt lost during conflict — retry' }, 409, 'retryable-conflict', null, false],
    [{ code: 'PGRST202', message: 'Could not find the function' }, 404, 'not-deployed', null, false],
    [{ code: 'PGRST303', message: 'JWT expired' }, 401, 'not-authenticated', null, false],
    [{ code: '', message: 'TypeError: Failed to fetch' }, 0, 'network', null, true],
    [{ code: '', message: 'upstream timeout' }, 504, 'server', null, true],
    [{ code: 'XX000', message: 'something odd' }, 418, 'unknown', null, true],
  ])('maps %j (HTTP %i) to %s', async (error, status, kind, field, uncertain) => {
    fake.rpc.mockResolvedValueOnce({ data: null, error, status });
    const failure = await registerCompany(valid, KEY, PROD_ENV).catch(e => e);
    expect(failure).toBeInstanceOf(CompanyServiceError);
    expect(failure).toMatchObject({ kind, field, uncertain });
    // Database text never reaches the UI-facing message.
    expect(failure.message).not.toContain(error.message);
  });

  it('treats a thrown transport error and a malformed response as uncertain', async () => {
    fake.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(registerCompany(valid, KEY, PROD_ENV)).rejects.toMatchObject({ kind: 'network', uncertain: true });
    fake.rpc.mockResolvedValueOnce({ data: [{ id: 'org-1', status: 'pending', outcome: 'approved' }], error: null, status: 200 });
    await expect(registerCompany(valid, KEY, PROD_ENV)).rejects.toMatchObject({ kind: 'unexpected-response', uncertain: true });
    fake.rpc.mockResolvedValueOnce({ data: [], error: null, status: 200 });
    await expect(registerCompany(valid, KEY, PROD_ENV)).rejects.toMatchObject({ kind: 'unexpected-response' });
  });

  it('classifies errors without forwarding database detail', () => {
    const err = classifyPostgrestError({ code: '22023', message: 'invalid contact email' }, 400);
    expect(err.message).toBe('Company onboarding request failed (invalid-input).');
  });
});

describe('fetchOnboardingSnapshot (read-only, RLS-filtered)', () => {
  it('reads profile, memberships with embedded organisation and platform roles, filtered to the session user', async () => {
    fake.tables.profiles = { data: { status: 'active' }, error: null, status: 200 };
    fake.setMemberships([{ orgId: 'org-1', org: { legalName: 'Gulf Test Logistics LLC', status: 'pending' } }]);
    const snapshot = await fetchOnboardingSnapshot(PROD_ENV);
    expect(snapshot).toEqual({
      profile: { status: 'active' },
      memberships: [{
        organizationId: 'org-1', membershipRole: 'company_admin', membershipStatus: 'active',
        organization: { id: 'org-1', legalName: 'Gulf Test Logistics LLC', displayName: null, status: 'pending' },
      }],
      platformRoles: [],
    });
    const byTable = Object.fromEntries(fake.queries.map(q => [q.table, q]));
    expect(byTable.profiles.filters).toEqual([['eq', 'id', 'auth-user-1']]);
    expect(byTable.organization_memberships.filters).toEqual([['eq', 'user_id', 'auth-user-1']]);
    expect(byTable.organization_memberships.select).toContain('organizations(');
    expect(byTable.role_assignments.filters).toEqual([['eq', 'user_id', 'auth-user-1'], ['is', 'organization_id', null]]);
    expect(fake.writeAttempts).toEqual([]);
  });

  it('requires a session and reports query failures as typed errors', async () => {
    fake.session = null;
    await expect(fetchOnboardingSnapshot(PROD_ENV)).rejects.toMatchObject({ kind: 'not-authenticated' });
    expect(fakeClient.from).not.toHaveBeenCalled();
    fake.session = { user: { id: 'auth-user-1' } };
    fake.tables.organization_memberships = { data: null, error: { message: 'Failed to fetch', code: '' }, status: 0 };
    await expect(fetchOnboardingSnapshot(PROD_ENV)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('deriveOnboardingState', () => {
  const base: OnboardingSnapshot = { profile: { status: 'active' }, memberships: [], platformRoles: [] };
  const member = (status: string, org: null | 'pending' | 'approved') => ({
    organizationId: `org-${status}-${org}`, membershipRole: 'company_admin', membershipStatus: status,
    organization: org === null ? null : { id: `org-${status}-${org}`, legalName: `Co ${org}`, displayName: null, status: org },
  });

  it('distinguishes every supported state', () => {
    expect(deriveOnboardingState(base)).toEqual({ kind: 'no-company' });
    expect(deriveOnboardingState({ ...base, profile: null })).toEqual({ kind: 'no-company' }); // profile is provisioned by the RPC
    expect(deriveOnboardingState({ ...base, memberships: [member('active', 'pending')] }).kind).toBe('pending');
    expect(deriveOnboardingState({ ...base, memberships: [member('active', 'approved')] }).kind).toBe('approved');
    expect(deriveOnboardingState({ ...base, memberships: [member('invited', null)] }).kind).toBe('invited');
    expect(deriveOnboardingState({ ...base, memberships: [member('active', null)] }).kind).toBe('restricted');
    expect(deriveOnboardingState({ ...base, memberships: [member('suspended', null)] }).kind).toBe('restricted');
    expect(deriveOnboardingState({ ...base, platformRoles: ['operations'] })).toEqual({ kind: 'platform-staff', roles: ['operations'] });
    expect(deriveOnboardingState({ ...base, profile: { status: 'suspended' }, memberships: [member('active', 'approved')] }))
      .toEqual({ kind: 'account-suspended' });
  });

  it('prefers an approved company over a pending one and never reports approval without it', () => {
    const state = deriveOnboardingState({ ...base, memberships: [member('active', 'pending'), member('active', 'approved')] });
    expect(state.kind).toBe('approved');
    const pendingOnly = deriveOnboardingState({ ...base, memberships: [member('active', 'pending')] });
    expect(pendingOnly).toEqual({ kind: 'pending', organizations: [{ id: 'org-active-pending', name: 'Co pending', status: 'pending', membershipRole: 'company_admin' }] });
  });
});

describe('registration-attempt key', () => {
  it('generates RFC 4122 v4 keys and keeps one per user in sessionStorage', () => {
    const key = newRegistrationKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newRegistrationKey()).not.toBe(key);
    saveRegistrationKey('user-a', key);
    expect(loadRegistrationKey('user-a')).toBe(key);
    expect(loadRegistrationKey('user-b')).toBeNull();
    clearRegistrationKey('user-a');
    expect(loadRegistrationKey('user-a')).toBeNull();
  });

  it('ignores a tampered stored value', () => {
    sessionStorage.setItem('gm-registration-attempt:user-a', 'drop table');
    expect(loadRegistrationKey('user-a')).toBeNull();
  });
});
