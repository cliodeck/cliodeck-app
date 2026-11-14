// @vitest-environment jsdom
/**
 * Export de présentation : ce qui part au main (S12-2-1).
 *
 * La modale envoyait `content` du store, c'est-à-dire le miroir du fichier OUVERT, quel
 * qu'il soit : une note de lecture ouverte depuis la bibliographie partait en diaporama
 * sous le titre du projet, et écrasait l'export précédent ; après « Nouveau fichier »,
 * une chaîne vide, refusée par une erreur de validation. Elle résout désormais le
 * manuscrit comme les modales PDF et Word (`resolveManuscriptContent`) : slides.md, ou
 * document.md pour un article (Q43), avec le texte vivant quand c'est lui qui est ouvert.
 *
 * Vrais editorStore, projectStore et manuscriptStore ; le disque est simulé derrière l'IPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { PresentationExportModal } from '../PresentationExportModal';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useManuscriptStore } from '../../../stores/manuscriptStore';

const PROJECT = "/p/Séminaire d'histoire";
const SLIDES = `${PROJECT}/slides.md`;
const DOCUMENT = `${PROJECT}/document.md`;
const ABSTRACT = `${PROJECT}/abstract.md`;
const NOTE = `${PROJECT}/reading-notes/smith2020.md`;
const CHAPTER = `${PROJECT}/chapters/01-introduction.md`;

const DECK = '# Diapositive une\n\n---\n\n## Diapositive deux\n';
const NOTE_TEXT = '---\ncitekey: smith2020\n---\n\n# Note de lecture Smith 2020\n';
const ARTICLE = '# Article\n\nLe texte de l’article.\n';

let disk: Record<string, string>;
let exportCall: Mock;

function openProject(type: 'article' | 'presentation' | 'book'): void {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: "Séminaire d'histoire",
      path: PROJECT,
      type,
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters:
      type === 'book'
        ? [{ id: 'c1', title: 'Introduction', filePath: 'chapters/01-introduction.md', order: 0 }]
        : [],
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  } as never);
}

/** Le geste de l'auteur, par la seule porte du store (CitationCard, « Ouvrir »). */
async function open(path: string): Promise<void> {
  await act(async () => {
    await useEditorStore.getState().loadFile(path);
  });
}

/** Le texte à l'écran, en avance sur le miroir du store (frappe non sauvegardée). */
function typeInEditor(text: string): void {
  useEditorStore.setState({ editorFacade: { getValue: () => text } as never });
}

async function clickExport(): Promise<void> {
  render(<PresentationExportModal isOpen onClose={() => undefined} />);
  const button = await screen.findByRole('button', { name: 'presentation.export' });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
}

const sentContent = (): unknown => (exportCall.mock.calls[0][0] as { content: unknown }).content;

/** Un refus : le message s'affiche, rien ne part, et le bouton revient. */
async function expectRefusal(message: string): Promise<void> {
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'presentation.export' })).not.toBeDisabled();
  expect(exportCall).not.toHaveBeenCalled();
}

beforeEach(() => {
  disk = { [SLIDES]: DECK, [DOCUMENT]: ARTICLE, [ABSTRACT]: '# Résumé\n', [NOTE]: NOTE_TEXT, [CHAPTER]: '# Introduction\n' };
  exportCall = vi.fn(async () => ({ success: true, outputPath: `${PROJECT}/sortie.html` }));
  const read = async (path: string) => {
    if (path in disk) return disk[path];
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  };
  (window as unknown as { electron: unknown }).electron = {
    project: { onRebuildProgress: () => () => undefined },
    ipcRenderer: { on: () => () => undefined },
    editor: {
      loadFile: vi.fn(async (path: string) =>
        path in disk
          ? { success: true, content: disk[path] }
          : { success: false, code: 'absent', error: 'ENOENT' }
      ),
      saveFile: vi.fn(async (path: string, content: string) => {
        disk[path] = content;
        return { success: true };
      }),
    },
    fs: {
      exists: vi.fn(async (path: string) => path in disk),
      readFile: vi.fn(read),
    },
    revealJsExport: {
      onProgress: () => () => undefined,
      export: exportCall,
      exportOffline: exportCall,
      exportPDF: exportCall,
    },
    dialog: { saveFile: vi.fn(async () => ({ canceled: true })) },
  };
  useEditorStore.setState({
    content: '',
    filePath: null,
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  } as never);
  useManuscriptStore.setState({ renumbering: false, exporting: false });
  openProject('presentation');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useEditorStore.setState({ editorFacade: null, switchLock: null } as never);
  useManuscriptStore.setState({ renumbering: false, exporting: false });
  useProjectStore.setState({ currentProject: null, chapters: [] } as never);
});

