import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppConfig, type EnvSource } from './supabase';

/**
 * Company onboarding service (production mode only).
 *
 * WRITE PATH — exactly one: the existing `public.register_company` RPC
 * (migrations 20261026180000 / 20261026190000 / 20261026191000). It is a
 * SECURITY DEFINER function executable by `authenticated` only that derives the
 * caller from `auth.uid()`, forces `status = 'pending'`, provisions the
 * caller's profile if missing and their single `company_admin` membership, and
 * lets the audit trigger write the `submitted` event — all in one transaction.
 * This module never inserts/updates `organizations`, `organization_memberships`,
 * `role_assignments`, `approval_events` or `profiles`, never sends a user id,
 * role, status or approval field, and never uses a service-role key.
 *
 * READ PATH — `profiles` and `role_assignments` through the caller's own session
 * (RLS decides what is visible) and the caller-scoped read-only RPC
 * `my_company_memberships()` for the caller's own memberships and organisation status. The session's user id is used
 * only as a query filter (RLS remains the authority).
 *
 * IDEMPOTENCY — the RPC is keyed by a client-generated `p_registration_key`.
 * A retry with the same key and the same payload returns `outcome='replayed'`
 * for the already-created company (no duplicate); the same key with a different
 * payload is rejected as `payload_mismatch`. The UI therefore keeps ONE key per
 * registration attempt until the server confirms success (see
 * `loadRegistrationKey`), so an uncertain network failure can be retried safely.
 */

/* ------------------------------------------------------------------------ */
/* Input contract — mirrors the RPC's validation exactly (server is final).  */
/* ------------------------------------------------------------------------ */

export type RegistrationLanguage = 'en' | 'ar';

export interface CompanyRegistrationInput {
  /** organizations.legal_name — required. */
  readonly legalName: string;
  /** profiles.display_name for the registering person — required on every call by the RPC. */
  readonly profileDisplayName: string;
  /** organizations.display_name — optional. */
  readonly displayName: string;
  /** organizations.registration_number — optional free text. */
  readonly registrationNumber: string;
  /** organizations.billing_contact — optional free text (not an email address). */
  readonly billingContact: string;
  /** organizations.contact_email — optional. */
  readonly contactEmail: string;
  /** organizations.contact_phone — optional. */
  readonly contactPhone: string;
  /** profiles.preferred_language, used only when the RPC creates a missing profile. */
  readonly language: RegistrationLanguage;
}

export type RegistrationField = keyof CompanyRegistrationInput;
export type RegistrationFieldError = 'required' | 'too-long' | 'invalid-email' | 'invalid-phone' | 'invalid-language';

/** Provisional server-side caps (docs/atco-pending-business-rules.md P2); the RPC enforces them. */
export const REGISTRATION_LIMITS = {
  legalName: 200,
  profileDisplayName: 80,
  displayName: 200,
  registrationNumber: 64,
  billingContact: 200,
} as const;

/** Same patterns as the RPC (`!~` checks), applied to trimmed values. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_PATTERN = /^\+?[0-9 ()-]{7,20}$/;

/** PostgreSQL length() counts characters, not UTF-16 code units. */
const charLength = (value: string) => [...value].length;

/** Client-side mirror of the RPC validation; returns only the fields with problems. */
export function validateRegistrationInput(
  input: CompanyRegistrationInput,
): Partial<Record<RegistrationField, RegistrationFieldError>> {
  const errors: Partial<Record<RegistrationField, RegistrationFieldError>> = {};
  const legal = input.legalName.trim();
  const person = input.profileDisplayName.trim();
  if (!legal) errors.legalName = 'required';
  else if (charLength(legal) > REGISTRATION_LIMITS.legalName) errors.legalName = 'too-long';
  if (!person) errors.profileDisplayName = 'required';
  else if (charLength(person) > REGISTRATION_LIMITS.profileDisplayName) errors.profileDisplayName = 'too-long';
  for (const field of ['displayName', 'registrationNumber', 'billingContact'] as const) {
    if (charLength(input[field].trim()) > REGISTRATION_LIMITS[field]) errors[field] = 'too-long';
  }
  const email = input.contactEmail.trim();
  if (email && !EMAIL_PATTERN.test(email.toLowerCase())) errors.contactEmail = 'invalid-email';
  const phone = input.contactPhone.trim();
  if (phone && !PHONE_PATTERN.test(phone)) errors.contactPhone = 'invalid-phone';
  if (input.language !== 'en' && input.language !== 'ar') errors.language = 'invalid-language';
  return errors;
}

