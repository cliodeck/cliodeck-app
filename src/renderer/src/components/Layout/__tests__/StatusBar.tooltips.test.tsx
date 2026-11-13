// @vitest-environment jsdom
/**
 * Les infobulles des indicateurs MCP et Vault s'accordent au nombre, en fr, en et de.
 *
 * Invisibles jusqu'à L09-2b (S17-1-10), elles n'avaient qu'une forme : « Vault : 1 notes »,
 * « Vault : 0 notes », « Vault: 1 Notizen », « MCP : 1/2 prêts ». En français, 0 et 1 prennent le
 * singulier. Vraie barre, vraies locales : le simulacre commun rend la clé seule, et ne verrait pas
 * qu'une forme manque.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { StatusBar } from '../StatusBar';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

const electron = () => (window as unknown as { electron: { fusion?: unknown } }).electron;
let fusionBefore: unknown;

/** La barre d'un projet dont le vault compte `noteCount` notes, et dont `ready` serveurs MCP sur `total` répondent. */
async function mountBar(noteCount: number, ready: number, total: number): Promise<void> {
  const clients = Array.from({ length: total }, (_, i) => ({
    name: `serveur-${i}`,
    state: i < ready ? 'ready' : 'failed',
  }));
  electron().fusion = {
    mcp: { list: vi.fn(async () => ({ success: true, clients })), onEvent: () => () => undefined },
    vault: {
      status: vi.fn(async () => ({
        success: true,
        indexed: noteCount > 0,
        noteCount,
        dbPath: '/p/.cliodeck/brain.db',
        vaultPath: '/Volumes/Notes',
      })),
    },
  };
  await act(async () => {
    render(<StatusBar />);
  });
}

async function tooltipOf(label: RegExp): Promise<string | null> {
  const item = await waitFor(() => {
    const found = screen.queryByText(label);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return item.getAttribute('title');
}

beforeEach(() => {
  fusionBefore = electron().fusion;
  useEditorStore.setState({ filePath: null, isDirty: false, lastSavedAt: null });
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: '/p',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
});

afterEach(async () => {
  cleanup();
  electron().fusion = fusionBefore;
  useProjectStore.setState({ currentProject: null });
  await h.i18n?.changeLanguage('fr');
});

describe('StatusBar : l’infobulle du vault s’accorde au nombre de notes', () => {
  it.each<[string, number, string]>([
    ['fr', 0, 'Vault : 0 note'],
    ['fr', 1, 'Vault : 1 note'],
    ['fr', 12, 'Vault : 12 notes'],
    ['en', 0, 'Vault: 0 notes'],
    ['en', 1, 'Vault: 1 note'],
    ['en', 12, 'Vault: 12 notes'],
    ['de', 0, 'Vault: 0 Notizen'],
    ['de', 1, 'Vault: 1 Notiz'],
    ['de', 12, 'Vault: 12 Notizen'],
  ])('%s, %i note(s) : « %s »', async (lang, noteCount, expected) => {
    await h.i18n?.changeLanguage(lang);
    await mountBar(noteCount, 1, 1);

    expect(await tooltipOf(/^Vault \d+$/)).toBe(expected);
  });
});

describe('StatusBar : l’infobulle MCP s’accorde au nombre de serveurs prêts', () => {
  it.each<[string, number, number, string]>([
    ['fr', 0, 1, 'MCP : 0/1 prêt'],
    ['fr', 1, 2, 'MCP : 1/2 prêt'],
    ['fr', 2, 2, 'MCP : 2/2 prêts'],
    ['en', 1, 2, 'MCP: 1/2 ready'],
    ['en', 2, 2, 'MCP: 2/2 ready'],
    ['de', 1, 2, 'MCP: 1/2 bereit'],
    ['de', 2, 2, 'MCP: 2/2 bereit'],
  ])('%s, %i/%i : « %s »', async (lang, ready, total, expected) => {
    await h.i18n?.changeLanguage(lang);
    await mountBar(0, ready, total);

    expect(await tooltipOf(/^MCP \d+\/\d+$/)).toBe(expected);
  });
});
