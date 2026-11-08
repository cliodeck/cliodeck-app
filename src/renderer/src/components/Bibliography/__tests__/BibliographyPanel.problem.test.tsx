// @vitest-environment jsdom
/**
 * Le `.bib` du projet ne se lit pas, ou pas en entier : le panneau le dit (S07-1-11, S07-1-2).
 *
 * Absent ou illisible, il s'affichait comme une bibliographie vide (« Importez un fichier BibTeX
 * pour commencer »), et l'import suivant remplaçait sans rien proposer, au risque d'écraser un
 * fichier de même nom. Des entrées non lues, elles, n'apparaissaient nulle part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../CitationList', () => ({
  CitationList: ({ citations }: { citations: Array<{ id: string }> }) => <div>liste : {citations.map((c) => c.id).join(', ')}</div>,
}));
vi.mock('../ZoteroImport', () => ({ ZoteroImport: () => null }));
vi.mock('../BibliographyStats', () => ({ BibliographyStats: () => null }));
vi.mock('../OrphanPDFModal', () => ({ OrphanPDFModal: () => null }));
vi.mock('../TagManager', () => ({ TagFilter: () => null }));
vi.mock('../PDFModificationNotification', () => ({
  PDFModificationNotification: () => null,
  usePDFModificationDetection: () => ({ modifiedPDFs: [], dismissNotification: () => undefined }),
}));
vi.mock('../BibImportSummaryModal', () => ({ BibImportSummaryModal: () => null }));

import { BibliographyPanel } from '../BibliographyPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const citation = (id: string) => ({ id, type: 'book', author: 'Garde', year: '2000', title: id });
let importBibliography: ReturnType<typeof vi.fn>;
/** Le vrai `importBibliography` du store, avant qu'un test ne le remplace. */
const realImportBibliography = useBibliographyStore.getState().importBibliography;
const dialogs = () => useDialogStore.getState();
const electron = () => (window as unknown as { electron: { bibliography?: unknown } }).electron;

function show(state: Record<string, unknown>): void {
  useBibliographyStore.setState({ citations: [], filteredCitations: [], ...state } as never);
  act(() => {
    render(<BibliographyPanel />);
  });
}

const banner = () => screen.queryByRole('alert');

beforeEach(() => {
  importBibliography = vi.fn(async () => ({ total: 1, newCitations: 0, duplicates: 0, unreadKeys: [], file: 'refs.bib', sourceSaved: true }));
  (window as unknown as { electron: unknown }).electron = {
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: ['/ailleurs/refs.bib'] })) },
  };
  useBibliographyStore.setState({
    refreshIndexedPDFs: vi.fn(async () => undefined),
    loadReadingNotes: vi.fn(async () => undefined),
    importBibliography,
  } as never);
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Thèse', path: '/p/these', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  } as never);
});

afterEach(() => {
  cleanup();
  useBibliographyStore.setState({ bibliographyProblem: null } as never);
  while (dialogs().queue.length > 0) {
    if (dialogs().confirmOpen) dialogs().resolveConfirm(false);
    else dialogs().closeAlert();
  }
});

describe('le bandeau du panneau Bibliographie', () => {
  it('.bib introuvable : le bandeau le dit, et le panneau ne se présente pas comme vide', () => {
    show({ bibliographyProblem: { kind: 'missing', file: 'renomme.bib' } });

    expect(banner()).toHaveTextContent('bibliography.bibMissing');
    expect(banner()?.querySelector('svg.lucide')).not.toBeNull();
    expect(screen.queryByText('bibliography.noCitations')).toBeNull();
    expect(screen.queryByText('bibliography.importPrompt')).toBeNull();
  });

  it('pas en UTF-8 : le message dit d’enregistrer en UTF-8', () => {
    show({ bibliographyProblem: { kind: 'unreadable', file: 'latin1.bib', reason: 'encoding', detail: 'x' } });

    expect(banner()).toHaveTextContent('bibliography.bibNotUtf8');
  });

  it('autre illisibilité : le message générique', () => {
    show({ bibliographyProblem: { kind: 'unreadable', file: 'b.bib', reason: 'permission', detail: 'EACCES' } });

    expect(banner()).toHaveTextContent('bibliography.bibUnreadable');
  });

  it('entrées non lues : les premières clés, puis « et N autres », et la liste reste', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `entree_${i + 1}`);
    show({
      citations: [citation('Garde_2000')],
      filteredCitations: [citation('Garde_2000')],
      bibliographyProblem: { kind: 'partial', file: 'b.bib', unreadKeys: keys, metadataUnreadable: false },
    });

    expect(banner()).toHaveTextContent('bibliography.unreadEntries');
    expect(banner()).toHaveTextContent('@entree_1');
    expect(banner()).toHaveTextContent('@entree_8');
    expect(banner()).not.toHaveTextContent('@entree_9');
    expect(banner()).toHaveTextContent('zotero.sync.more');
    expect(screen.getByText('liste : Garde_2000')).toBeInTheDocument();
  });

  it('métadonnées illisibles : le bandeau le dit', () => {
    show({ bibliographyProblem: { kind: 'partial', file: 'b.bib', unreadKeys: [], metadataUnreadable: true } });

    expect(banner()).toHaveTextContent('bibliography.metadataUnreadable');
    expect(banner()).not.toHaveTextContent('bibliography.unreadEntries');
  });

  it('entrées non lues sans aucune entrée lue : le bandeau, pas « Aucune citation disponible »', () => {
    show({ bibliographyProblem: { kind: 'partial', file: 'bibdesk.bib', unreadKeys: ['a', 'b'], metadataUnreadable: false } });

    expect(banner()).toHaveTextContent('bibliography.unreadEntries');
    expect(screen.queryByText('bibliography.noCitations')).toBeNull();
    expect(screen.queryByText('bibliography.importPrompt')).toBeNull();
  });

  it('témoin : sans problème, pas de bandeau', () => {
    show({ bibliographyProblem: null });

    expect(banner()).toBeNull();
    expect(screen.getByText('bibliography.noCitations')).toBeInTheDocument();
  });
});

