import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Provide a working localStorage for Zustand persist middleware.
// Node 25 exposes a `localStorage` global but its methods are not callable
// as regular functions (broken binding), causing "storage.setItem is not a
// function". We detect this and replace with a working implementation.
// This also covers jsdom environments that inherit Node's broken localStorage.
{
  let needsPolyfill = false;
  try {
    localStorage.setItem('__vitest_probe__', '1');
    localStorage.removeItem('__vitest_probe__');
  } catch {
    needsPolyfill = true;
  }
  if (needsPolyfill) {
    const store: Record<string, string> = {};
    const impl = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
    } as Storage;
    globalThis.localStorage = impl;
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'localStorage', { value: impl, writable: true });
    }
  }
}

// Minimal window.electron mock so components that probe it during render
// don't crash under jsdom. Only added when `window` exists (jsdom env).
if (typeof window !== 'undefined') {
  const noop = (): void => {};
  // jsdom doesn't implement scrollIntoView; MessageList calls it in a useEffect.
  if (!('scrollIntoView' in Element.prototype)) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = noop;
  }
  (window as unknown as { electron: unknown }).electron = {
    fusion: {},
    ipcRenderer: {
      on: noop,
      removeListener: noop,
      removeAllListeners: noop,
      send: noop,
      invoke: async () => undefined,
    },
    dialog: {
      openFile: async () => ({ canceled: true }),
    },
  };
}

// Mock react-i18next so components can call t() without an I18nProvider.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
    i18n: { language: 'fr', changeLanguage: async () => undefined },
  }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
