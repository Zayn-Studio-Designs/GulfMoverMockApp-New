import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { getAppConfig, type EnvSource, type SupabaseConfigIssue } from './supabase';

/**
 * Supabase Auth service foundation — CHECKPOINT 1.
 *
 * NOT yet wired into the application: `AuthContext`, `AuthView`,
 * `SettingsView`, route guards and all demo flows are untouched. This module
 * only wraps Supabase Auth in typed, credential-free operations so the next
 * checkpoint can swap the provider behind the UI.
 *
 * Client lifecycle: every operation obtains the application's single memoized
 * Supabase client through `getAppConfig` in `src/lib/supabase.ts`, which
 * caches one client per validated configuration. No second client is created
 * here and no network request is made during configuration resolution —
 * only the individual auth operation below contacts the Supabase Auth API.
 *
 * Demo isolation: demo mode (no `VITE_APP_MODE=production`) throws
 * `AuthNotAvailableError` with reason `demo-mode`; an explicitly selected but
 * invalid production configuration throws it with reason `config-error` and
 * never falls back to the demo. No demo account, session or `gm-demo-*`
 * localStorage key is read, written or deleted by this module.
 *
 * Storage keys cannot collide: the shared client uses the Supabase SDK's
 * URL-derived default auth storage key `sb-<first-hostname-label>-auth-token`
 * (supabase-js 2.118, `SupabaseClient` constructor), while every demo key is
 * prefixed `gm-demo-`. Supabase sessions and demo data never share storage.
 *
 * Error handling (documented contract, requirement 8):
 * - `AuthNotAvailableError` — authentication is not usable at all:
 *   `reason: 'demo-mode'` (demo selected, Supabase Auth deliberately unused)
 *   or `reason: 'config-error'` (production selected with missing/invalid
 *   configuration; `issues` lists the machine-readable `SupabaseConfigIssue`s).
 *   Messages carry variable names and rules only, never the configured values.
 * - `AuthOperationError` — Supabase itself reported an error. `message` is
 *   the SERVER-provided text (it never contains the submitted password);
 *   `code`/`status` are the server's machine-readable code and HTTP status
 *   when supplied (e.g. `code: 'invalid_credentials'`, `status: 400`).
 *   Callers may match on `code` for localized English/Arabic messages; raw
 *   messages are a fallback, not the primary UI surface.
 * - `AuthInputError` — locally detected caller mistakes (blank email,
 *   blank password, malformed redirect URL) before anything is sent to the
 *   network; messages contain no credential values.
 *
 * Password-reset redirect (documented contract, requirement 8): the caller
 * MUST supply an explicit absolute http(s) `redirectTo` URL; it is forwarded
 * verbatim to `resetPasswordForEmail`. Supabase only redirects to URLs on the
 * project's allow-list (Auth → URL Configuration), so the value must be
 * registered in the dashboard — for the eventual ATCO handover these entries
 * (e.g. `https://<app-origin>/auth/reset-callback`) must be reconfigured
 * against the production origin. Relative paths and non-http(s) URLs are
 * rejected locally.
 */

export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  /** Stored as Supabase Auth user metadata `display_name` (matches the
   *  backend `profiles.display_name` naming in migration 0001_identity.sql;
   *  its human meaning is still provisional per docs/atco-pending-business-rules.md). */
  readonly displayName?: string;
  /** True when the person confirmed they are 18 or older (the app's age of consent).
   *  Recorded as user metadata `age_confirmed_18_plus` with a timestamp; the date of birth itself is never sent. */
  readonly ageConfirmed?: boolean;
}

export interface SignUpOutput {
  readonly userId: string | null;
  readonly email: string;
  readonly session: Session | null;
  /**
   * True when signup returned a user but NO session: either email confirmation
   * is required, or the unconfirmed account already exists. This is a normal
   * result, not an error — the UI shows "check your email" guidance.
   */
  readonly emailConfirmationRequired: boolean;
}

export interface SignInOutput {
  readonly userId: string;
  readonly session: Session;
}

/** Handler registered with `onAuthStateChange`; see the SDK's AuthChangeEvent docs. */
export type AuthStateChangeHandler = (event: AuthChangeEvent, session: Session | null) => void;

/** Authentication is not usable in this mode/configuration at all. */
export class AuthNotAvailableError extends Error {
  readonly reason: 'demo-mode' | 'config-error';
  readonly issues?: readonly SupabaseConfigIssue[];

  constructor(reason: 'demo-mode' | 'config-error', message: string, issues?: readonly SupabaseConfigIssue[]) {
    super(message);
    this.name = 'AuthNotAvailableError';
    this.reason = reason;
    this.issues = issues;
  }
}

/** Supabase Auth itself reported an error for a concrete operation. */
export class AuthOperationError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(message: string, code: string | null, status: number | null) {
    super(message);
    this.name = 'AuthOperationError';
    this.code = code;
    this.status = status;
  }
}

/** Locally detected caller mistake (blank or malformed input); never sent to the network. */
export class AuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthInputError';
  }
}

/** Resolves the shared memoized client or declares auth unusable for this mode. */
function requireAuthClient(env?: EnvSource): SupabaseClient {
  const config = getAppConfig(env);
  if (config.mode === 'demo') {
    throw new AuthNotAvailableError(
      'demo-mode',
      `Authentication is not available in demo mode (run with ${'VITE_APP_MODE'}=production and valid Supabase configuration to enable it); the localStorage demo remains the default.`,
    );
  }
  if ('error' in config) {
    throw new AuthNotAvailableError('config-error', `Authentication is not available: ${config.error.message}`, config.error.issues);
  }
  return config.supabase;
}

/**
 * Client-side code given to the SDK's `AuthSessionMissingError` (it carries no server code):
 * the operation needed a session — e.g. a password update after a recovery link expired.
 */
