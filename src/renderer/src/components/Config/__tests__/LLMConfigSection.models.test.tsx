// @vitest-environment jsdom
/**
 * Les modèles que les Réglages proposent pour un backend en ligne doivent être servis : l'historien
 * qui laissait le champ vide ou suivait un exemple obtenait une erreur à chaque tour (S05-2-0,
 * S05-2-2). Le texte grisé du champ dit ce qu'un champ vide vaut : il suit la valeur par défaut de
 * l'adaptateur, celle qui part réellement au fournisseur.
 *
 * Identifiants fermés relevés le 2026-11-13 sur les pages de dépréciation de Google
 * (aistudio.google.com/docs/deprecations) et d'OpenAI (developers.openai.com/api/docs/deprecations).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr', changeLanguage: async () => undefined } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { LLMConfigSection } from '../LLMConfigSection';
import type { LLMConfig } from '../ConfigPanel';
import { resolveActiveChatModel } from '../../../../../../backend/core/llm/providers/cliodeck-config-adapter';

const CLOSED = [
  // Gemini : fermés le 1er juin 2026 ; les 1.5 ne figurent plus sur la page.
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  // OpenAI : o1-mini fermé le 27 octobre 2025, les autres le 23 octobre 2026.
  'o1-mini',
  'o1',
  'o3-mini',
  'o4-mini',
  'gpt-4-turbo',
];

/**
 * Modèles d'OpenAI dont l'appel d'outils est refusé en Chat Completions, l'API que parle
 * `OpenAICompatibleProvider`, sous l'effort de raisonnement par défaut (`medium`) : le fournisseur
 * joint les outils MCP dès qu'un serveur est prêt, et chaque tour serait refusé. Source :
 * developers.openai.com/api/docs/guides/latest-model, lue le 2026-11-13 : « GPT-6 Sol and GPT-6
 * Luna support function calling in Chat Completions only with `reasoning_effort: "none"` », et
 * « GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires
 * Responses ». Tant que ce cas n'est pas traité, aucun exemple ne doit y mener.
 */
const TOOLS_REFUSED_IN_CHAT_COMPLETIONS = [
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
];

const base: LLMConfig = {
  backend: 'ollama',
  ollamaURL: 'http://127.0.0.1:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  ollamaChatModel: 'llama3.2',
  openaiAPIKey: '••••',
  geminiAPIKey: '••••',
};

/** Le champ du modèle du backend, son texte grisé et les exemples écrits sous lui. */
function modelField(backend: 'openai' | 'gemini'): { placeholder: string; examples: string[] } {
  render(
    <LLMConfigSection
      config={{ ...base, backend }}
      onChange={() => undefined}
      availableModels={[]}
      onRefreshModels={() => undefined}
    />
  );
  fireEvent.click(screen.getByText('llm.title'));
  const field = screen.getByText(`llm.model.${backend}`).closest('.config-field');
  const input = field?.querySelector('input');
  if (!field || !input) throw new Error(`Pas de champ de modèle pour ${backend}`);
  return {
    placeholder: input.placeholder,
    examples: Array.from(field.querySelectorAll('code')).map((c) => c.textContent ?? ''),
  };
}

afterEach(() => {
  cleanup();
});

describe('LLMConfigSection — modèles proposés pour les backends en ligne', () => {
  for (const backend of ['openai', 'gemini'] as const) {
    it(`${backend} : aucun identifiant fermé, ni en exemple ni dans le champ vide`, () => {
      const { placeholder, examples } = modelField(backend);
      expect(examples.length).toBeGreaterThan(0);
      expect([placeholder, ...examples].filter((id) => CLOSED.includes(id))).toEqual([]);
    });

    it(`${backend} : le champ vide annonce le modèle que l’adaptateur envoie`, () => {
      const { placeholder } = modelField(backend);
      expect(placeholder).toBe(resolveActiveChatModel({ ...base, backend }));
    });
  }

  it('openai : aucun exemple dont l’appel d’outils est refusé en Chat Completions', () => {
    const { placeholder, examples } = modelField('openai');
    expect(
      [placeholder, ...examples].filter((id) => TOOLS_REFUSED_IN_CHAT_COMPLETIONS.includes(id))
    ).toEqual([]);
  });
});