describe('importer un .bib pendant que le bandeau est là', () => {
  it('pas de remplacement direct : la fenêtre de choix s’ouvre d’abord', async () => {
    show({ bibliographyProblem: { kind: 'missing', file: 'refs.bib' } });

    await act(async () => {
      fireEvent.click(screen.getByTitle('bibliography.import'));
    });

    expect(importBibliography).not.toHaveBeenCalled();
    expect(screen.getByText('bibImport.title')).toBeInTheDocument();
  });

  it('témoin : sans bandeau ni référence, l’import se fait directement', async () => {
    show({ bibliographyProblem: null });

    await act(async () => {
      fireEvent.click(screen.getByTitle('bibliography.import'));
    });

    expect(importBibliography).toHaveBeenCalledWith('/ailleurs/refs.bib', 'replace', '/p/these');
  });

  const openImport = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTitle('bibliography.import'));
    });
  };

  // « Remplacer » met le fichier importé dans le projet sous son nom : un `refs.bib` importé remplace
  // le `refs.bib` du projet. La fenêtre disait « Votre bibliographie est vide » (S07-1-11).
  it('.bib du projet illisible, aucune référence : la fenêtre ne dit pas « vide », et Annuler n’importe rien', async () => {
    show({ bibliographyProblem: { kind: 'unreadable', file: 'refs.bib', reason: 'encoding', detail: 'x' } });
    await openImport();

    expect(screen.queryByText('bibImport.empty')).toBeNull();
    expect(screen.getByText('bibImport.projectFileUnread')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'bibImport.import' })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'bibImport.cancel' }));
    });

    expect(importBibliography).not.toHaveBeenCalled();
  });

  it('entrées non lues sans aucune entrée lue (BibDesk) : même avertissement', async () => {
    show({ bibliographyProblem: { kind: 'partial', file: 'refs.bib', unreadKeys: ['a'], metadataUnreadable: false } });
    await openImport();

    expect(screen.queryByText('bibImport.empty')).toBeNull();
    expect(screen.getByText('bibImport.projectFileUnread')).toBeInTheDocument();
  });

  it('l’accord explicite, « Remplacer », importe le fichier', async () => {
    show({ bibliographyProblem: { kind: 'unreadable', file: 'refs.bib', reason: 'encoding', detail: 'x' } });
    await openImport();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'bibImport.replace' }));
    });

    expect(importBibliography).toHaveBeenCalledWith('/ailleurs/refs.bib', 'replace', '/p/these');
  });

  it('.bib du projet introuvable : la fenêtre le dit', async () => {
    show({ bibliographyProblem: { kind: 'missing', file: 'refs.bib' } });
    await openImport();

    expect(screen.queryByText('bibImport.empty')).toBeNull();
    expect(screen.getByText('bibImport.projectFileMissing')).toBeInTheDocument();
  });

  it('des références lues et des entrées perdues : l’avertissement s’ajoute au choix remplacer / fusionner', async () => {
    show({
      citations: [citation('Garde_2000')],
      filteredCitations: [citation('Garde_2000')],
      bibliographyProblem: { kind: 'partial', file: 'refs.bib', unreadKeys: ['a'], metadataUnreadable: false },
    });
    await openImport();

    expect(screen.getByText('bibImport.projectFileUnread')).toBeInTheDocument();
    expect(screen.getByText('bibImport.merge')).toBeInTheDocument();
  });

  it('témoin : seules les métadonnées sont illisibles, le .bib s’est lu en entier : pas d’avertissement', async () => {
    show({
      citations: [citation('Garde_2000')],
      filteredCitations: [citation('Garde_2000')],
      bibliographyProblem: { kind: 'partial', file: 'refs.bib', unreadKeys: [], metadataUnreadable: true },
    });
    await openImport();

    expect(screen.getByText('bibImport.merge')).toBeInTheDocument();
    expect(screen.queryByText('bibImport.projectFileUnread')).toBeNull();
  });
});

