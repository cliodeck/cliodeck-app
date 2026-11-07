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

import { ZoteroImport } from '../ZoteroImport';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

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
      hasStringMacros: false,
    });

    expect(message).toContain('zotero.sync.refused');
    expect(message).toContain('zotero.sync.unreadEntries');
    expect(message).toContain('@entretien_dupont');
    expect(message).toContain('@carton_AN_F7_1234');
    expect(message).toContain('zotero.sync.fixThenRetry');
    expect(message).not.toContain('bib-unread');
    expect(message).not.toContain('zotero.sync.error');
    expect(message).not.toContain('zotero.sync.stringMacros');
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('beaucoup d’entrées : les premières, puis « et N autres »', async () => {
    const unreadKeys = Array.from({ length: 30 }, (_, i) => `e${i + 1}`);
    const message = await synchronizeWith({ success: false, error: 'bib-unread', file: 'b.bib', unreadKeys, hasStringMacros: false });

    expect(message).toContain('@e8');
    expect(message).not.toContain('@e9\n');
    expect(message).toContain('zotero.sync.more');
  });

  it('@string : la définition à remplacer est dite', async () => {
    const message = await synchronizeWith({ success: false, error: 'bib-unread', file: 'b.bib', unreadKeys: [], hasStringMacros: true });

    expect(message).toContain('zotero.sync.stringMacros');
    expect(message).not.toContain('zotero.sync.unreadEntries');
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
