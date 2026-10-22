import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// DEMO ACCOUNTS ONLY — not real authentication. Accounts live in this browser's localStorage,
// there is no server, and nothing is sent anywhere. Passwords are stored as a salted SHA-256
// hash so the plain text is never kept, but users must still be told not to use a real password.

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
  | 'errPhone' | 'errWebsite' | 'errResetCode' | 'errSameEmail';

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

interface AuthContextValue {
  user: PublicAccount | null;
  /** True after the user signed out on purpose (so we don't send them back to their last page). */
  signedOutByUser: boolean;
  signUp: (input: SignUpInput) => Promise<AuthError | null>;
  signIn: (login: string, password: string, remember?: boolean) => Promise<AuthError | null>;
  signInAsGuest: () => Promise<void>;
  /** Simulated provider sign-in: session only, no real identity provider is contacted. */
  signInWithProvider: (provider: DemoProvider) => Promise<void>;
  signOut: () => void;
  updateProfile: (patch: ProfilePatch) => AuthError | null;
  changeEmail: (email: string, password: string) => Promise<AuthError | null>;
  changePassword: (current: string, next: string, confirm: string) => Promise<AuthError | null>;
  /** Demo stand-in for "email me a reset code": returns the code so the demo can display it. */
  requestResetCode: (email: string) => { code: string } | { error: AuthError };
  resetPassword: (email: string, code: string, next: string, confirm: string) => Promise<AuthError | null>;
  deleteAccount: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
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

  const signOut = useCallback(() => startSession(null), [startSession]);

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

  const value = useMemo(() => ({
    user, signedOutByUser, signUp, signIn, signInAsGuest, signInWithProvider, signOut, updateProfile, changeEmail, changePassword, requestResetCode, resetPassword, deleteAccount,
  }), [user, signedOutByUser, signUp, signIn, signInAsGuest, signOut, updateProfile, changeEmail, changePassword, requestResetCode, resetPassword, deleteAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
