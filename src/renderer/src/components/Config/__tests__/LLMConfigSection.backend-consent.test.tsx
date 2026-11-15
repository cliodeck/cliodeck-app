// @vitest-environment jsdom
/**
 * Le consentement demandé au changement de backend parle de ce changement (E4).
 *
 * Changer de backend avec « Utiliser aussi ce fournisseur pour les embeddings » coché change le
 * service qui reçoit le corpus (S17-1-31). La question reprenait le texte de la case, qui commence
 * par « Activer cette option… » : l'historien n'activait rien, il changeait de backend. Elle nomme
 * maintenant le changement et le fournisseur qui recevra le corpus ; la case garde son texte.
 *
 * Vraie section, vrai magasin de dialogues, vraies locales (fr, en, de).
 */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { i18n as I18n } from 'i18next';

const h = vi.hoisted(() => ({ i18n: null as I18n | null }));

vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const fr = (await import('../../../../../../public/locales/fr/common.json')).default;
  const en = (await import('../../../../../../public/locales/en/common.json')).default;
  const de = (await import('../../../../../../public/locales/de/common.json')).default;
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr }, en: { common: en }, de: { common: de } },
    interpolation: { escapeValue: false },
  });
  h.i18n = instance;
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { LLMConfigSection } from '../LLMConfigSection';
import type { LLMConfig } from '../ConfigPanel';
import { useDialogStore } from '../../../stores/dialogStore';

const initial: LLMConfig = {
  backend: 'mistral',
  ollamaURL: 'http://127.0.0.1:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  ollamaChatModel: 'llama3.2',
  claudeAPIKey: '••••',
  openaiAPIKey: '••••',
  mistralAPIKey: '••••',
  geminiAPIKey: '••••',
  useCloudEmbeddings: true,
};

const Harness: React.FC<{ start: LLMConfig }> = ({ start }) => {
  const [config, setConfig] = useState(start);
  return (
    <LLMConfigSection
      config={config}
      onChange={setConfig}
      availableModels={[]}
      onRefreshModels={() => undefined}
    />
  );
};

const t = (key: string): string => h.i18n!.t(key);

/** La question en tête de file, une fois posée. */
async function asked(): Promise<string> {
  let message = '';
  await waitFor(() => {
    const head = useDialogStore.getState().queue[0];
    expect(head?.kind).toBe('confirm');
    message = head?.message ?? '';
  });
  return message;
}

async function inLanguage(lng: 'fr' | 'en' | 'de'): Promise<void> {
  await act(async () => {
    await h.i18n?.changeLanguage(lng);
  });
}

beforeEach(() => {
  useDialogStore.setState({ queue: [] });
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = { ...w.electron, ollama: { showModel: vi.fn(async () => ({ success: false })) } };
});

afterEach(async () => {
  cleanup();
  useDialogStore.setState({ queue: [] });
  await h.i18n?.changeLanguage('fr');
});

describe('LLMConfigSection — le consentement du changement de backend (E4)', () => {
  it.each([
    ['fr', 'Passer à OpenAI (API en ligne)', 'Activer cette option'],
    ['en', 'Switching to OpenAI (cloud API)', 'Turning this on'],
    ['de', 'Der Wechsel zu OpenAI (Cloud-API)', 'Wird diese Option aktiviert'],
  ] as const)('%s : Mistral → OpenAI, la question nomme le changement et le fournisseur', async (lng, start, checkbox) => {
    await inLanguage(lng);
    render(<Harness start={initial} />);
    fireEvent.click(screen.getByText(t('llm.title')));
    fireEvent.change(document.querySelector('select') as HTMLSelectElement, { target: { value: 'openai' } });

    // D'abord l'invalidation des index, inchangée.
    expect(await asked()).toBe(t('embeddedEmbedding.providerChangeConfirm'));
    useDialogStore.getState().resolveConfirm(true);

    await waitFor(() => expect(useDialogStore.getState().queue[0]?.message).not.toBe(t('embeddedEmbedding.providerChangeConfirm')));
    const consent = await asked();
    expect(consent.startsWith(start)).toBe(true);
    expect(consent).not.toContain(checkbox);
    expect(consent).not.toBe(t('llm.cloudEmbeddings.consent'));
    useDialogStore.getState().resolveConfirm(true);
    await waitFor(() => expect((document.querySelector('select') as HTMLSelectElement).value).toBe('openai'));
  });

  it('témoin : la case garde son texte, « Activer cette option… »', async () => {
    render(<Harness start={{ ...initial, useCloudEmbeddings: false }} />);
    fireEvent.click(screen.getByText(t('llm.title')));
    // La seule case de la section avec un backend en ligne : celle des embeddings.
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(1);
    fireEvent.click(boxes[0]);
    const consent = await asked();
    expect(consent).toBe(t('llm.cloudEmbeddings.consent'));
    expect(consent.startsWith('Activer cette option')).toBe(true);
  });
});
