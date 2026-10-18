import '@testing-library/jest-dom';

// jsdom does not implement scrolling.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

// Mock localStorage for jsdom environment
if (!window.localStorage) {
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
