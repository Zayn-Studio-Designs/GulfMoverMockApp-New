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
  company: string;
  avatar: string; // data URL, '' when none
  notifications: NotificationPrefs;
  createdAt: string;
  salt: string;
  passwordHash: string;
}

export type PublicAccount = Omit<Account, 'salt' | 'passwordHash'>;

export type AuthError =
  | 'errEmail' | 'errUsername' | 'errCompany' | 'errPasswordRules' | 'errPasswordMatch'
  | 'errEmailTaken' | 'errUsernameTaken' | 'errSignIn' | 'errCurrentPassword' | 'errNoAccount';

const ACCOUNTS_KEY = 'gm-demo-accounts';
const SESSION_KEY = 'gm-demo-session';

const DEFAULT_NOTIFICATIONS: NotificationPrefs = { emailBookings: true, smsSchedule: true, whatsapp: false, productNews: false };

export const DEMO_GUEST = { email: 'guest@demo.test', username: 'demo-guest', company: 'Demo Logistics Co.' };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): the demo still works for this session.
  }
}

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

const toPublic = ({ salt: _salt, passwordHash: _hash, ...rest }: Account): PublicAccount => rest;

interface SignUpInput { email: string; username: string; company: string; password: string; confirm: string }

interface AuthContextValue {
  user: PublicAccount | null;
  /** True after the user signed out on purpose (so we don't send them back to their last page). */
  signedOutByUser: boolean;
  signUp: (input: SignUpInput) => Promise<AuthError | null>;
  signIn: (login: string, password: string) => Promise<AuthError | null>;
  signInAsGuest: () => Promise<void>;
  signOut: () => void;
  updateProfile: (patch: Partial<Pick<Account, 'username' | 'company' | 'email' | 'avatar' | 'notifications'>>) => AuthError | null;
  changePassword: (current: string, next: string, confirm: string) => Promise<AuthError | null>;
  resetPassword: (email: string, next: string, confirm: string) => Promise<AuthError | null>;
  deleteAccount: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccountsState] = useState<Account[]>(() => load<Account[]>(ACCOUNTS_KEY, []));
  const [sessionId, setSessionId] = useState<string | null>(() => load<string | null>(SESSION_KEY, null));
  const [signedOutByUser, setSignedOutByUser] = useState(false);

  const setAccounts = useCallback((next: Account[]) => { setAccountsState(next); save(ACCOUNTS_KEY, next); }, []);
  const startSession = useCallback((id: string | null) => { setSessionId(id); save(SESSION_KEY, id); setSignedOutByUser(id === null); }, []);

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
      id: `U-${randomId()}`, email: email.trim(), username: username.trim(), company: company.trim(), avatar: '',
      notifications: { ...DEFAULT_NOTIFICATIONS }, createdAt: new Date().toISOString(), salt, passwordHash: await hashPassword(password, salt),
    };
    setAccounts([...accounts, account]);
    startSession(account.id);
    return null;
  }, [accounts, setAccounts, startSession]);

  const signIn = useCallback(async (login: string, password: string): Promise<AuthError | null> => {
    const key = login.trim().toLowerCase();
    const account = accounts.find(a => a.email.toLowerCase() === key || a.username.toLowerCase() === key);
    if (!account || (await hashPassword(password, account.salt)) !== account.passwordHash) return 'errSignIn';
    startSession(account.id);
    return null;
  }, [accounts, startSession]);

  const signInAsGuest = useCallback(async () => {
    const existing = accounts.find(a => a.email === DEMO_GUEST.email);
    if (existing) { startSession(existing.id); return; }
    const salt = randomId();
    const guest: Account = {
      id: `U-guest`, ...DEMO_GUEST, avatar: '', notifications: { ...DEFAULT_NOTIFICATIONS }, createdAt: new Date().toISOString(),
      salt, passwordHash: await hashPassword(randomId() + randomId(), salt),
    };
    setAccounts([...accounts, guest]);
    startSession(guest.id);
  }, [accounts, setAccounts, startSession]);

  const signOut = useCallback(() => startSession(null), [startSession]);

  const updateProfile = useCallback((patch: Partial<Pick<Account, 'username' | 'company' | 'email' | 'avatar' | 'notifications'>>): AuthError | null => {
    if (!current) return null;
    if (patch.email !== undefined) {
      if (!isValidEmail(patch.email)) return 'errEmail';
      if (accounts.some(a => a.id !== current.id && a.email.toLowerCase() === patch.email!.trim().toLowerCase())) return 'errEmailTaken';
    }
    if (patch.username !== undefined) {
      if (!isValidUsername(patch.username)) return 'errUsername';
      if (accounts.some(a => a.id !== current.id && a.username.toLowerCase() === patch.username!.trim().toLowerCase())) return 'errUsernameTaken';
    }
    if (patch.company !== undefined && !patch.company.trim()) return 'errCompany';
    const cleaned = {
      ...patch,
      ...(patch.email !== undefined ? { email: patch.email.trim() } : {}),
      ...(patch.username !== undefined ? { username: patch.username.trim() } : {}),
      ...(patch.company !== undefined ? { company: patch.company.trim() } : {}),
    };
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

  /** Demo stand-in for an emailed reset link: sets a new password for an existing account. */
  const resetPassword = useCallback(async (email: string, next: string, confirm: string): Promise<AuthError | null> => {
    const account = accounts.find(a => a.email.toLowerCase() === email.trim().toLowerCase());
    if (!account) return 'errNoAccount';
    if (!isValidPassword(next)) return 'errPasswordRules';
    if (next !== confirm) return 'errPasswordMatch';
    const salt = randomId() + randomId();
    const passwordHash = await hashPassword(next, salt);
    setAccounts(accounts.map(a => (a.id === account.id ? { ...a, salt, passwordHash } : a)));
    return null;
  }, [accounts, setAccounts]);

  const deleteAccount = useCallback(() => {
    if (!current) return;
    setAccounts(accounts.filter(a => a.id !== current.id));
    startSession(null);
  }, [accounts, current, setAccounts, startSession]);

  const value = useMemo(() => ({
    user, signedOutByUser, signUp, signIn, signInAsGuest, signOut, updateProfile, changePassword, resetPassword, deleteAccount,
  }), [user, signedOutByUser, signUp, signIn, signInAsGuest, signOut, updateProfile, changePassword, resetPassword, deleteAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
