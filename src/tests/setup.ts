import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Pin the unit/component suite to demo mode. A developer's ignored production
// `.env.local` would otherwise flip ~80 tests into production paths (missing
// Supabase config, different auth flows) and fail. The direct `process.env`
// assignment runs first so that `vi.unstubAllEnvs()` inside individual tests
// restores *demo* (not the developer's production `.env.local`); the
// `vi.stubEnv` calls additionally propagate the default into
// `import.meta.env`. Tests that exercise production configuration inject
// `EnvSource` explicitly or call `vi.stubEnv` themselves, and per-test stubs
// take precedence over this file-level default.
process.env.VITE_APP_MODE = 'demo';
process.env.VITE_AUTH_RESET_REDIRECT_URL = '';
vi.stubEnv('VITE_APP_MODE', 'demo');
vi.stubEnv('VITE_AUTH_RESET_REDIRECT_URL', '');

// Node-environment files (the local Supabase integration suite) have no DOM to patch.
const hasDom = typeof window !== 'undefined';

// jsdom does not implement scrolling.
if (hasDom) {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
}

// Mock localStorage for jsdom environment
if (hasDom && !window.localStorage) {
  const localStorageMock = (function () {
    let store: Record<string, string> = {};
    return {
      getItem: function (key: string) {
        return store[key] || null;
      },
      setItem: function (key: string, value: string) {
        store[key] = value;
      },
      removeItem: function (key: string) {
        delete store[key];
      },
      clear: function () {
        store = {};
      }
    };
  })();

  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true
  });
}