export const SESSION_MISSING_CODE = 'session_missing';

/** Normalises a Supabase Auth error without forwarding credential values. */
function toAuthOperationError(
  error: { message?: unknown; code?: unknown; status?: unknown; name?: unknown } | null | undefined,
  context: string,
): AuthOperationError {
  const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';
  const message = rawMessage.length > 0 ? rawMessage : `Authentication request failed (${context}).`;
  const serverCode = typeof error?.code === 'string' && error.code.length > 0 ? error.code : null;
  const code = serverCode ?? (error?.name === 'AuthSessionMissingError' ? SESSION_MISSING_CODE : null);
  const status = typeof error?.status === 'number' && Number.isFinite(error.status) ? error.status : null;
  return new AuthOperationError(message, code, status);
}

const requireEmail = (email: string): string => {
  const trimmed = email.trim();
  if (!trimmed) throw new AuthInputError('Email is required.');
  return trimmed;
};

const requirePassword = (password: string): string => {
  if (!password.trim()) throw new AuthInputError('Password is required.');
  return password;
};

/** Password-reset redirects must be absolute http(s) URLs; anything else is a caller mistake. */
const requireRedirectUrl = (redirectTo: string): string => {
  const trimmed = redirectTo.trim();
  let parsed: URL | null = null;
  try { parsed = new URL(trimmed); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new AuthInputError('Password-reset redirect must be an absolute http(s) URL registered in the Supabase dashboard allow-list.');
  }
  return trimmed;
};

/**
 * Signs up with email/password. `displayName` becomes user metadata
 * (`display_name`) — it does NOT create a `profiles` row; profile creation is
 * a later checkpoint (the backend's `register_company` RPC owns that logic
 * and its relationship to profiles is provisional).
 */
export async function signUp(input: SignUpInput, env?: EnvSource): Promise<SignUpOutput> {
  const client = requireAuthClient(env);
  const email = requireEmail(input.email);
  const password = requirePassword(input.password);
  const metadata: Record<string, unknown> = {};
  if (input.displayName !== undefined && input.displayName.trim() !== '') metadata.display_name = input.displayName.trim();
  if (input.ageConfirmed) { metadata.age_confirmed_18_plus = true; metadata.age_confirmed_at = new Date().toISOString(); }
  // Nothing to record (no display name, no age confirmation): send NO metadata at all.
  const options = Object.keys(metadata).length > 0 ? { data: metadata } : undefined;
  const { data, error } = await client.auth.signUp({
    email,
    password,
    ...(options ? { options } : {}),
  });
  if (error) throw toAuthOperationError(error, 'sign-up');
  const session = data.session ?? null;
  return {
    userId: data.user?.id ?? null,
    email,
    session,
    emailConfirmationRequired: session === null,
  };
}

/** Signs in with email/password. Wrong credentials surface as `AuthOperationError`. */
export async function signIn(email: string, password: string, env?: EnvSource): Promise<SignInOutput> {
  const client = requireAuthClient(env);
  const { data, error } = await client.auth.signInWithPassword({
    email: requireEmail(email),
    password: requirePassword(password),
  });
  if (error) throw toAuthOperationError(error, 'sign-in');
  if (!data.user || !data.session) {
    throw new AuthOperationError('The sign-in response did not contain a session.', null, null);
  }
  return { userId: data.user.id, session: data.session };
}

/** Signs the current Supabase session out on the client. */
export async function signOut(env?: EnvSource): Promise<void> {
  const client = requireAuthClient(env);
  const { error } = await client.auth.signOut();
  if (error) throw toAuthOperationError(error, 'sign-out');
}

/**
 * Returns the current (persisted, locally validated and token-refreshed)
 * session, or null when signed out. When the stored token is expired this
 * performs the SDK's normal refresh call — a network request only in that case.
 */
export async function getSession(env?: EnvSource): Promise<Session | null> {
  const client = requireAuthClient(env);
  const { data, error } = await client.auth.getSession();
  if (error) throw toAuthOperationError(error, 'get-session');
  return data.session ?? null;
}

/**
 * Subscribes to auth-state changes (SIGN_IN, SIGNED_OUT, TOKEN_REFRESHED, ...).
 * Returns an unsubscribe function; it may be called any number of times — the
 * wrapper guarantees the underlying SDK unsubscribe runs exactly once, so
 * repeated calls are harmless (the SDK abandons its subscription channel on
 * the first real unsubscribe).
 */
export function onAuthStateChange(handler: AuthStateChangeHandler, env?: EnvSource): () => void {
  const client = requireAuthClient(env);
  const { data } = client.auth.onAuthStateChange(handler);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    data.subscription.unsubscribe();
  };
}

/**
 * Sends a password-reset email. `redirectTo` MUST be an explicit absolute
 * http(s) URL registered in the project's dashboard allow-list (see the
 * module header); Supabase validates it server-side.
 */
export async function requestPasswordReset(email: string, redirectTo: string, env?: EnvSource): Promise<void> {
  const client = requireAuthClient(env);
  const { error } = await client.auth.resetPasswordForEmail(requireEmail(email), {
    redirectTo: requireRedirectUrl(redirectTo),
  });
  if (error) throw toAuthOperationError(error, 'password-reset-request');
}

/** Updates the authenticated user's password (requires an active session;
 *  a missing/expired session surfaces as `AuthOperationError` from the server). */
export async function updatePassword(newPassword: string, env?: EnvSource): Promise<string | null> {
  const client = requireAuthClient(env);
  const { data, error } = await client.auth.updateUser({ password: requirePassword(newPassword) });
  if (error) throw toAuthOperationError(error, 'password-update');
  return data.user?.id ?? null;
}
