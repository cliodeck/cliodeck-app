/**
 * Cloud consent store (ADR 0005, Phase 4.3).
 *
 * Tracks whether the user has acknowledged that their data will leave
 * localhost during this session. Resets on app reload (session-scoped).
 *
 * A provider is "cloud" if:
 * - backend is 'claude' | 'openai' | 'mistral' | 'gemini', OR
 * - backend is 'ollama' but the URL is not localhost/127.0.0.1
 */

import { create } from 'zustand';

interface CloudConsentState {
  /** Whether user has consented to cloud usage this session. */
  consented: boolean;
  /** The provider description shown to the user when they consented. */
  consentedProvider: string | null;
  /** Grant consent for this session. */
  grant: (provider: string) => void;
  /** Revoke consent (e.g., on config change). */
  revoke: () => void;
}

export const useCloudConsentStore = create<CloudConsentState>((set) => ({
  consented: false,
  consentedProvider: null,
  grant: (provider: string) => set({ consented: true, consentedProvider: provider }),
  revoke: () => set({ consented: false, consentedProvider: null }),
}));

const LOCALHOST_PATTERNS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
];

export function isCloudProvider(config: {
  backend: string;
  ollamaURL?: string;
}): { isCloud: boolean; providerName: string } {
  const { backend, ollamaURL } = config;

  if (backend === 'claude') return { isCloud: true, providerName: 'Anthropic Claude' };
  if (backend === 'openai') return { isCloud: true, providerName: 'OpenAI' };
  if (backend === 'mistral') return { isCloud: true, providerName: 'Mistral AI' };
  if (backend === 'gemini') return { isCloud: true, providerName: 'Google Gemini' };

  if (backend === 'ollama' && ollamaURL) {
    try {
      const url = new URL(ollamaURL);
      const host = url.hostname.toLowerCase();
      const isLocal = LOCALHOST_PATTERNS.some((p) => host === p);
      if (!isLocal) {
        return { isCloud: true, providerName: `Ollama (${url.hostname})` };
      }
    } catch {
      // Malformed URL — assume local
    }
  }

  return { isCloud: false, providerName: 'local' };
}