/** Arguments exactly as `register_company(uuid, text × 8)` declares them. Blank optional values are sent as null. */
export interface RegisterCompanyRpcArgs {
  readonly p_registration_key: string;
  readonly p_legal_name: string;
  readonly p_profile_display_name: string;
  readonly p_display_name: string | null;
  readonly p_registration_number: string | null;
  readonly p_billing_contact: string | null;
  readonly p_contact_email: string | null;
  readonly p_contact_phone: string | null;
  readonly p_language: RegistrationLanguage;
}

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export function buildRegisterCompanyArgs(input: CompanyRegistrationInput, registrationKey: string): RegisterCompanyRpcArgs {
  const email = blankToNull(input.contactEmail);
  return {
    p_registration_key: registrationKey,
    p_legal_name: input.legalName.trim(),
    p_profile_display_name: input.profileDisplayName.trim(),
    p_display_name: blankToNull(input.displayName),
    p_registration_number: blankToNull(input.registrationNumber),
    p_billing_contact: blankToNull(input.billingContact),
    p_contact_email: email === null ? null : email.toLowerCase(),
    p_contact_phone: blankToNull(input.contactPhone),
    p_language: input.language,
  };
}

/* ------------------------------------------------------------------------ */
/* Errors — fixed, non-sensitive messages; raw database text is never kept. */
/* ------------------------------------------------------------------------ */

export type CompanyServiceErrorKind =
  /** Demo mode or invalid production configuration: no Supabase client exists. */
  | 'unavailable'
  /** No session (signed out, or e-mail not yet confirmed) or the session expired. */
  | 'not-authenticated'
  /** The caller's profile is suspended (RPC guard). */
  | 'account-suspended'
  /** The RPC rejected an input (SQLSTATE 22023); `field` names it when recognisable. */
  | 'invalid-input'
  /** The registration key was already used with different details. */
  | 'payload-mismatch'
  /** The registration key belongs to another user (SQLSTATE 42501). */
  | 'key-conflict'
  /** A concurrent attempt with the same key lost the race (SQLSTATE 40001); retry is safe. */
  | 'retryable-conflict'
  /** The RPC is not installed on the configured project. */
  | 'not-deployed'
  /** No response (offline, timeout): the request MAY have been processed. */
  | 'network'
  /** HTTP 5xx: the request MAY have been processed. */
  | 'server'
  /** A response that does not match the RPC contract: treated as uncertain. */
  | 'unexpected-response'
  /** Anything else: treated as uncertain. */
  | 'unknown';

const UNCERTAIN_KINDS: ReadonlySet<CompanyServiceErrorKind> = new Set(['network', 'server', 'unexpected-response', 'unknown']);

export class CompanyServiceError extends Error {
  readonly kind: CompanyServiceErrorKind;
  readonly field: RegistrationField | null;
  /** True when the server may have committed the registration; retry with the SAME key. */
  readonly uncertain: boolean;

  constructor(kind: CompanyServiceErrorKind, field: RegistrationField | null = null) {
    super(`Company onboarding request failed (${kind}).`);
    this.name = 'CompanyServiceError';
    this.kind = kind;
    this.field = field;
    this.uncertain = UNCERTAIN_KINDS.has(kind);
  }
}

interface PostgrestLikeError {
  readonly message?: unknown;
  readonly code?: unknown;
}

