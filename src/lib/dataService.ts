import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppConfig, type EnvSource } from './supabase';
import { reportRequestFailure } from './monitoring';

/**
 * Shared plumbing for the Phase 3 production data services (company review, operations,
 * bookings): one client source, one session check and ONE typed error vocabulary.
 *
 * Errors are classified from the PostgreSQL SQLSTATE PostgREST forwards (`code`), the fixed
 * message prefixes our RPCs raise (e.g. `sailing_full:`), and the HTTP status. Database text
 * is inspected only — never put into the error message, so it never reaches the UI.
 */

export type DataErrorKind =
  | 'unavailable'               // demo mode or invalid production configuration
  | 'not-authenticated'         // no / expired session
  | 'forbidden'                 // RLS/privilege/role refusal
  | 'account-suspended'
  | 'conflict-of-interest'      // reviewer belongs to / created the organisation
  | 'reviewer-profile-missing'  // staff account not fully provisioned
  | 'organization-not-approved'
  | 'not-a-member'
  | 'invalid-input'
  | 'invalid-transition'        // status change not allowed from the current state
  | 'not-found'
  | 'payload-mismatch'          // request key reused with different details
  | 'sailing-full'
  | 'sailing-unavailable'
  | 'duplicate'                 // unique constraint (e.g. vessel name already exists)
  | 'not-deployed'              // migration not applied on this project
  | 'network'                   // no response — the request MAY have been processed
  | 'server'                    // 5xx — MAY have been processed
  | 'unexpected-response'
  | 'unknown'
  // Phase 8 business rules (stable message prefixes raised by the database)
  | 'payment-in-progress'
  | 'hold-expired'
  | 'change-window-closed'
  | 'credit-unavailable'
  | 'credit-limit'
  | 'four-eyes'
  | 'policy-not-approved'
  | 'terms-not-accepted'
  | 'payments-disabled'
  | 'safety-review-required'
  | 'vessel-conflict'
  | 'payload-exceeded'
  | 'no-tariff'
  // Abuse limits (SQLSTATE 54000): expected outcomes, not errors
  | 'rate-limited'
  | 'too-many-holds';

const UNCERTAIN: ReadonlySet<DataErrorKind> = new Set(['network', 'server', 'unexpected-response', 'unknown']);
/** Failures that indicate a bug or outage (reported to error tracking), not a user mistake. */
const REPORTED_KINDS: ReadonlySet<DataErrorKind> = new Set(['server', 'unexpected-response', 'not-deployed', 'unknown']);

export class DataServiceError extends Error {
  readonly kind: DataErrorKind;
  /** True when the server may have committed the write: retry with the SAME request key. */
  readonly uncertain: boolean;

  constructor(kind: DataErrorKind) {
    super(`Request failed (${kind}).`);
    this.name = 'DataServiceError';
    this.kind = kind;
    this.uncertain = UNCERTAIN.has(kind);
  }
}

interface PostgrestLikeError { readonly message?: unknown; readonly code?: unknown }

const PREFIXES: ReadonlyArray<readonly [string, DataErrorKind]> = [
  ['payload_mismatch', 'payload-mismatch'],
  ['sailing_full', 'sailing-full'],
  ['sailing_unavailable', 'sailing-unavailable'],
  ['organization_not_approved', 'organization-not-approved'],
  ['not_a_member', 'not-a-member'],
  ['conflict_of_interest', 'conflict-of-interest'],
  ['reviewer_profile_missing', 'reviewer-profile-missing'],
  ['profile_suspended', 'account-suspended'],
  ['invalid_transition', 'invalid-transition'],
  ['sailing_has_bookings', 'invalid-transition'],
  ['payment_in_progress', 'payment-in-progress'],
  ['hold_expired', 'hold-expired'],
  ['change_window_closed', 'change-window-closed'],
  ['credit_not_available', 'credit-unavailable'],
  ['credit_on_hold', 'credit-unavailable'],
  ['credit_limit_exceeded', 'credit-limit'],
  ['four_eyes_required', 'four-eyes'],
  ['refund_policy_not_approved', 'policy-not-approved'],
  ['tariff_not_approved', 'policy-not-approved'],
  ['terms_not_accepted', 'terms-not-accepted'],
  ['payments_not_enabled', 'payments-disabled'],
  ['sandbox_disabled', 'payments-disabled'],
  ['safety_review_required', 'safety-review-required'],
  ['permit_reference_required', 'safety-review-required'],
  ['vessel_conflict', 'vessel-conflict'],
  ['payload_exceeded', 'payload-exceeded'],
  ['payload_capacity_unknown', 'payload-exceeded'],
  ['no active tariff', 'no-tariff'],
  ['no_matching_tariff', 'no-tariff'],
  ['rate_limited', 'rate-limited'],
  ['too_many_unpaid_holds', 'too-many-holds'],
];

