import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  applyThemeToDocument,
  readThemePref,
  persistThemePref,
  resolveEffectiveTheme,
  THEME_KEY,
  ThemeProvider,
  useTheme,
} from '../context/ThemeContext';
import { BOOT_TIMELINE, bootProgressPct } from '../presentation/BootOverlay';

describe('theme preference', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.dataset.theme = ''; });
  afterEach(() => cleanup());

  test('defaults to system when nothing is stored', () => {
    expect(readThemePref()).toBe('system');
  });

  test('stores and reads each preference', () => {
    persistThemePref('dark');
    expect(readThemePref()).toBe('dark');
    persistThemePref('light');
    expect(readThemePref()).toBe('light');
    persistThemePref('system');
    expect(readThemePref()).toBe('system');
  });

  test('invalid stored values fall back to system', () => {
    localStorage.setItem(THEME_KEY, 'blue');
    expect(readThemePref()).toBe('system');
  });

  test('light and dark prefs resolve themselves; system resolves via matchMedia', () => {
    expect(resolveEffectiveTheme('dark')).toBe('dark');
    expect(resolveEffectiveTheme('light')).toBe('light');
    // jsdom reports no dark preference unless mocked, so System resolves to light here.
    expect(resolveEffectiveTheme('system')).toBe('light');
  });

  test('applyThemeToDocument writes data-theme and colorScheme', () => {
    applyThemeToDocument('dark', document);
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyThemeToDocument('light', document);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  test('provider applies the stored preference on mount and updates the document live', () => {
    localStorage.setItem(THEME_KEY, 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(result.current.effective).toBe('dark');

    act(() => result.current.setPref('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(result.current.effective).toBe('light');
  });

  test('System / Auto mode follows a live OS theme change', () => {
    const listeners: Array<() => void> = [];
    const mq = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    };
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => mq));
    document.documentElement.dataset.theme = '';

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    // Default pref is system; system sees light.
    expect(result.current.effective).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    act(() => { mq.matches = true; listeners.forEach(fn => fn()); });
    expect(result.current.effective).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    // Explicit Light stops following the OS.
    act(() => result.current.setPref('light'));
    act(() => { mq.matches = false; listeners.forEach(fn => fn()); });
    expect(result.current.effective).toBe('light');

    vi.unstubAllGlobals();
  });
});

describe('boot progress timeline', () => {
  test('horn and visual progress start on the same beat', () => {
    expect(BOOT_TIMELINE.hornAt).toBe(BOOT_TIMELINE.progressIn);
    expect(BOOT_TIMELINE.progressIn).toBeLessThanOrEqual(BOOT_TIMELINE.logoIn + 40); // opening beat, not a mid-run flourish
  });

  test('progress is deterministic, monotonic and capped', () => {
    const done = 1400;
    let last = -1;
    for (let ms = 0; ms <= 2000; ms += 25) {
      const pct = bootProgressPct(ms, done);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
      expect(pct).toBeGreaterThanOrEqual(last);
      last = pct;
    }
    expect(bootProgressPct(0, done)).toBe(0);
    expect(bootProgressPct(1_000_000, done)).toBe(100);
  });
});
