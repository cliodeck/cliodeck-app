// @vitest-environment jsdom
/**
 * Importer un .bib dans le projet ouvert (S07-1-3) : le main écrit le fichier du projet et le relit,
 * le panneau se relit depuis ce fichier, et le récapitulatif dit ce que contient le disque.
 *
 * Avant, « Fusionner » ne fusionnait que dans le panneau, puis la copie du fichier importé dans le
 * projet était refusée dès qu'il était rangé ailleurs : une alerte anglaise, « Failed to import
 * bibliography: », et une liste fusionnée qui n'existait nulle part.
 *
 * Et `project.json` qui refuse de retenir le fichier : le main rend ce refus sans lever, et le
 * panneau le dit avant le récapitulatif ; sinon, à la prochaine ouverture, le projet ne
 * retrouvait pas ce fichier sans que rien ne l'ait annoncé.
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

import { BibliographyPanel } from '../BibliographyPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const PROJECT = '/p/these';
const BIB = `${PROJECT}/bibliography.bib`;
const citation = (id: string) => ({ id, type: 'book', author: 'Garde', year: '2000', title: id });
const project = (path: string) => ({ id: path, name: 'Thèse', path, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() });

let importIpc: ReturnType<typeof vi.fn>;
let loadWithMetadata: ReturnType<typeof vi.fn>;
let loadIpc: ReturnType<typeof vi.fn>;
const dialogs = () => useDialogStore.getState();
const ids = () => useBibliographyStore.getState().citations.map((c) => c.id);

/** Ce que le main rend quand il a écrit la fusion : le total relu sur le disque. */
const written = (extra: Record<string, unknown> = {}) => ({
  success: true,
  bibPath: BIB,
  total: 3,
  newCitations: 1,
  duplicates: 1,
  unreadKeys: [],
  sourceSaved: true,
  ...extra,
});

/** Le bouton du panneau, puis, s'il y a déjà des références, le choix demandé. */
async function importBib(mode?: 'bibImport.merge' | 'bibImport.replace'): Promise<void> {
  await act(async () => {
    render(<BibliographyPanel />);
  });
  await act(async () => {
    fireEvent.click(screen.getByTitle('bibliography.import'));
  });
  if (mode) {
    await act(async () => {
      fireEvent.click(screen.getByText(mode));
    });
  }
}

beforeEach(() => {
  importIpc = vi.fn(async () => written());
  loadWithMetadata = vi.fn(async () => ({
    success: true,
    citations: [citation('Garde_2000'), citation('Main_2010'), citation('Autre_2015')],
    unreadKeys: [],
    metadataUnreadable: false,
  }));
  loadIpc = vi.fn(async () => ({ success: true, citations: [citation('Garde_2000'), citation('Autre_2015')], unreadKeys: [] }));
  (window as unknown as { electron: unknown }).electron = {
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: ['/ailleurs/refs.bib'] })) },
    bibliography: { import: importIpc, loadWithMetadata, load: loadIpc },
  };
  useBibliographyStore.setState({
    citations: [citation('Garde_2000'), citation('Main_2010')],
    filteredCitations: [citation('Garde_2000'), citation('Main_2010')],
    bibliographyProblem: null,
    refreshIndexedPDFs: vi.fn(async () => undefined),
    loadReadingNotes: vi.fn(async () => undefined),
  } as never);
  useProjectStore.setState({ currentProject: project(PROJECT) } as never);
});

afterEach(() => {
  cleanup();
  while (dialogs().alertOpen) dialogs().closeAlert();
});