describe('export de présentation : le manuscrit, pas le fichier ouvert', () => {
  it('une note de lecture ouverte après slides.md : l’export reçoit slides.md', async () => {
    await open(SLIDES);
    await open(NOTE);
    expect(useEditorStore.getState().filePath).toBe(NOTE);

    await clickExport();

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(sentContent()).toBe(DECK);
  });

  it('slides.md ouvert : l’export reçoit le texte vivant, pas le miroir du store', async () => {
    await open(SLIDES);
    const live = `${DECK}\n---\n\n## Frappe non sauvegardée\n`;
    typeInEditor(live);
    expect(useEditorStore.getState().content).toBe(DECK);

    await clickExport();

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(sentContent()).toBe(live);
  });

  it('après « Nouveau fichier », l’export ne part pas avec une chaîne vide', async () => {
    await open(SLIDES);
    await act(async () => {
      await useEditorStore.getState().createNewFile();
    });
    expect(useEditorStore.getState().filePath).toBeNull();

    await clickExport();

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(sentContent()).toBe(DECK);
  });

  it('un article (Q43) : document.md part en diaporama, pas abstract.md ouvert', async () => {
    openProject('article');
    await open(ABSTRACT);

    await clickExport();

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(sentContent()).toBe(ARTICLE);
  });

  it('le champ reprend le chemin où le main a écrit', async () => {
    await open(SLIDES);
    exportCall.mockResolvedValueOnce({ success: true, outputPath: `${PROJECT}/diapos.html` });
    render(<PresentationExportModal isOpen onClose={() => undefined} />);
    const field = screen.getByPlaceholderText('presentation.outputPlaceholder');
    fireEvent.change(field, { target: { value: 'diapos.html' } });

    fireEvent.click(await screen.findByRole('button', { name: 'presentation.export' }));

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(field).toHaveValue(`${PROJECT}/diapos.html`));
  });
});

describe('export de présentation : les refus', () => {
  it('un livre : refus explicite, rien ne part', async () => {
    openProject('book');
    await open(CHAPTER);

    await clickExport();

    await expectRefusal('presentation.bookNotSupported');
  });

  it('un livre en pleine renumérotation : rien ne part non plus', async () => {
    openProject('book');
    await open(CHAPTER);
    useManuscriptStore.setState({ renumbering: true });
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);

    await clickExport();

    expect(await screen.findByText(/presentation\.bookNotSupported|book\.renumberInProgress/)).toBeInTheDocument();
    expect(exportCall).not.toHaveBeenCalled();
  });

  it('slides.md illisible : export.manuscriptUnreadable, et pas la note ouverte', async () => {
    await open(SLIDES);
    await open(NOTE);
    delete disk[SLIDES];

    await clickExport();

    await expectRefusal('export.manuscriptUnreadable');
  });

  it('slides.md vide : un message qui le dit, au lieu de l’erreur de validation', async () => {
    disk[SLIDES] = '\n';
    await open(NOTE);

    await clickExport();

    await expectRefusal('presentation.emptyDeck');
  });

  it('slides.md ouvert et vidé à l’écran : même refus', async () => {
    await open(SLIDES);
    typeInEditor('');

    await clickExport();

    await expectRefusal('presentation.emptyDeck');
  });
});