export function classifyDataError(error: PostgrestLikeError | null | undefined, status: number | null | undefined): DataServiceError {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  const prefixed = PREFIXES.find(([prefix]) => message.startsWith(prefix));
  if (prefixed) return new DataServiceError(prefixed[1]);
  switch (code) {
    case '28000': return new DataServiceError('not-authenticated');
    case '42501': return new DataServiceError('forbidden');
    case '22023': case '23514': case '22P02': case '23502': return new DataServiceError('invalid-input');
    case '23505': return new DataServiceError('duplicate');
    case '23503': return new DataServiceError('invalid-input');
    case '55000': return new DataServiceError('invalid-transition');
    case 'P0002': case 'PGRST116': return new DataServiceError('not-found');
    case 'PGRST202': case 'PGRST205': case '42P01': case '42883': return new DataServiceError('not-deployed');
    case 'PGRST301': case 'PGRST302': case 'PGRST303': return new DataServiceError('not-authenticated');
    default: break;
  }
  if (status === 401) return new DataServiceError('not-authenticated');
  if (status === 403) return new DataServiceError('forbidden');
  if (status === 0 || status === null || status === undefined) return new DataServiceError('network');
  if (status >= 500) return new DataServiceError('server');
  return new DataServiceError('unknown');
}

export function requireDataClient(env?: EnvSource): SupabaseClient {
  const config = getAppConfig(env);
  if (config.mode === 'demo' || 'error' in config) throw new DataServiceError('unavailable');
  return config.supabase;
}

/** The session user's id. Without a session nothing protected is requested. */
export async function requireSessionUser(client: SupabaseClient): Promise<string> {
  let result: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>;
  try {
    result = await client.auth.getSession();
  } catch {
    throw new DataServiceError('network');
  }
  const id = result.data?.session?.user?.id;
  if (result.error || typeof id !== 'string' || !id) throw new DataServiceError('not-authenticated');
  return id;
}

/** Runs a PostgREST request, mapping transport exceptions and error payloads to DataServiceError. */
export async function run<T>(request: PromiseLike<{ data: T | null; error: PostgrestLikeError | null; status?: number; count?: number | null }>):
  Promise<{ data: T | null; count: number | null }> {
  let response: { data: T | null; error: PostgrestLikeError | null; status?: number; count?: number | null };
  try {
    response = await request;
  } catch {
    throw new DataServiceError('network');
  }
  if (response.error) {
    const failure = classifyDataError(response.error, response.status);
    // Server-side failures are tracked; expected outcomes (validation, permission, sold out) are not.
    if (REPORTED_KINDS.has(failure.kind)) {
      reportRequestFailure(failure.kind, response.status, typeof response.error.code === 'string' ? response.error.code : '');
    }
    throw failure;
  }
  return { data: response.data, count: response.count ?? null };
}

/** Escapes LIKE wildcards in user search text (PostgREST `ilike` uses SQL LIKE semantics). */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
}

/** UUID v4 request keys for idempotent writes. */
export function newRequestKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
