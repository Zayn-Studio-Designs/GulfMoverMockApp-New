import '@testing-library/jest-dom';

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