/** RPC validation messages (migration 20261026191000) → the form field they concern. */
const INPUT_MESSAGE_FIELDS: ReadonlyArray<readonly [RegExp, RegistrationField | null]> = [
  [/^invalid profile display name/, 'profileDisplayName'],
  [/^invalid legal name/, 'legalName'],
  [/^invalid display name/, 'displayName'],
  [/^invalid registration number/, 'registrationNumber'],
  [/^invalid billing contact/, 'billingContact'],
  [/^invalid contact email/, 'contactEmail'],
  [/^invalid contact phone/, 'contactPhone'],
  [/^invalid language/, 'language'],
  [/^invalid registration key/, null],
];

/** Maps a PostgREST error + HTTP status to a typed error. Database text is inspected, never forwarded. */
export function classifyPostgrestError(error: PostgrestLikeError | null | undefined, status: number | null | undefined): CompanyServiceError {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === '28000') {
    return new CompanyServiceError(message.startsWith('profile_suspended') ? 'account-suspended' : 'not-authenticated');
  }
  if (code === '22023') {
    if (message.startsWith('payload_mismatch')) return new CompanyServiceError('payload-mismatch');
    const match = INPUT_MESSAGE_FIELDS.find(([pattern]) => pattern.test(message));
    return new CompanyServiceError('invalid-input', match ? match[1] : null);
  }
  if (code === '42501') return new CompanyServiceError('key-conflict');
  if (code === '40001') return new CompanyServiceError('retryable-conflict');
  if (code === 'PGRST202') return new CompanyServiceError('not-deployed');
  if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303' || status === 401) {
    return new CompanyServiceError('not-authenticated');
  }
  if (status === 0 || status === null || status === undefined) return new CompanyServiceError('network');
  if (status >= 500) return new CompanyServiceError('server');
  if (status === 404) return new CompanyServiceError('not-deployed');
  return new CompanyServiceError('unknown');
}

/** Read-query failures: only "no response", "not signed in" and "not deployed" are distinguished. */
function classifyReadError(error: PostgrestLikeError | null | undefined, status: number | null | undefined): CompanyServiceError {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303' || status === 401) return new CompanyServiceError('not-authenticated');
  if (code === 'PGRST205' || code === '42P01') return new CompanyServiceError('not-deployed');
  if (status === 0 || status === null || status === undefined) return new CompanyServiceError('network');
  if (status >= 500) return new CompanyServiceError('server');
  return new CompanyServiceError('unknown');
}

/* ------------------------------------------------------------------------ */
/* Client + session                                                         */
/* ------------------------------------------------------------------------ */

function requireClient(env?: EnvSource): SupabaseClient {
  const config = getAppConfig(env);
  if (config.mode === 'demo' || 'error' in config) throw new CompanyServiceError('unavailable');
  return config.supabase;
}

/** The signed-in user's id from the SDK session. Without a session nothing protected is called. */
async function requireSessionUserId(client: SupabaseClient): Promise<string> {
  let result: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>;
  try {
    result = await client.auth.getSession();
  } catch {
    throw new CompanyServiceError('network');
  }
  const userId = result.data?.session?.user?.id;
  if (result.error || typeof userId !== 'string' || !userId) throw new CompanyServiceError('not-authenticated');
  return userId;
}

/* ------------------------------------------------------------------------ */
/* Registration                                                             */
/* ------------------------------------------------------------------------ */

export interface CompanyRegistrationResult {
  readonly organizationId: string;
  readonly legalName: string;
  /** Server-reported organisation status — 'pending' for a new registration. */
  readonly status: string;
  /** 'created' for the winning insert, 'replayed' when this key had already been accepted. */
  readonly outcome: 'created' | 'replayed';
}

function parseRegistrationResponse(data: unknown): CompanyRegistrationResult {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  if (row === null || typeof row !== 'object') throw new CompanyServiceError('unexpected-response');
  const { id, legal_name: legalName, status, outcome } = row as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof legalName !== 'string' || typeof status !== 'string'
    || (outcome !== 'created' && outcome !== 'replayed')) {
    throw new CompanyServiceError('unexpected-response');
  }
  return { organizationId: id, legalName, status, outcome };
}

/**
 * Submits the registration through `register_company`. Throws CompanyServiceError;
 * `error.uncertain` tells the caller to retry with the SAME `registrationKey`.
 */
