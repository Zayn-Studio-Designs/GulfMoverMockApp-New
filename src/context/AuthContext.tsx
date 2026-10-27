import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import * as supabaseAuth from '../lib/authService';
import {
  AuthInputError, AuthNotAvailableError, AuthOperationError, type SignUpInput as SupabaseSignUpInput,
} from '../lib/authService';
import { getAppConfig, type AppConfig, type EnvSource, type SupabaseConfigIssue } from '../lib/supabase';
import { readRecoveryLinkSignal, type RecoveryLinkSignal } from '../lib/recoveryLink';

// DEMO ACCOUNTS ONLY — not real authentication. Accounts live in this browser's localStorage,
// there is no server, and nothing is sent anywhere. Passwords are stored as a salted SHA-256
// hash so the plain text is never kept, but users must still be told not to use a real password.
//
// MODE-AWARE AUTHENTICATION: with no VITE_APP_MODE=production the provider below is the exact
// demo implementation from earlier checkpoints, completely untouched. Only when production
// mode is explicitly selected (and validated by src/lib/supabase.ts) does this file use the
// Checkpoint 1 Supabase auth service. Both modes expose the same context shape, so the shell
// works unchanged; AuthView / Layout / SettingsView branch on `authMode` for the small
// production-specific affordances (no guest/provider flows, no on-screen reset code, etc.).
//
// Profile / company / notification writes stay demo-only in this checkpoint (they belong to
// the later company-registration phase): in production mode those settings cards are hidden
// and every backend write returns 'errDemoOnly' — never a silent fake success.

export interface NotificationPrefs {
  emailBookings: boolean;
  smsSchedule: boolean;
  whatsapp: boolean;
  productNews: boolean;
}

export interface Account {
  id: string;
  email: string;
  username: string;
  fullName: string;
  phone: string;
  company: string;
  companyLogo: string; // data URL, '' when none
  companyAddress: string;
  companyWebsite: string;
  avatar: string; // data URL, '' when none
  notifications: NotificationPrefs;
  createdAt: string;
  salt: string;
  passwordHash: string;
}

export type PublicAccount = Omit<Account, 'salt' | 'passwordHash'>;

export type AuthError =
  | 'errEmail' | 'errUsername' | 'errCompany' | 'errPasswordRules' | 'errPasswordMatch'
  | 'errEmailTaken' | 'errUsernameTaken' | 'errSignIn' | 'errCurrentPassword' | 'errNoAccount'
  | 'errPhone' | 'errWebsite' | 'errResetCode' | 'errSameEmail'
  // Production (Supabase) mode:
  | 'errEmailNotConfirmed' | 'errAuthGeneric' | 'errDemoOnly' | 'errResetRedirect'
  | 'errAuthUnavailable' | 'errAuthNetwork' | 'errSignInEmail' | 'errSignOutFailed'
  | 'errSessionRequired' | 'errRecoveryExpired' | 'errSamePassword';

/**
 * Password-recovery progress (production only; always 'none' in demo mode):
 * - 'verifying': the URL carried a recovery link and the SDK is still exchanging it;
 * - 'ready': Supabase issued a recovery session (PASSWORD_RECOVERY) — a new password may be set;
 * - 'invalid': the link was expired/invalid, or no recovery session could be established;
 * - 'completed': the new password was accepted by Supabase.
 */
export type PasswordRecoveryState = 'none' | 'verifying' | 'ready' | 'invalid' | 'completed';

export type ProfilePatch = Partial<Pick<Account,
  'username' | 'fullName' | 'phone' | 'company' | 'companyLogo' | 'companyAddress' | 'companyWebsite' | 'avatar' | 'notifications'>>;

const ACCOUNTS_KEY = 'gm-demo-accounts';
const ACCOUNTS_DAMAGED_KEY = 'gm-demo-accounts-damaged';
const SESSION_KEY = 'gm-demo-session';
const RESET_CODE_MINUTES = 15;

const DEFAULT_NOTIFICATIONS: NotificationPrefs = { emailBookings: true, smsSchedule: true, whatsapp: false, productNews: false };

export const DEMO_GUEST = { email: 'guest@demo.test', username: 'demo-guest', company: 'Demo Logistics Co.' };

