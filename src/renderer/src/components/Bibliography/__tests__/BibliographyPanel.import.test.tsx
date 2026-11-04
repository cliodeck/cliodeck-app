// @vitest-environment jsdom
/**
 * Importer un .bib alors que `project.json` refuse de le retenir.
 *
 * `setBibliographySource` rend `{ success: false }` sans lever, et le panneau affichait son résumé
 * comme si de rien n'était : à la prochaine ouverture, le projet ne retrouvait pas ce fichier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../CitationList', () => ({ CitationList: () => null }));
vi.mock('../ZoteroImport', () => ({ ZoteroImport: () => null }));
vi.mock('../BibliographyStats', () => ({ BibliographyStats: () => null }));
vi.mock('../OrphanPDFModal', () => ({ OrphanPDFModal: () => null }));
vi.mock('../TagManager', () => ({ TagFilter: () => null }));
vi.mock('../PDFModificationNotification', () => ({
  PDFModificationNotification: () => null,
  usePDFModificationDetection: () => ({ modifiedPDFs: [], dismissNotification: () => undefined }),
}));
vi.mock('../BibImportSummaryModal', () => ({
  BibImportSummaryModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div>résumé de l’import</div> : null),
}));

import { BibliographyPanel } from '../BibliographyPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const PROJECT = '/p/these';
let setBibliographySource: ReturnType<typeof vi.fn>;
let copyFile: ReturnType<typeof vi.fn>;

async function importBib(): Promise<void> {
  await act(async () => {
    render(<BibliographyPanel />);
  });
  await act(async () => {
    fireEvent.click(screen.getByTitle('bibliography.import'));
  });
}

beforeEach(() => {
  setBibliographySource = vi.fn(async () => ({ success: true }));
  copyFile = vi.fn(async () => ({ success: true }));
  (window as unknown as { electron: unknown }).electron = {
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: ['/ailleurs/refs.bib'] })) },
    fs: { copyFile },
    project: { setBibliographySource },
  };
  useBibliographyStore.setState({
    citations: [],
    filteredCitations: [],
    refreshIndexedPDFs: vi.fn(async () => undefined),
    loadBibliography: vi.fn(async () => undefined),
  } as never);
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Thèse', path: PROJECT, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  } as never);
});

afterEach(() => {
  cleanup();
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('performImport', () => {
  it('project.json refuse : l’auteur le lit, et le résumé vient après', async () => {
    setBibliographySource.mockResolvedValue({ success: false, error: 'Unexpected token' });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);

    await importBib();

    expect(setBibliographySource).toHaveBeenCalledWith({
      projectPath: `${PROJECT}/project.json`,
      type: 'file',
      filePath: 'refs.bib',
    });
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(showAlert.mock.calls[0]?.[0]).toContain('bibliography.sourceNotSaved');
    expect(showAlert.mock.calls[0]?.[0]).toContain('Unexpected token');
    expect(screen.getByText('résumé de l’import')).toBeInTheDocument();
    showAlert.mockRestore();
  });

  it('une réponse qui ne dit pas le succès n’en est pas un', async () => {
    setBibliographySource.mockResolvedValue(undefined);
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);

    await importBib();

    expect(showAlert.mock.calls[0]?.[0]).toBe('bibliography.sourceNotSaved');
    showAlert.mockRestore();
  });

  it('témoin : retenu, aucun message, le résumé seul', async () => {
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);

    await importBib();

    expect(showAlert).not.toHaveBeenCalled();
    expect(screen.getByText('résumé de l’import')).toBeInTheDocument();
    showAlert.mockRestore();
  });
});
