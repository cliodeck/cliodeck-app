// @vitest-environment jsdom
/**
 * Une synchronisation Zotero refusée parce que le `.bib` ou les métadonnées sont mal lus : le
 * message nomme les entrées en cause et dit comment les corriger (S07-1-2, Q21, A22).
 *
 * Tout échec s'affichait par « La synchronisation a échoué : {{error}} », avec le texte brut de
 * l'erreur : un code comme `bib-unread` ne doit pas s'afficher tel quel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import i18next from 'i18next';

import { ZoteroImport } from '../ZoteroImport';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../public/locales');
const A = '/projets/A';
let synchronize: ReturnType<typeof vi.fn>;
let loadWithMetadata: ReturnType<typeof vi.fn>;
const dialogs = () => useDialogStore.getState();

async function synchronizeWith(response: unknown): Promise<string> {
  synchronize.mockResolvedValueOnce(response);
  useProjectStore.setState({
    currentProject: { id: A, name: 'A', path: A, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  } as never);
  render(<ZoteroImport />);
  await act(async () => undefined);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /zotero\.sync\.button/ }));
  });
  expect(dialogs().alertOpen).toBe(true);
  return dialogs().alertMessage;
}

beforeEach(() => {
  useProjectStore.setState({ loadState: { kind: 'idle' } } as never);
  synchronize = vi.fn();
  loadWithMetadata = vi.fn(async () => undefined);
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero' })) },
    project: { getConfig: vi.fn(async () => ({ zotero: { collectionKey: 'CA' } })) },
    zotero: {
      listLibraries: vi.fn(async () => ({ success: true, libraries: [] })),
      listCollections: vi.fn(async () => ({ success: true, collections: [] })),
      synchronize,
    },
  };
  useBibliographyStore.setState({ loadBibliographyWithMetadata: loadWithMetadata } as never);
});

afterEach(() => {
  cleanup();
  while (dialogs().queue.length > 0) {
    if (dialogs().confirmOpen) dialogs().resolveConfirm(false);
    else dialogs().closeAlert();
  }
});

describe('synchronisation refusée : le message, pas le code', () => {
  it('entrées non lues : les clés sont nommées, et la correction dite', async () => {
    const message = await synchronizeWith({
      success: false,
      error: 'bib-unread',
      file: 'ma-biblio.bib',
      unreadKeys: ['entretien_dupont', 'carton_AN_F7_1234'],
    });

    expect(message).toContain('zotero.sync.refused');
    expect(message).toContain('zotero.sync.unreadEntries');
    expect(message).toContain('@entretien_dupont');
    expect(message).toContain('@carton_AN_F7_1234');
    expect(message).toContain('zotero.sync.fixThenRetry');
    expect(message).not.toContain('bib-unread');
    expect(message).not.toContain('zotero.sync.error');
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('entrées venues de Zotero : le message dit de les corriger sans les supprimer', async () => {
    const message = await synchronizeWith({
      success: false,
      error: 'bib-unread',
      file: 'ma-biblio.bib',
      unreadKeys: ['entretien_dupont', 'Odd_2021'],
      unreadFromZotero: ['Odd_2021'],
    });

    expect(message).toContain('zotero.sync.unreadEntries');
    expect(message).toContain('zotero.sync.unreadFromZotero');
    expect(message.indexOf('zotero.sync.unreadFromZotero')).toBeLessThan(message.indexOf('zotero.sync.fixThenRetry'));
  });

  it('témoin : aucune entrée venue de Zotero, pas de conseil Zotero', async () => {
    const message = await synchronizeWith({
      success: false,
      error: 'bib-unread',
      file: 'b.bib',
      unreadKeys: ['entretien_dupont'],
      unreadFromZotero: [],
    });

    expect(message).not.toContain('zotero.sync.unreadFromZotero');
  });

  it('beaucoup d’entrées : les premières, puis « et N autres »', async () => {
    const unreadKeys = Array.from({ length: 30 }, (_, i) => `e${i + 1}`);
    const message = await synchronizeWith({ success: false, error: 'bib-unread', file: 'b.bib', unreadKeys });

    expect(message).toContain('@e8');
    expect(message).not.toContain('@e9\n');
    expect(message).toContain('zotero.sync.more');
  });

  it('pas en UTF-8 : le message dit d’enregistrer en UTF-8', async () => {
    const message = await synchronizeWith({ success: false, error: 'bib-unreadable', file: 'b.bib', reason: 'encoding', detail: 'x' });

    expect(message).toContain('bibliography.bibNotUtf8');
    expect(message).not.toContain('bib-unreadable');
  });

  it('autre illisibilité : le message générique', async () => {
    const message = await synchronizeWith({ success: false, error: 'bib-unreadable', file: 'b.bib', reason: 'permission', detail: 'EACCES' });

    expect(message).toContain('bibliography.bibUnreadable');
  });

  it('métadonnées illisibles', async () => {
    const message = await synchronizeWith({
      success: false,
      error: 'metadata-unreadable',
      file: '.cliodeck/bibliography-metadata.json',
    });

    expect(message).toContain('zotero.sync.metadataUnreadable');
    expect(message).not.toContain('metadata-unreadable');
  });

  it('témoin : un autre échec garde le message d’échec', async () => {
    const message = await synchronizeWith({ success: false, error: 'connexion refusée' });

    expect(message).toBe('zotero.sync.error');
  });
});

/**
 * Une définition `@string(…)` entre parenthèses ne se lit pas : l'audit la nomme `@string` dans la
 * liste des entrées non lues. Le conseil de cette liste doit valoir pour elle aussi, dans les
 * trois langues, au panneau comme à la synchronisation : « ajoutez un titre » et « refermez une
 * accolade » ne la corrigent pas.
 */
describe('le conseil des entrées non lues vaut pour une définition @string entre parenthèses', () => {
  const locales = ['fr', 'en', 'de'] as const;
  const messages = (lng: (typeof locales)[number]) => {
    const common = JSON.parse(readFileSync(path.join(LOCALES_DIR, lng, 'common.json'), 'utf-8')) as {
      bibliography: { unreadEntries: string };
      zotero: { sync: { unreadEntries: string } };
    };
    return [common.bibliography.unreadEntries, common.zotero.sync.unreadEntries];
  };

  it.each(locales)('%s : les deux messages disent d’écrire @string{…}', (lng) => {
    for (const message of messages(lng)) expect(message).toContain('@string{AN = {…}}');
  });

  it('i18next rend l’exemple tel quel, et interpole le reste', async () => {
    const fr = JSON.parse(readFileSync(path.join(LOCALES_DIR, 'fr', 'common.json'), 'utf-8')) as Record<string, unknown>;
    const instance = i18next.createInstance();
    await instance.init({ lng: 'fr', ns: ['common'], defaultNS: 'common', resources: { fr: { common: fr } }, interpolation: { escapeValue: false } });

    for (const key of ['zotero.sync.unreadEntries', 'bibliography.unreadEntries']) {
      const text = instance.t(key, { count: 2, file: 'ma-biblio.bib' });
      expect(text).toContain('@string{AN = {…}}, et non @string(AN = …).');
      expect(text).toContain('2 entrée(s) de ma-biblio.bib');
    }
  });
});