/** Stand-in demo identities for the simulated provider sign-in (no real OAuth, no emails
    collected — these are fictional internal markers in the existing demo account shape). */
export type DemoProvider = 'google' | 'apple';
export const DEMO_PROVIDERS: Record<DemoProvider, { email: string; username: string }> = {
  google: { email: 'provider-google@demo.test', username: 'demo-google' },
  apple: { email: 'provider-apple@demo.test', username: 'demo-apple' },
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown, store: Storage = localStorage) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): the demo still works for this session.
  }
}

/** "Keep me signed in" keeps the session in localStorage; otherwise it lasts until the tab closes. */
function loadSession(): string | null {
  try {
    return load<string | null>(SESSION_KEY, null) ?? (JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as string | null);
  } catch {
    return null;
  }
}

/**
 * Reads the saved demo accounts without trusting their shape. Well-formed accounts are kept;
 * anything unreadable (not a list, or entries without id / email / username / password data) is
 * skipped so it cannot break sign-in. Nothing is rewritten here: the saved list only changes on the
 * next account action, and a copy of a damaged original is first kept under ACCOUNTS_DAMAGED_KEY.
 */
function loadAccounts(): Account[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ACCOUNTS_KEY); } catch { return []; }
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const list = Array.isArray(parsed) ? parsed : [];
  const valid = list.filter(isStoredAccount);
  if (!Array.isArray(parsed) || valid.length !== list.length) keepDamagedCopy(ACCOUNTS_DAMAGED_KEY, raw);
  return valid.map(withDefaults);
}

const isStoredAccount = (a: unknown): a is Account => {
  if (typeof a !== 'object' || a === null) return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === 'string' && typeof x.email === 'string' && typeof x.username === 'string'
    && typeof x.salt === 'string' && typeof x.passwordHash === 'string';
};

/** Keeps the first damaged original so it can be inspected or restored; never overwrites an earlier copy. */
function keepDamagedCopy(key: string, raw: string) {
  try {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, raw);
    console.warn(`Gulf Mover demo: saved data under "${key.replace(/-damaged$/, '')}" was damaged; a copy is kept under "${key}".`);
  } catch {
    // Storage unavailable: nothing to keep.
  }
}

/** Older demo accounts were saved before the extra profile/company fields existed. */
const withDefaults = (a: Partial<Account> & Omit<Account, 'fullName' | 'phone' | 'companyLogo' | 'companyAddress' | 'companyWebsite'>): Account => ({
  fullName: '', phone: '', companyLogo: '', companyAddress: '', companyWebsite: '', ...a,
});

const randomId = () => Math.random().toString(36).slice(2, 10);

async function hashPassword(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for environments without Web Crypto (demo only).
  let h = 2166136261;
  for (const byte of data) h = Math.imul(h ^ byte, 16777619);
  return `fnv-${(h >>> 0).toString(16)}`;
}

export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
/** At least 8 characters with a letter and a number. */
export const isValidPassword = (pw: string) => pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
export const isValidUsername = (u: string) => /^[A-Za-z0-9._-]{3,30}$/.test(u.trim());
export const isValidPhone = (p: string) => !p.trim() || /^\+?[0-9 ()-]{7,20}$/.test(p.trim());
export const isValidWebsite = (w: string) => !w.trim() || /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(w.trim());

const toPublic = ({ salt: _salt, passwordHash: _hash, ...rest }: Account): PublicAccount => rest;

interface SignUpInput { email: string; username: string; company: string; password: string; confirm: string }

/** Authentication is not usable at all in this mode/configuration (production mode only). */
export interface AuthUnavailable {
  reason: 'demo-mode' | 'config-error';
  issues: readonly SupabaseConfigIssue[];
}