describe('un import qui ne va pas jusqu’au projet', () => {
  // Le main refuse l'import (fichier rangé hors du projet sans passer par le dialogue, par exemple) :
  // il n'a rien écrit ni chargé, et le `.bib` du projet n'a pas bougé. Le panneau ne doit montrer ni
  // les références du fichier importé, ni perdre le bandeau du fichier du projet, qui ne se lit pas.
  const PROBLEM = { kind: 'unreadable', file: 'refs.bib', reason: 'encoding', detail: 'x' } as const;

  async function replaceWith(response: Record<string, unknown>): Promise<void> {
    electron().bibliography = {
      import: vi.fn(async () => response),
      loadWithMetadata: vi.fn(async () => ({ success: true, citations: [citation('Import_2020')], unreadKeys: [], metadataUnreadable: false })),
    };
    useBibliographyStore.setState({ importBibliography: realImportBibliography } as never);
    show({ bibliographyProblem: PROBLEM });
    await act(async () => {
      fireEvent.click(screen.getByTitle('bibliography.import'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'bibImport.replace' }));
    });
  }

  it('import refusé : le bandeau du projet reste, pas la liste du fichier importé', async () => {
    await replaceWith({ success: false, error: 'Read access denied: /ailleurs/refs.bib is outside allowed directories' });

    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertMessage).toContain('Read access denied');
    expect(useBibliographyStore.getState().bibliographyProblem).toEqual(PROBLEM);
    expect(useBibliographyStore.getState().citations).toEqual([]);
    expect(banner()).toHaveTextContent('bibliography.bibNotUtf8');
    expect(screen.queryByText('liste : Import_2020')).toBeNull();
  });

  it('témoin : l’import réussit, le bandeau part et le fichier du projet relu s’affiche', async () => {
    await replaceWith({ success: true, bibPath: '/p/these/refs.bib', total: 1, unreadKeys: [], sourceSaved: true });

    expect(useBibliographyStore.getState().bibliographyProblem).toBeNull();
    expect(useBibliographyStore.getState().citations.map((c) => c.id)).toEqual(['Import_2020']);
    expect(banner()).toBeNull();
  });
});

describe('importer un .bib qui ne se lit pas', () => {
  // Le main lit en UTF-8 strict : un vieux `.bib` en windows-1252 est refusé. Le message brut du
  // main s'affichait derrière « Failed to import bibliography: », en français quelle que soit la
  // langue, sans dire quoi faire.
  async function importRefused(response: Record<string, unknown>): Promise<string> {
    electron().bibliography = { import: vi.fn(async () => ({ success: false, citations: [], ...response })) };
    useBibliographyStore.setState({ importBibliography: realImportBibliography } as never);
    show({ bibliographyProblem: null });
    await act(async () => {
      fireEvent.click(screen.getByTitle('bibliography.import'));
    });
    expect(dialogs().alertOpen).toBe(true);
    return dialogs().alertMessage;
  }

  it('pas en UTF-8 : le message traduit dit d’enregistrer en UTF-8', async () => {
    const message = await importRefused({
      problem: 'unreadable',
      reason: 'encoding',
      error: "/ailleurs/refs.bib n'est pas encodé en UTF-8",
    });

    expect(message).toBe('bibliography.bibNotUtf8');
    // Le bandeau parle du `.bib` du projet, que l'import n'a pas touché.
    expect(banner()).toBeNull();
  });

  it('droits refusés : le message traduit générique', async () => {
    const message = await importRefused({ problem: 'unreadable', reason: 'permission', error: 'EACCES' });

    expect(message).toBe('bibliography.bibUnreadable');
  });

  it('témoin : un autre échec garde son message', async () => {
    const message = await importRefused({ error: 'autre panne' });

    expect(message).toContain('autre panne');
  });
});
