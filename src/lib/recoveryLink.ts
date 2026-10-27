/**
 * Password-recovery callback support (production mode).
 *
 * The emailed reset link is Supabase Auth's own: Supabase verifies the token
 * server-side and then redirects the browser to `VITE_AUTH_RESET_REDIRECT_URL`
 * (registered in the dashboard allow-list). The SDK (`detectSessionInUrl`)
 * reads the result from the URL, stores the recovery session and emits the
 * `PASSWORD_RECOVERY` auth event. No token is parsed, stored or validated by
 * this app — this module only classifies what the redirect URL *says*, so the
 * UI can show "verifying", "expired link" or "no link" truthfully.
 *
 * The signal must be read BEFORE the SDK processes and clears the URL, so the
 * auth provider snapshots it once, on mount.
 */

/** App route the reset email returns to (must match the registered redirect URL). */
export const RECOVERY_PATH = '/auth/reset-callback';

export type RecoveryLinkSignal =
  /** Nothing recovery-related in the URL. */
  | { readonly kind: 'none' }
  /** A recovery redirect (implicit-flow `type=recovery` fragment, or a PKCE `code` on the callback route). */
  | { readonly kind: 'link' }
  /** Supabase redirected with an error (e.g. `otp_expired`): no session was issued. */
  | { readonly kind: 'error'; readonly code: string };

interface UrlParts {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** Error codes are shown as fixed text keys only; anything unexpected collapses to a generic code. */
const KNOWN_ERROR_CODE = /^[a-z_]{1,64}$/;

export function readRecoveryLinkSignal(location: UrlParts | null | undefined): RecoveryLinkSignal {
  if (!location) return { kind: 'none' };
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search.replace(/^\?/, ''));
  const read = (name: string) => hash.get(name) ?? query.get(name);

  const errorCode = read('error_code') ?? read('error');
  if (errorCode !== null || read('error_description') !== null) {
    const code = errorCode && KNOWN_ERROR_CODE.test(errorCode) ? errorCode : 'link_error';
    return { kind: 'error', code };
  }
  if (hash.get('type') === 'recovery' && hash.has('access_token')) return { kind: 'link' };
  if (location.pathname === RECOVERY_PATH && query.has('code')) return { kind: 'link' };
  return { kind: 'none' };
}