export interface AuthContextValue {
  user: PublicAccount | null;
  /** True after the user signed out on purpose (so we don't send them back to their last page). */
  signedOutByUser: boolean;
  /** Which authentication backend backs this context. */
  authMode: 'demo' | 'production';
  /** Production mode only: true while the persisted Supabase session is being restored. */
  sessionLoading: boolean;
  /** Set when the authentication backend (not a single operation) is unusable. */
  authUnavailable: AuthUnavailable | null;
  /** Production sign-up that returned no session: confirmation of the email is required first. */
  confirmationPending: string | null;
  signUp: (input: SignUpInput) => Promise<AuthError | null>;
  signIn: (login: string, password: string, remember?: boolean) => Promise<AuthError | null>;
  signInAsGuest: () => Promise<void>;
  /** Simulated provider sign-in: session only, no real identity provider is contacted (demo mode). */
  signInWithProvider: (provider: DemoProvider) => Promise<void>;
  /** Resolves null only once the session is really gone; otherwise an error key and the user stays signed in. */
  signOut: () => Promise<AuthError | null>;
  updateProfile: (patch: ProfilePatch) => AuthError | null;
  changeEmail: (email: string, password: string) => Promise<AuthError | null>;
  changePassword: (current: string, next: string, confirm: string) => Promise<AuthError | null>;
  /** Demo stand-in for "email me a reset code": returns the code so the demo can display it. */
  requestResetCode: (email: string) => { code: string } | { error: AuthError };
  /** Production: emails a password-reset link with a configured redirect (fails clearly if unset). */
  requestResetEmail: (email: string) => Promise<AuthError | null>;
  resetPassword: (email: string, code: string, next: string, confirm: string) => Promise<AuthError | null>;
  deleteAccount: () => void;
  /** Production password-recovery progress (see PasswordRecoveryState). */
  recovery: PasswordRecoveryState;
  /** Error code from an invalid/expired recovery redirect (e.g. 'otp_expired'), else null. */
  recoveryLinkError: string | null;
  /** Sets the new password inside the Supabase recovery session (production only). */
  completePasswordRecovery: (next: string, confirm: string) => Promise<AuthError | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/* ------------------------------------------------------------------------- */
/* Demo mode: the original demo implementation, unchanged in behaviour.       */
/* ------------------------------------------------------------------------- */

/** Demo resets use the on-screen code; emailed recovery links exist only in production. */
const demoRecoveryUnavailable = async (): Promise<AuthError | null> => 'errDemoOnly';

function DemoAuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccountsState] = useState<Account[]>(loadAccounts);
  const [sessionId, setSessionId] = useState<string | null>(loadSession);
  const [signedOutByUser, setSignedOutByUser] = useState(false);
  // Reset codes live only in memory, like a short-lived emailed code.
  const [resetCodes, setResetCodes] = useState<Record<string, { code: string; expires: number }>>({});

  const setAccounts = useCallback((next: Account[]) => { setAccountsState(next); save(ACCOUNTS_KEY, next); }, []);
  const startSession = useCallback((id: string | null, remember = true) => {
    setSessionId(id);
    save(SESSION_KEY, remember ? id : null);
    try { save(SESSION_KEY, remember ? null : id, sessionStorage); } catch { /* no session storage */ }
    setSignedOutByUser(id === null);
  }, []);

  const current = accounts.find(a => a.id === sessionId);
  const user = current ? toPublic(current) : null;

  const signUp = useCallback(async ({ email, username, company, password, confirm }: SignUpInput): Promise<AuthError | null> => {
    if (!isValidEmail(email)) return 'errEmail';
    if (!isValidUsername(username)) return 'errUsername';
    if (!company.trim()) return 'errCompany';
    if (!isValidPassword(password)) return 'errPasswordRules';
    if (password !== confirm) return 'errPasswordMatch';
    if (accounts.some(a => a.email.toLowerCase() === email.trim().toLowerCase())) return 'errEmailTaken';
    if (accounts.some(a => a.username.toLowerCase() === username.trim().toLowerCase())) return 'errUsernameTaken';
    const salt = randomId() + randomId();
    const account: Account = {
      id: `U-${randomId()}`, email: email.trim(), username: username.trim(), fullName: '', phone: '',
      company: company.trim(), companyLogo: '', companyAddress: '', companyWebsite: '', avatar: '',
      notifications: { ...DEFAULT_NOTIFICATIONS }, createdAt: new Date().toISOString(), salt, passwordHash: await hashPassword(password, salt),
    };
    setAccounts([...accounts, account]);
    startSession(account.id);
    return null;
  }, [accounts, setAccounts, startSession]);

  const signIn = useCallback(async (login: string, password: string, remember = true): Promise<AuthError | null> => {
    const key = login.trim().toLowerCase();
    const account = accounts.find(a => a.email.toLowerCase() === key || a.username.toLowerCase() === key);
    if (!account || (await hashPassword(password, account.salt)) !== account.passwordHash) return 'errSignIn';
    startSession(account.id, remember);
    return null;
  }, [accounts, startSession]);

  const signInAsGuest = useCallback(async () => {
    const existing = accounts.find(a => a.email === DEMO_GUEST.email);
    if (existing) { startSession(existing.id); return; }
    const salt = randomId();
    const guest: Account = {
      id: `U-guest`, ...DEMO_GUEST, fullName: '', phone: '', companyLogo: '', companyAddress: '', companyWebsite: '', avatar: '', notifications: { ...DEFAULT_NOTIFICATIONS }, createdAt: new Date().toISOString(),
      salt, passwordHash: await hashPassword(randomId() + randomId(), salt),
    };
    setAccounts([...accounts, guest]);
    startSession(guest.id);
  }, [accounts, setAccounts, startSession]);

  /** Simulated "continue with Google/Apple": creates (or reuses) a clearly-labelled demo
      account and starts the session — the real product would run OAuth here instead. */
  const signInWithProvider = useCallback(async (provider: DemoProvider) => {
    const meta = DEMO_PROVIDERS[provider];
    const existing = accounts.find(a => a.email === meta.email);
    if (existing) { startSession(existing.id); return; }
    const salt = randomId();
    const providerAccount: Account = {
      id: `U-provider-${provider}`, ...meta, company: 'Demo Logistics Co.',
      fullName: '', phone: '', companyLogo: '', companyAddress: '', companyWebsite: '', avatar: '',
      notifications: { ...DEFAULT_NOTIFICATIONS }, createdAt: new Date().toISOString(),
      salt, passwordHash: await hashPassword(randomId() + randomId(), salt),
    };
    setAccounts([...accounts, providerAccount]);
    startSession(providerAccount.id);
  }, [accounts, setAccounts, startSession]);

  const signOut = useCallback(async (): Promise<AuthError | null> => { startSession(null); return null; }, [startSession]);

  const updateProfile = useCallback((patch: ProfilePatch): AuthError | null => {
    if (!current) return null;
    if (patch.username !== undefined) {
      if (!isValidUsername(patch.username)) return 'errUsername';
      if (accounts.some(a => a.id !== current.id && a.username.toLowerCase() === patch.username!.trim().toLowerCase())) return 'errUsernameTaken';
    }
    if (patch.company !== undefined && !patch.company.trim()) return 'errCompany';
    if (patch.phone !== undefined && !isValidPhone(patch.phone)) return 'errPhone';
    if (patch.companyWebsite !== undefined && !isValidWebsite(patch.companyWebsite)) return 'errWebsite';
    const cleaned: ProfilePatch = { ...patch };
    for (const k of ['username', 'fullName', 'phone', 'company', 'companyAddress', 'companyWebsite'] as const) {
      if (cleaned[k] !== undefined) cleaned[k] = cleaned[k]!.trim();
    }
    setAccounts(accounts.map(a => (a.id === current.id ? { ...a, ...cleaned } : a)));
    return null;
  }, [accounts, current, setAccounts]);

  const changePassword = useCallback(async (currentPw: string, next: string, confirm: string): Promise<AuthError | null> => {
    if (!current) return null;
    if ((await hashPassword(currentPw, current.salt)) !== current.passwordHash) return 'errCurrentPassword';
    if (!isValidPassword(next)) return 'errPasswordRules';
    if (next !== confirm) return 'errPasswordMatch';
    const salt = randomId() + randomId();
    const passwordHash = await hashPassword(next, salt);
    setAccounts(accounts.map(a => (a.id === current.id ? { ...a, salt, passwordHash } : a)));
    return null;
  }, [accounts, current, setAccounts]);

  /** Changing the sign-in email needs the current password, as in most apps. */
  const changeEmail = useCallback(async (email: string, password: string): Promise<AuthError | null> => {
    if (!current) return null;
    if (!isValidEmail(email)) return 'errEmail';
    if (email.trim().toLowerCase() === current.email.toLowerCase()) return 'errSameEmail';
    if (accounts.some(a => a.id !== current.id && a.email.toLowerCase() === email.trim().toLowerCase())) return 'errEmailTaken';
    if ((await hashPassword(password, current.salt)) !== current.passwordHash) return 'errCurrentPassword';
    setAccounts(accounts.map(a => (a.id === current.id ? { ...a, email: email.trim() } : a)));
    return null;
  }, [accounts, current, setAccounts]);

  const requestResetCode = useCallback((email: string): { code: string } | { error: AuthError } => {
    if (!isValidEmail(email)) return { error: 'errEmail' };
    const key = email.trim().toLowerCase();
    if (!accounts.some(a => a.email.toLowerCase() === key)) return { error: 'errNoAccount' };
    const code = String(Math.floor(100000 + Math.random() * 900000));
    setResetCodes(c => ({ ...c, [key]: { code, expires: Date.now() + RESET_CODE_MINUTES * 60_000 } }));
    return { code };
  }, [accounts]);

  /** Demo stand-in for an emailed reset code: checks the code, then sets a new password. */
  const resetPassword = useCallback(async (email: string, code: string, next: string, confirm: string): Promise<AuthError | null> => {
    const key = email.trim().toLowerCase();
    const account = accounts.find(a => a.email.toLowerCase() === key);
    if (!account) return 'errNoAccount';
    const issued = resetCodes[key];
    if (!issued || issued.expires < Date.now() || issued.code !== code.trim()) return 'errResetCode';
    if (!isValidPassword(next)) return 'errPasswordRules';
    if (next !== confirm) return 'errPasswordMatch';
    const salt = randomId() + randomId();
    const passwordHash = await hashPassword(next, salt);
    setAccounts(accounts.map(a => (a.id === account.id ? { ...a, salt, passwordHash } : a)));
    setResetCodes(({ [key]: _used, ...rest }) => rest);
    return null;
  }, [accounts, resetCodes, setAccounts]);

  const deleteAccount = useCallback(() => {
    if (!current) return;
    setAccounts(accounts.filter(a => a.id !== current.id));
    startSession(null);
  }, [accounts, current, setAccounts, startSession]);

  const requestResetEmail = useCallback(async (email: string): Promise<AuthError | null> => {
    if (!isValidEmail(email)) return 'errEmail';
    // Demo "email" keeps the code on screen via requestResetCode; no real email is sent.
    const outcome = requestResetCode(email);
    return 'error' in outcome ? outcome.error : null;
  }, [requestResetCode]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    signedOutByUser,
    authMode: 'demo',
    sessionLoading: false,
    authUnavailable: null,
    confirmationPending: null,
    signUp,
    signIn,
    signInAsGuest,
    signInWithProvider,
    signOut,
    updateProfile,
    changeEmail,
    changePassword,
    requestResetCode,
    requestResetEmail,
    resetPassword,
    deleteAccount,
    recovery: 'none',
    recoveryLinkError: null,
    completePasswordRecovery: demoRecoveryUnavailable,
  }), [user, signedOutByUser, signUp, signIn, signInAsGuest, signOut, updateProfile, changeEmail,
    changePassword, requestResetCode, requestResetEmail, resetPassword, deleteAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* --------------------------------------------------------------------- */
/* Production mode: Supabase Auth behind the same context interface.      */
/* --------------------------------------------------------------------- */

/** Maps a Supabase user onto the account shape the UI consumes (demo fields stay neutral). */
function toPublicUser(session: Session | null): PublicAccount | null {
  const u = session?.user;
  if (!u) return null;
  let displayName = '';
  if (u.user_metadata && typeof u.user_metadata === 'object') {
    const raw = (u.user_metadata as Record<string, unknown>)['display_name'];
    if (typeof raw === 'string') displayName = raw.trim();
  }
  return {
    id: u.id,
    email: u.email ?? '',
    username: displayName || (u.email ? u.email.split('@')[0] : '') || 'user',
    fullName: displayName,
    phone: '', company: '', companyLogo: '', companyAddress: '', companyWebsite: '', avatar: '',
    notifications: { ...DEFAULT_NOTIFICATIONS },
    createdAt: u.created_at ?? new Date().toISOString(),
  };
}

/** Network-level failures (no HTTP response, or a gateway/server error) — never shown as a credential problem. */
const isNetworkFailure = (error: AuthOperationError) => error.code === null && (error.status === 0 || (error.status ?? 0) >= 500);

function SupabaseAuthProvider({ children, recoverySignal }: { children: ReactNode; recoverySignal: RecoveryLinkSignal }) {
  const env: EnvSource = import.meta.env;
  // Resolved once per provider mount; getSupabaseClient itself memoizes the client.
  const app = useMemo<AppConfig>(() => getAppConfig(env), [env]);
  const [user, setUser] = useState<PublicAccount | null>(null);
  // Loading state stays separate from "signed out" so a restored session is never redirected.
  const [sessionLoading, setSessionLoading] = useState(() => app.mode === 'production' && app.supabase !== null);
  const [signedOutByUser, setSignedOutByUser] = useState(false);
  const [confirmationPending, setConfirmationPending] = useState<string | null>(null);
  const [authUnavailable, setAuthUnavailable] = useState<AuthUnavailable | null>(() =>
    app.mode === 'production' && 'error' in app ? { reason: 'config-error', issues: app.error.issues } : null);
  const [recovery, setRecovery] = useState<PasswordRecoveryState>(() =>
    recoverySignal.kind === 'link' ? 'verifying' : recoverySignal.kind === 'error' ? 'invalid' : 'none');
  const recoveryLinkError = recoverySignal.kind === 'error' ? recoverySignal.code : null;

  /**
   * Session-race guard. Every authoritative change (an auth-state event, or a sign-in /
   * sign-up / sign-out completed through this context) advances the generation. The initial
   * getSession() result is applied only if nothing newer happened while it was in flight, so a
   * stale "restored" session can never overwrite a later sign-out, and a stale "no session"
   * can never undo a later sign-in.
   */
  const generation = useRef(0);
  const hasSession = useRef(false);

  const applySession = useCallback((session: Session | null) => {
    generation.current += 1;
    hasSession.current = session !== null;
    setUser(toPublicUser(session));
    if (session) {
      // A real session supersedes any "check your email" notice from an earlier sign-up.
      setConfirmationPending(null);
      setSignedOutByUser(false);
    }
  }, []);

  const applySignedOut = useCallback(() => {
    generation.current += 1;
    hasSession.current = false;
    setUser(null);
    setSignedOutByUser(true);
    setConfirmationPending(null);
    // A recovery session ends with the session; an expired-link report stays visible.
    setRecovery(r => (r === 'ready' || r === 'verifying' || r === 'completed' ? 'none' : r));
  }, []);

  // Restore the persisted session once, and keep listening for later auth-state changes.
  useEffect(() => {
    if (app.mode !== 'production') return;
    if (app.supabase === null) { setSessionLoading(false); return; } // configuration error: nothing to restore
    let active = true;
    const stopListening = supabaseAuth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'SIGNED_OUT') {
        applySignedOut();
      } else {
        if (event === 'PASSWORD_RECOVERY') setRecovery('ready');
        // SIGNED_IN, INITIAL_SESSION, TOKEN_REFRESHED, USER_UPDATED and PASSWORD_RECOVERY carry the
        // current session; an event without one (INITIAL_SESSION when signed out) still counts as
        // authoritative for the restore race.
        if (session) applySession(session);
        else generation.current += 1;
      }
    });
    const startedAt = generation.current;
    void (async () => {
      try {
        const restored = await supabaseAuth.getSession(env);
        if (!active) return;
        if (generation.current === startedAt) applySession(restored);
      } catch {
        // Restore failure (e.g. offline/expired): present the signed-out state; a later
        // sign-in retries against the still-persisted token. Not a configuration problem.
      } finally {
        if (active) {
          setSessionLoading(false);
          // A recovery link that produced no session by the end of restoration is not usable.
          setRecovery(r => (r === 'verifying' ? (hasSession.current ? 'ready' : 'invalid') : r));
        }
      }
    })();
    return () => { active = false; stopListening(); };
  }, [app, env, applySession, applySignedOut]);

  /** Maps a Supabase auth-service failure to an interface error key; never echoes inputs. */
  const mapAuthFailure = useCallback((error: unknown, fallback: AuthError = 'errAuthGeneric'): AuthError => {
    if (error instanceof AuthNotAvailableError) {
      setAuthUnavailable({ reason: error.reason, issues: error.issues ?? [] });
      return 'errAuthUnavailable';
    }
    if (error instanceof AuthInputError) {
      if (/redirect/i.test(error.message)) return 'errResetRedirect';
      if (/password/i.test(error.message)) return 'errPasswordRules';
      return 'errEmail'; // email input problems (blank email); fixed text, no echo
    }
    if (error instanceof AuthOperationError) {
      switch (error.code) {
        case 'user_already_exists': case 'email_exists': return 'errEmailTaken';
        case 'invalid_credentials': return 'errSignInEmail';
        case 'email_not_confirmed': return 'errEmailNotConfirmed';
        case 'weak_password': return 'errPasswordRules';
        case 'same_password': return 'errSamePassword';
        default: return isNetworkFailure(error) ? 'errAuthNetwork' : fallback;
      }
    }
    return fallback;
  }, []);

  const signUp = useCallback(async ({ email, password, confirm, username }: SignUpInput): Promise<AuthError | null> => {
    if (!isValidEmail(email)) return 'errEmail';
    if (!isValidPassword(password)) return 'errPasswordRules';
    if (password !== confirm) return 'errPasswordMatch';
    if (authUnavailable) return 'errAuthUnavailable'; // never a silent "success"
    const serviceInput: SupabaseSignUpInput =
      username.trim() ? { email, password, displayName: username.trim() } : { email, password };
    try {
      const result = await supabaseAuth.signUp(serviceInput, env);
      if (result.session) {
        applySession(result.session);
        return null;
      }
      // Email confirmation required: no session until the emailed link is used.
      setConfirmationPending(result.email);
      return null;
    } catch (error) {
      return mapAuthFailure(error);
    }
  }, [authUnavailable, env, applySession, mapAuthFailure]);

  const signIn = useCallback(async (login: string, password: string, _remember?: boolean): Promise<AuthError | null> => {
    if (!isValidEmail(login)) return 'errEmail'; // production accepts an email address only
    if (!password.trim()) return 'errSignInEmail'; // fixed generic text: no per-field hints, no echo
    if (authUnavailable) return 'errAuthUnavailable'; // never a silent "success"
    try {
      const result = await supabaseAuth.signIn(login.trim(), password, env);
      applySession(result.session);
      return null;
    } catch (error) {
      return mapAuthFailure(error, 'errSignInEmail');
    }
  }, [authUnavailable, env, applySession, mapAuthFailure]);

  /** Only reports success once Supabase has ended the session; on failure the user stays signed in. */
  const signOut = useCallback(async (): Promise<AuthError | null> => {
    if (authUnavailable) return 'errAuthUnavailable';
    try {
      await supabaseAuth.signOut(env);
    } catch {
      return 'errSignOutFailed';
    }
    applySignedOut();
    return null;
  }, [authUnavailable, env, applySignedOut]);

  // Guest and provider flows are demo-only presentation: not rendered in production mode.
  const signInAsGuest = useCallback(async () => { /* unavailable in production */ }, []);
  const signInWithProvider = useCallback(async () => { /* unavailable in production */ }, []);

  // Demo-data writes are not real persistence in production mode; the Settings UI hides those
  // cards, and any accidental use gets a clearly-labelled refusal (never a fake success).
  const updateProfile = useCallback((): AuthError | null => 'errDemoOnly', []);
  const changeEmail = useCallback(async (): Promise<AuthError | null> => 'errDemoOnly', []);
  const resetPassword = useCallback(async (): Promise<AuthError | null> => 'errDemoOnly', []);
  const requestResetCode = useCallback((): { code: string } | { error: AuthError } => ({ error: 'errDemoOnly' }), []);
  const deleteAccount = useCallback(() => { /* hidden in production UI */ }, []);

  const requestResetEmail = useCallback(async (email: string): Promise<AuthError | null> => {
    if (!isValidEmail(email)) return 'errEmail';
    if (authUnavailable) return 'errAuthUnavailable';
    const redirectTo = env['VITE_AUTH_RESET_REDIRECT_URL'];
    if (typeof redirectTo !== 'string' || !redirectTo.trim()) return 'errResetRedirect'; // fail clearly, documented
    try {
      await supabaseAuth.requestPasswordReset(email, redirectTo.trim(), env);
      return null;
    } catch (error) {
      return mapAuthFailure(error, 'errAuthGeneric');
    }
  }, [authUnavailable, env, mapAuthFailure]);

  const changePassword = useCallback(async (current: string, next: string, confirm: string): Promise<AuthError | null> => {
    if (!user) return 'errSessionRequired'; // only meaningful with an active session; never a fake success
    if (!isValidPassword(next)) return 'errPasswordRules';
    if (next !== confirm) return 'errPasswordMatch';
    // Supabase updates a password inside the active session, so no current-password check is
    // available; the production UI hides that field, and any typed value here is ignored
    // rather than wrongly validated.
    if (current.trim()) return 'errDemoOnly';
    try {
      await supabaseAuth.updatePassword(next, env);
      return null;
    } catch (error) {
      if (error instanceof AuthOperationError && error.code === supabaseAuth.SESSION_MISSING_CODE) return 'errSessionRequired';
      return mapAuthFailure(error, 'errAuthGeneric');
    }
  }, [env, mapAuthFailure, user]);

  /** Recovery: the new password is set inside the recovery session Supabase issued for the email link. */
  const completePasswordRecovery = useCallback(async (next: string, confirm: string): Promise<AuthError | null> => {
    if (authUnavailable) return 'errAuthUnavailable';
    if (recovery !== 'ready') return 'errRecoveryExpired';
    if (!isValidPassword(next)) return 'errPasswordRules';
    if (next !== confirm) return 'errPasswordMatch';
    try {
      await supabaseAuth.updatePassword(next, env);
      setRecovery('completed');
      return null;
    } catch (error) {
      if (error instanceof AuthOperationError) {
        if (error.code === supabaseAuth.SESSION_MISSING_CODE || error.code === 'session_not_found'
          || error.code === 'session_expired' || error.code === 'reauthentication_needed'
          || error.status === 401 || error.status === 403) {
          setRecovery('invalid');
          return 'errRecoveryExpired';
        }
      }
      return mapAuthFailure(error, 'errAuthGeneric');
    }
  }, [authUnavailable, env, mapAuthFailure, recovery]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    signedOutByUser,
    authMode: 'production',
    sessionLoading,
    authUnavailable,
    confirmationPending,
    signUp,
    signIn,
    signInAsGuest,
    signInWithProvider,
    signOut,
    updateProfile,
    changeEmail,
    changePassword,
    requestResetCode,
    requestResetEmail,
    resetPassword,
    deleteAccount,
    recovery,
    recoveryLinkError,
    completePasswordRecovery,
  }), [user, signedOutByUser, sessionLoading, authUnavailable, confirmationPending, signUp, signIn, signInAsGuest,
    signInWithProvider, signOut, updateProfile, changeEmail, changePassword, requestResetCode, requestResetEmail,
    resetPassword, deleteAccount, recovery, recoveryLinkError, completePasswordRecovery]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Snapshot the recovery-link signal before the Supabase client is created: the SDK consumes
  // and clears the URL fragment while it establishes the recovery session.
  const [recoverySignal] = useState<RecoveryLinkSignal>(() =>
    (typeof window === 'undefined' ? { kind: 'none' } : readRecoveryLinkSignal(window.location)));
  const env: EnvSource = import.meta.env;
  const mode = useMemo(() => getAppConfig(env).mode, [env]);
  return mode === 'production'
    ? <SupabaseAuthProvider recoverySignal={recoverySignal}>{children}</SupabaseAuthProvider>
    : <DemoAuthProvider>{children}</DemoAuthProvider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
