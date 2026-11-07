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
import { useProjectStore } from '../../../stores/projectStore';

const citation = (id: string) => ({ id, type: 'book', author: 'Garde', year: '2000', title: id });
let loadBibliography: ReturnType<typeof vi.fn>;

function show(state: Record<string, unknown>): void {
  useBibliographyStore.setState({ citations: [], filteredCitations: [], ...state } as never);
  act(() => {
    render(<BibliographyPanel />);
  });
}

const banner = () => screen.queryByRole('alert');

beforeEach(() => {
  loadBibliography = vi.fn(async () => undefined);
  (window as unknown as { electron: unknown }).electron = {
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: ['/ailleurs/refs.bib'] })) },
    fs: { copyFile: vi.fn(async () => ({ success: true })) },
    project: { setBibliographySource: vi.fn(async () => ({ success: true })) },
  };
  useBibliographyStore.setState({ refreshIndexedPDFs: vi.fn(async () => undefined), loadBibliography } as never);
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Thèse', path: '/p/these', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  } as never);
});

afterEach(() => {
  cleanup();
  useBibliographyStore.setState({ bibliographyProblem: null } as never);
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

    expect(loadBibliography).not.toHaveBeenCalled();
    expect(screen.getByText('bibImport.title')).toBeInTheDocument();
  });

  it('témoin : sans bandeau ni référence, l’import se fait directement', async () => {
    show({ bibliographyProblem: null });

    await act(async () => {
      fireEvent.click(screen.getByTitle('bibliography.import'));
    });

    expect(loadBibliography).toHaveBeenCalledWith('/ailleurs/refs.bib');
  });
});