describe('« Fusionner » un .bib rangé hors du projet', () => {
  it('le main écrit la fusion : le récapitulatif annonce le total du disque, sans alerte', async () => {
    await importBib('bibImport.merge');

    expect(importIpc).toHaveBeenCalledWith({ sourcePath: '/ailleurs/refs.bib', mode: 'merge', expectedProjectPath: PROJECT });
    expect(dialogs().alertOpen).toBe(false);
    expect(screen.getByText('bibImportSummary.merged')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('le panneau se relit depuis le fichier du projet, rattachements compris', async () => {
    await importBib('bibImport.merge');

    expect(loadWithMetadata).toHaveBeenCalledWith({ filePath: BIB, projectPath: PROJECT });
    expect(ids()).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015']);
  });

  it('les entrées du fichier importé qui ne se lisent pas sont nommées dans le récapitulatif', async () => {
    importIpc.mockResolvedValue(written({ unreadKeys: ['sans_titre'] }));

    await importBib('bibImport.merge');

    expect(screen.getByText('bibImportSummary.unreadMerged')).toBeInTheDocument();
    expect(screen.getByText('@sans_titre')).toBeInTheDocument();
  });

  it('un échec se dit dans la langue de l’interface, sans « Failed to import bibliography »', async () => {
    importIpc.mockResolvedValue({ success: false, error: 'Read access denied: /ailleurs/refs.bib is outside allowed directories.' });

    await importBib('bibImport.merge');

    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertMessage).not.toContain('Failed to import');
    expect(dialogs().alertMessage.startsWith('bibImport.failed')).toBe(true);
    expect(dialogs().alertMessage).toContain('Read access denied');
    // Le main n'a rien écrit : le panneau montre toujours la bibliographie du projet.
    expect(ids()).toEqual(['Garde_2000', 'Main_2010']);
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('le .bib du projet ne se lit pas en entier : la fusion refusée nomme les entrées en cause', async () => {
    importIpc.mockResolvedValue({ success: false, error: 'bib-unread', file: 'bibliography.bib', unreadKeys: ['entretien_dupont'] });

    await importBib('bibImport.merge');

    expect(dialogs().alertMessage).toContain('bibImport.mergeRefused');
    expect(dialogs().alertMessage).toContain('zotero.sync.unreadEntries');
    expect(dialogs().alertMessage).toContain('@entretien_dupont');
    expect(ids()).toEqual(['Garde_2000', 'Main_2010']);
  });

  it('refusé parce que le projet a changé : rien ne s’affiche dans l’autre', async () => {
    importIpc.mockResolvedValue({ success: false, error: 'project-changed' });

    await importBib('bibImport.merge');

    expect(dialogs().alertOpen).toBe(false);
    expect(screen.queryByText('bibImportSummary.title')).toBeNull();
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('le projet a changé pendant l’écriture : le panneau de l’autre ne relit pas ce fichier', async () => {
    importIpc.mockImplementation(async () => {
      useProjectStore.setState({ currentProject: project('/p/autre') } as never);
      return written();
    });

    await importBib('bibImport.merge');

    expect(loadWithMetadata).not.toHaveBeenCalled();
    expect(dialogs().alertOpen).toBe(false);
    expect(screen.queryByText('bibImportSummary.title')).toBeNull();
  });

  it('témoin : sans projet ouvert, la fusion se fait dans le panneau, comme avant', async () => {
    useProjectStore.setState({ currentProject: null } as never);

    await importBib('bibImport.merge');

    expect(importIpc).not.toHaveBeenCalled();
    expect(loadIpc).toHaveBeenCalledWith('/ailleurs/refs.bib');
    expect(ids()).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015']);
    expect(screen.getByText('bibImportSummary.merged')).toBeInTheDocument();
  });
});

describe('sans projet ouvert, le récapitulatif ne parle pas d’un fichier du projet', () => {
  beforeEach(() => {
    useProjectStore.setState({ currentProject: null } as never);
    loadIpc.mockResolvedValue({ success: true, citations: [citation('Garde_2000'), citation('Autre_2015')], unreadKeys: ['sans_titre'] });
  });

  it.each([
    ['bibImport.merge', 'bibImportSummary.unreadMerged'],
    ['bibImport.replace', 'bibImportSummary.unreadReplaced'],
  ] as const)('%s : les entrées non lues sont nommées, sans renvoyer au projet', async (mode, inProjectKey) => {
    await importBib(mode);

    expect(screen.getByText('bibImportSummary.unreadNoProject')).toBeInTheDocument();
    expect(screen.queryByText(inProjectKey)).toBeNull();
    // Dans le récapitulatif : en remplacement, le bandeau du panneau les nomme aussi.
    expect(screen.getAllByText('@sans_titre').some((el) => el.closest('.bib-import-summary-modal'))).toBe(true);
  });
});

describe('« Remplacer » refusé par le main', () => {
  it('dans le projet, ce nom est un lien qui mène dehors : l’alerte le dit dans la langue de l’interface', async () => {
    importIpc.mockResolvedValue({ success: false, error: 'bib-outside-project', file: 'refs.bib' });

    await importBib('bibImport.replace');

    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertMessage).toBe('bibImport.targetOutsideProject');
    // Le main n'a rien écrit : le panneau montre toujours la bibliographie du projet.
    expect(ids()).toEqual(['Garde_2000', 'Main_2010']);
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });
});

describe('project.json ne retient pas le fichier', () => {
  beforeEach(() => {
    useBibliographyStore.setState({ citations: [], filteredCitations: [] } as never);
  });

  it('l’auteur le lit, et le récapitulatif vient après', async () => {
    importIpc.mockResolvedValue(written({ sourceSaved: false, sourceError: 'Unexpected token' }));
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);

    await importBib();

    expect(importIpc).toHaveBeenCalledWith({ sourcePath: '/ailleurs/refs.bib', mode: 'replace', expectedProjectPath: PROJECT });
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(showAlert.mock.calls[0]?.[0]).toContain('bibliography.sourceNotSaved');
    expect(showAlert.mock.calls[0]?.[0]).toContain('Unexpected token');
    expect(screen.getByText('bibImportSummary.title')).toBeInTheDocument();
    showAlert.mockRestore();
  });

  it('une réponse qui ne dit pas que le fichier est retenu ne vaut pas accord', async () => {
    importIpc.mockResolvedValue(written({ sourceSaved: undefined }));
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);

    await importBib();

    expect(showAlert.mock.calls[0]?.[0]).toBe('bibliography.sourceNotSaved');
    showAlert.mockRestore();
  });

  it('témoin : retenu, aucun message, le récapitulatif seul', async () => {
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);

    await importBib();

    expect(showAlert).not.toHaveBeenCalled();
    expect(screen.getByText('bibImportSummary.title')).toBeInTheDocument();
    showAlert.mockRestore();
  });
});
