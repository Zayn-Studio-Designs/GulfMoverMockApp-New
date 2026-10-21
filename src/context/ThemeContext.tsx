import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Appearance preference for the whole app: Light, Dark, or System (follow the OS/device setting).
 * Stored in localStorage under 'gm-theme' alongside the other demo preferences, and applied to
 * <html data-theme> so every surface — navigation, pages, forms, dialogs, Wallet screens, the
 * guided tour — inherits one coherent palette. In System mode an OS theme change is followed live.
 *
 * The color scheme is also set before first paint by a small pre-paint script in index.html,
 * so a dark-mode visitor never sees a light flash while the bundle loads.
 */

export type ThemePref = 'light' | 'dark' | 'system';
export type EffectiveTheme = Exclude<ThemePref, 'system'>;

export const THEME_KEY = 'gm-theme';

/** Reads the stored preference, tolerating missing localStorage or unknown values. */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function persistThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage unavailable (private mode): the theme still applies for this session.
  }
}

/** OS-level dark preference; safe where matchMedia does not exist (jsdom, very old engines). */
export function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Applies the effective theme to a document root (same document as <html>). */
export function applyThemeToDocument(pref: ThemePref, doc: Document) {
  const effective = resolveEffectiveTheme(pref);
  doc.documentElement.dataset.theme = effective;
  (doc.documentElement.style as CSSStyleDeclaration).colorScheme = effective;
  return effective;
}

/** Resolves a preference to the concrete theme actually shown right now. */
export function resolveEffectiveTheme(pref: ThemePref): EffectiveTheme {
  return pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref;
}

interface ThemeContextValue {
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
  /** The theme actually used right now ('system' resolved to light or dark). */
  effective: EffectiveTheme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    persistThemePref(next);
  }, []);

  const effective: EffectiveTheme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  // Apply on every change; documentElement is shared with the pre-paint script.
  useEffect(() => { applyThemeToDocument(pref, document); }, [pref, systemDark]);

  // In System / Auto mode, follow OS theme changes live.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [pref]);

  const value = useMemo(() => ({ pref, setPref, effective }), [pref, setPref, effective]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
