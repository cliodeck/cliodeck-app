// @vitest-environment jsdom
/**
 * « Synchroniser avec Zotero » alors que le `.bib` que `project.json` nomme n'est plus là (H3).
 *
 * Le main refuse sans rien écrire. Le panneau doit le montrer comme à l'ouverture d'un projet dont
 * le `.bib` manque : le bandeau « introuvable », et plus la liste d'un fichier qui n'existe plus.
 * Sans traitement, le refus finissait en « La synchronisation a échoué : bib-missing ».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../CitationList', () => ({
  CitationList: ({ citations }: { citations: Array<{ id: string }> }) => <div>liste : {citations.map((c) => c.id).join(', ')}</div>,
}));
vi.mock('../BibliographyStats', () => ({ BibliographyStats: () => null }));
vi.mock('../OrphanPDFModal', () => ({ OrphanPDFModal: () => null }));
vi.mock('../TagManager', () => ({ TagFilter: () => null }));
vi.mock('../PDFModificationNotification', () => ({
  PDFModificationNotification: () => null,
  usePDFModificationDetection: () => ({
    modifiedPDFs: [],
    acknowledge: async () => undefined,
    dismissNotification: () => undefined,
  }),
}));
vi.mock('../BibImportSummaryModal', () => ({ BibImportSummaryModal: () => null }));

import { BibliographyPanel } from '../BibliographyPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const PROJECT = '/projets/these';
const BIB = `${PROJECT}/ma-biblio.bib`;
const citation = (id: string) => ({ id, type: 'book', author: 'Garde', year: '2000', title: id });
const dialogs = () => useDialogStore.getState();
const banner = () => screen.queryByRole('alert');

let synchronize: ReturnType<typeof vi.fn>;
let loadWithMetadata: ReturnType<typeof vi.fn>;

beforeEach(() => {
  synchronize = vi.fn(async () => ({ success: false, error: 'bib-missing', file: 'ma-biblio.bib', bibtexPath: BIB }));
  // Ce que rend le vrai handler pour un `.bib` absent (`bibliographyLoadFailure`).
  loadWithMetadata = vi.fn(async () => ({ success: false, error: 'ma-biblio.bib est introuvable', citations: [], problem: 'missing' }));
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero' })) },
    project: { getConfig: vi.fn(async () => ({ zotero: { collectionKey: 'COLL' } })) },
    zotero: {
      listLibraries: vi.fn(async () => ({ success: true, libraries: [] })),
      listCollections: vi.fn(async () => ({ success: true, collections: [] })),
      synchronize,
    },
    bibliography: { loadWithMetadata },
  };
  useProjectStore.setState({
    loadState: { kind: 'idle' },
    currentProject: { id: 'p1', name: 'Thèse', path: PROJECT, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  } as never);
  // Le panneau montre encore la liste lue à l'ouverture : le fichier a disparu depuis.
  useBibliographyStore.setState({
    citations: [citation('Garde_2000')],
    filteredCitations: [citation('Garde_2000')],
    bibliographyProblem: null,
    refreshIndexedPDFs: vi.fn(async () => undefined),
    loadReadingNotes: vi.fn(async () => undefined),
  } as never);
});

afterEach(() => {
  cleanup();
  useBibliographyStore.setState({ bibliographyProblem: null, citations: [], filteredCitations: [] } as never);
  while (dialogs().queue.length > 0) {
    if (dialogs().confirmOpen) dialogs().resolveConfirm(false);
    else dialogs().closeAlert();
  }
});

describe('synchronisation refusée parce que le .bib est introuvable', () => {
  it('le bandeau « introuvable » s’affiche, la liste du fichier disparu aussi, et pas d’échec générique', async () => {
    await act(async () => {
      render(<BibliographyPanel />);
    });
    expect(screen.getByText('liste : Garde_2000')).toBeInTheDocument();
    expect(banner()).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /zotero\.sync\.button/ }));
    });

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(loadWithMetadata).toHaveBeenCalledWith({ filePath: BIB, projectPath: PROJECT });
    expect(banner()).toHaveTextContent('bibliography.bibMissing');
    expect(screen.queryByText('liste : Garde_2000')).toBeNull();
    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertMessage).toContain('zotero.sync.refused');
    expect(dialogs().alertMessage).not.toContain('zotero.sync.error');
  });
});
