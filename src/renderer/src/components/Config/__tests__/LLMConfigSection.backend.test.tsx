// @vitest-environment jsdom
/**
 * Changer de backend avec « embeddings cloud » coché change le service qui reçoit le corpus et le
 * modèle qui l'a indexé (S17-1-31) : Mistral → OpenAI passait de mistral-embed (1024 d) à
 * text-embedding-3-small (1536 d), Mistral → Claude revenait à Ollama, sans une question.
 *
 * Vraie section, vrai magasin de dialogues : la question se lit dans sa file, et la réponse passe
 * par `resolveConfirm`, comme le bouton du dialogue.
 */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
import { useDialogStore } from '../../../stores/dialogStore';

const INVALIDATES = 'embeddedEmbedding.providerChangeConfirm';
const CONSENT = 'llm.cloudEmbeddings.consent';

const initial: LLMConfig = {
  backend: 'mistral',
  ollamaURL: 'http://127.0.0.1:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  ollamaChatModel: 'llama3.2',
  // Les clés arrivent masquées du main : seule leur présence compte ici.
  claudeAPIKey: '••••',
  openaiAPIKey: '••••',
  mistralAPIKey: '••••',
  geminiAPIKey: '••••',
  useCloudEmbeddings: true,
};

let emitted: LLMConfig[];

const Harness: React.FC<{ start: LLMConfig }> = ({ start }) => {
  const [config, setConfig] = useState(start);
  return (
    <LLMConfigSection
      config={config}
      onChange={(next) => {
        emitted.push(next);
        setConfig(next);
      }}
      availableModels={[]}
      onRefreshModels={() => undefined}
    />
  );
};

/** Le sélecteur de backend : le premier `<select>` de la section. */
/** La section est repliée par défaut : on la déplie, comme l'auteur. */
function openSection(start: LLMConfig): void {
  render(<Harness start={start} />);
  fireEvent.click(screen.getByText('llm.title'));
}

function backendSelect(): HTMLSelectElement {
  const select = document.querySelector('select');
  if (!select) throw new Error('Pas de sélecteur de backend');
  return select;
}

function choose(backend: LLMConfig['backend']): void {
  fireEvent.change(backendSelect(), { target: { value: backend } });
}

/** Attend la question `message` en tête de file, puis y répond. */
async function answer(message: string, value: boolean): Promise<void> {
  await waitFor(() => {
    const head = useDialogStore.getState().queue[0];
    expect(head?.kind === 'confirm' ? head.message : undefined).toBe(message);
  });
  useDialogStore.getState().resolveConfirm(value);
}

function asked(): string[] {
  return useDialogStore.getState().queue.map((d) => d.message);
}

beforeEach(() => {
  emitted = [];
  useDialogStore.setState({ queue: [] });
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    ollama: { showModel: vi.fn(async () => ({ success: false })) },
  };
});

afterEach(() => {
  cleanup();
  useDialogStore.setState({ queue: [] });
});

describe('LLMConfigSection — changer de backend avec les embeddings cloud cochés', () => {
  it('Mistral → OpenAI : invalidation des index, puis consentement, avant tout changement', async () => {
    openSection(initial);
    choose('openai');

    await answer(INVALIDATES, true);
    expect(emitted).toEqual([]);
    await answer(CONSENT, true);

    await waitFor(() => expect(backendSelect().value).toBe('openai'));
    expect(emitted.at(-1)?.backend).toBe('openai');
  });

  it('refus de l’invalidation : le backend reste Mistral, sans autre question', async () => {
    openSection(initial);
    choose('openai');

    await answer(INVALIDATES, false);

    await waitFor(() => expect(useDialogStore.getState().queue).toEqual([]));
    expect(emitted).toEqual([]);
    expect(backendSelect().value).toBe('mistral');
  });

  it('refus du consentement : le backend reste Mistral', async () => {
    openSection(initial);
    choose('openai');

    await answer(INVALIDATES, true);
    await answer(CONSENT, false);

    await waitFor(() => expect(useDialogStore.getState().queue).toEqual([]));
    expect(emitted).toEqual([]);
    expect(backendSelect().value).toBe('mistral');
  });

  it('Mistral → Claude : retour aux embeddings locaux, seule l’invalidation est demandée', async () => {
    openSection(initial);
    choose('claude');

    await answer(INVALIDATES, true);

    await waitFor(() => expect(backendSelect().value).toBe('claude'));
    expect(asked()).toEqual([]);
    expect(emitted.at(-1)?.backend).toBe('claude');
  });

  it('Claude → Ollama, case cochée mais embeddings déjà locaux : aucune question', async () => {
    openSection({ ...initial, backend: 'claude' });
    choose('ollama');

    await waitFor(() => expect(backendSelect().value).toBe('ollama'));
    expect(asked()).toEqual([]);
  });

  it('case décochée : aucune question, le backend change aussitôt', async () => {
    openSection({ ...initial, useCloudEmbeddings: false });
    choose('openai');

    await waitFor(() => expect(backendSelect().value).toBe('openai'));
    expect(asked()).toEqual([]);
    expect(emitted.at(-1)?.backend).toBe('openai');
  });
});