export async function registerCompany(
  input: CompanyRegistrationInput,
  registrationKey: string,
  env?: EnvSource,
): Promise<CompanyRegistrationResult> {
  const client = requireClient(env);
  const invalid = Object.keys(validateRegistrationInput(input)) as RegistrationField[];
  if (invalid.length > 0) throw new CompanyServiceError('invalid-input', invalid[0]);
  if (!UUID_PATTERN.test(registrationKey)) throw new CompanyServiceError('invalid-input', null);
  await requireSessionUserId(client); // never call the protected RPC anonymously

  let response: { data: unknown; error: PostgrestLikeError | null; status?: number };
  try {
    response = await client.rpc('register_company', buildRegisterCompanyArgs(input, registrationKey));
  } catch {
    throw new CompanyServiceError('network');
  }
  if (response.error) throw classifyPostgrestError(response.error, response.status);
  return parseRegistrationResponse(response.data);
}

/* ------------------------------------------------------------------------ */
/* Onboarding status (read-only, RLS-filtered)                              */
/* ------------------------------------------------------------------------ */

export type OrganizationStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface MembershipSnapshot {
  readonly organizationId: string;
  readonly membershipRole: string;
  readonly membershipStatus: string;
  /**
   * The member's own organisation as returned by my_company_memberships() (name and
   * status only — never the rejection reason). Null only if the row was malformed.
   */
  readonly organization: { readonly id: string; readonly legalName: string; readonly displayName: string | null; readonly status: OrganizationStatus } | null;
}

export interface OnboardingSnapshot {
  readonly profile: { readonly status: string } | null;
  readonly memberships: readonly MembershipSnapshot[];
  /** Active platform-wide (ATCO staff) roles of the caller. */
  readonly platformRoles: readonly string[];
}

const ORG_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'rejected', 'suspended']);

function parseOrganization(raw: unknown): MembershipSnapshot['organization'] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.legal_name !== 'string' || typeof o.status !== 'string' || !ORG_STATUSES.has(o.status)) return null;
  return {
    id: o.id,
    legalName: o.legal_name,
    displayName: typeof o.display_name === 'string' ? o.display_name : null,
    status: o.status as OrganizationStatus,
  };
}

export async function fetchOnboardingSnapshot(env?: EnvSource): Promise<OnboardingSnapshot> {
  const client = requireClient(env);
  const userId = await requireSessionUserId(client);
  try {
    const [profile, memberships, roles] = await Promise.all([
      client.from('profiles').select('status').eq('id', userId).maybeSingle(),
      // Caller-scoped RPC (migration 20261027120000): own memberships WITH organisation status,
      // including rejected/suspended companies that the table policies hide from members.
      client.rpc('my_company_memberships'),
      client.from('role_assignments').select('role, status').eq('user_id', userId).is('organization_id', null),
    ]);
    for (const result of [profile, memberships, roles]) {
      if (result.error) throw classifyReadError(result.error, result.status);
    }
    const profileRow = profile.data as { status?: unknown } | null;
    const membershipRows = Array.isArray(memberships.data) ? memberships.data as Record<string, unknown>[] : [];
    const roleRows = Array.isArray(roles.data) ? roles.data as Record<string, unknown>[] : [];
    return {
      profile: profileRow && typeof profileRow.status === 'string' ? { status: profileRow.status } : null,
      memberships: membershipRows
        .filter(row => typeof row.organization_id === 'string')
        .map(row => ({
          organizationId: row.organization_id as string,
          membershipRole: String(row.membership_role ?? ''),
          membershipStatus: String(row.membership_status ?? ''),
          organization: parseOrganization({
            id: row.organization_id, legal_name: row.legal_name, display_name: row.display_name, status: row.organization_status,
          }),
        })),
      platformRoles: roleRows
        .filter(row => row.status === 'active' && typeof row.role === 'string')
        .map(row => row.role as string),
    };
  } catch (error) {
    if (error instanceof CompanyServiceError) throw error;
    throw new CompanyServiceError('network');
  }
}

export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly status: OrganizationStatus;
  readonly membershipRole: string;
}

