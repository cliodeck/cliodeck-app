import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

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
