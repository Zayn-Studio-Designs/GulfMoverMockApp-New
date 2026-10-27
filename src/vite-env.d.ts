/// <reference types="vite/client" />

/**
 * Gulf Mover environment variables (Vite-injected, build-time public values).
 *
 * Only publishable/public values may ever live here: `VITE_*` variables are
 * embedded into the browser bundle by Vite. Secret keys (service_role, etc.)
 * must never be added as VITE_* variables.
 */
interface ImportMetaEnv {
  /** Application mode: unset or anything other than "production" runs the existing demo. */
  readonly VITE_APP_MODE?: string;
  /** Supabase project URL — required in production mode. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (anon/public) key — required in production mode. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Absolute http(s) redirect URL for emailed password-reset links —
   *  required in production mode; must be registered in the Supabase
   *  dashboard allow-list (Auth → URL Configuration) and kept public-only
   *  (it is embedded in the browser bundle like every VITE_* value). */
  readonly VITE_AUTH_RESET_REDIRECT_URL?: string;
}