/** Approved organisations in which the user is an active admin/booker: the only ones that may book. */
export function bookableOrganizations(snapshot: OnboardingSnapshot): OrganizationSummary[] {
  return snapshot.memberships
    .filter(m => m.membershipStatus === 'active' && m.organization?.status === 'approved'
      && (m.membershipRole === 'company_admin' || m.membershipRole === 'company_booker'))
    .map(m => ({ id: m.organizationId, name: m.organization!.displayName || m.organization!.legalName, status: 'approved', membershipRole: m.membershipRole }));
}

export type OnboardingState =
  /** Profile suspended by ATCO: no registration possible (RPC guard P4). */
  | { readonly kind: 'account-suspended' }
  /** At least one approved company with an active membership. */
  | { readonly kind: 'approved'; readonly organizations: readonly OrganizationSummary[] }
  /** Registered and awaiting ATCO review. */
  | { readonly kind: 'pending'; readonly organizations: readonly OrganizationSummary[] }
  /** Membership invitation not yet active (no acceptance flow exists yet). */
  | { readonly kind: 'invited' }
  /** ATCO rejected the registration (the reason is not shown to members — pending ATCO decision). */
  | { readonly kind: 'rejected'; readonly organizations: readonly OrganizationSummary[] }
  /** ATCO suspended the company. */
  | { readonly kind: 'suspended'; readonly organizations: readonly OrganizationSummary[] }
  /** The membership itself is suspended (or otherwise not active). */
  | { readonly kind: 'restricted' }
  /** ATCO platform staff account without a company membership. */
  | { readonly kind: 'platform-staff'; readonly roles: readonly string[] }
  /** Authenticated, no company yet: registration is the next step. */
  | { readonly kind: 'no-company' };

/** Pure derivation of the onboarding state from what RLS let the user read. */
export function deriveOnboardingState(snapshot: OnboardingSnapshot): OnboardingState {
  if (snapshot.profile?.status === 'suspended') return { kind: 'account-suspended' };
  const summaries = (status: OrganizationStatus): OrganizationSummary[] => snapshot.memberships
    .filter(m => m.membershipStatus === 'active' && m.organization?.status === status)
    .map(m => ({
      id: m.organizationId,
      name: m.organization!.displayName || m.organization!.legalName,
      status,
      membershipRole: m.membershipRole,
    }));
  const approved = summaries('approved');
  if (approved.length > 0) return { kind: 'approved', organizations: approved };
  const pending = summaries('pending');
  if (pending.length > 0) return { kind: 'pending', organizations: pending };
  if (snapshot.memberships.some(m => m.membershipStatus === 'invited')) return { kind: 'invited' };
  const rejected = summaries('rejected');
  if (rejected.length > 0) return { kind: 'rejected', organizations: rejected };
  const suspended = summaries('suspended');
  if (suspended.length > 0) return { kind: 'suspended', organizations: suspended };
  if (snapshot.memberships.length > 0) return { kind: 'restricted' };
  if (snapshot.platformRoles.length > 0) return { kind: 'platform-staff', roles: snapshot.platformRoles };
  return { kind: 'no-company' };
}

/* ------------------------------------------------------------------------ */
/* Registration-attempt key (idempotency)                                   */
/* ------------------------------------------------------------------------ */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_STORAGE_PREFIX = 'gm-registration-attempt:';

export function newRegistrationKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The open attempt's key for this user, kept in sessionStorage (this tab only) so a reload
 * after an uncertain failure still retries with the same key. It holds a random UUID only —
 * no company details and no credentials.
 */
export function loadRegistrationKey(userId: string): string | null {
  try {
    const value = sessionStorage.getItem(KEY_STORAGE_PREFIX + userId);
    return value && UUID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveRegistrationKey(userId: string, key: string): void {
  try { sessionStorage.setItem(KEY_STORAGE_PREFIX + userId, key); } catch { /* storage unavailable: in-memory key only */ }
}

export function clearRegistrationKey(userId: string): void {
  try { sessionStorage.removeItem(KEY_STORAGE_PREFIX + userId); } catch { /* storage unavailable */ }
}
