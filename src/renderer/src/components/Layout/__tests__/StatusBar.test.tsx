// @vitest-environment jsdom
/**
 * L'état d'enregistrement du document ouvert, dans la barre d'état.
 *
 * Il n'était affiché qu'avec un chemin : un tampon sans titre n'en a pas, et une page
 * entière pouvait s'y écrire sans que rien ne dise qu'elle n'était nulle part.
 *
 * Et le fichier lui-même (G7) : rien à l'écran ne le nommait. Après « Enregistrer sous »,
 * l'éditeur reste sur le nouveau fichier, et l'auteur a changé les droits de document.md
 * alors qu'il en éditait un autre.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

// Le simulacre commun rend la clé seule : l'infobulle d'un fichier hors du projet doit
// porter son chemin, que seule l'interpolation y met.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params.path === 'string' ? `${key} ${params.path}` : key,
    i18n: { language: 'fr' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { StatusBar } from '../StatusBar';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { REINDEX_DONE_NOTICE_MS, useTropyReindexStore } from '../../../stores/tropyReindexStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

async function mountWith(state: { filePath: string | null; isDirty: boolean }): Promise<void> {
  useEditorStore.setState({ ...state, lastSavedAt: null });
  await act(async () => {
    render(<StatusBar />);
  });
}

beforeEach(() => {
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

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  useEditorStore.setState({ filePath: null, isDirty: false, bufferDetached: false });
});

describe('StatusBar : état d’enregistrement', () => {
  it('tampon sans titre modifié : il se voit', async () => {
    await mountWith({ filePath: null, isDirty: true });

    expect(screen.getByText('statusBar.unsaved')).toBeInTheDocument();
  });

  it('tampon sans titre vierge : rien à signaler', async () => {
    await mountWith({ filePath: null, isDirty: false });

    expect(screen.queryByText('statusBar.unsaved')).toBeNull();
    expect(screen.queryByText('statusBar.notModified')).toBeNull();
  });

  it('document tout juste ouvert : « Non modifié », pas « Non enregistré », puisqu’il n’y a rien à écrire (D6)', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: false });

    expect(screen.getByText('statusBar.notModified')).toBeInTheDocument();
    expect(screen.getByTitle('statusBar.notModifiedTooltip')).toBeInTheDocument();
    expect(screen.queryByText('statusBar.notSavedYet')).toBeNull();
    expect(screen.queryByText('statusBar.unsaved')).toBeNull();
  });

  it('témoin : un fichier ouvert et modifié reste signalé', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: true });

    expect(screen.getByText('statusBar.unsaved')).toBeInTheDocument();
  });
});

/** L'élément qui nomme le fichier ouvert, s'il y en a un. */
const fileLabel = (): HTMLElement | null => document.querySelector('.status-bar__item--file');

describe('StatusBar : le fichier ouvert est nommé (G7)', () => {
  it('fichier du projet : son chemin relatif au projet, le chemin complet en infobulle', async () => {
    await mountWith({ filePath: '/p/chapters/03-guerre.md', isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^chapters\/03-guerre\.md$/);
    expect(fileLabel()).toHaveAttribute('title', '/p/chapters/03-guerre.md');
  });

  it('fichier hors du projet : son nom seul, et l’infobulle dit où il est', async () => {
    // `/p-bis` n'est pas un dossier de `/p` : une comparaison de chaînes naïve l'y rangerait.
    await mountWith({ filePath: '/p-bis/notes/note.md', isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^note\.md$/);
    expect(fileLabel()).toHaveAttribute('title', 'statusBar.fileOutsideProjectTooltip /p-bis/notes/note.md');
  });

  it('tampon sans titre : le libellé « sans titre »', async () => {
    await mountWith({ filePath: null, isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^statusBar\.untitled$/);
  });

  it('la valeur suit l’éditeur : après « Enregistrer sous », la barre nomme le nouveau fichier', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: false });
    expect(fileLabel()).toHaveTextContent(/^document\.md$/);

    act(() => {
      useEditorStore.setState({ filePath: '/p/note.md' });
    });

    expect(fileLabel()).toHaveTextContent(/^note\.md$/);
  });

  it('sous Windows, une note ouverte par un dialogue est dans le projet : chemin relatif, sans « hors du projet »', async () => {
    // Le dossier du projet vient de `path.dirname`, le chemin de la note d'un dialogue ou de
    // `path.join` : barres obliques inverses des deux côtés.
    useProjectStore.setState({
      currentProject: {
        id: 'p1',
        name: 'Projet',
        path: 'C:\\Users\\h\\proj',
        type: 'article',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
    });
    await mountWith({ filePath: 'C:\\Users\\h\\proj\\reading-notes\\Lester_1935.md', isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^reading-notes\/Lester_1935\.md$/);
    expect(fileLabel()).toHaveAttribute('title', 'C:\\Users\\h\\proj\\reading-notes\\Lester_1935.md');
  });

  it('un dossier long cède avant le nom du fichier : deux parties, le nom à part', async () => {
    await mountWith({ filePath: '/p/annexes-documentaires/transcription.md', isDirty: false });

    // La mise en page (le dossier se tronque, le nom reste entier) se vérifie dans l'app réelle ;
    // ici, la découpe qui la rend possible.
    expect(fileLabel()?.querySelector('.status-bar__file-dir')).toHaveTextContent(/^annexes-documentaires$/);
    expect(fileLabel()?.querySelector('.status-bar__file-name')).toHaveTextContent(/^\/transcription\.md$/);
  });

  it('témoin : hors de tout document, le temps d’un changement de projet, rien n’est nommé', async () => {
    useEditorStore.setState({ bufferDetached: true });
    await mountWith({ filePath: null, isDirty: false });

    expect(fileLabel()).toBeNull();
  });
});

/** L'élément de la réindexation complète des sources primaires, s'il y en a un. */
const reindexLabel = (): HTMLElement | null =>
  screen.queryByText(/^statusBar\.tropy(Reindex|IndexRebuil)/)?.closest('.status-bar__item') ?? null;

describe('StatusBar : la réindexation complète des sources primaires se voit, panneau fermé (H7)', () => {
  afterEach(() => {
    vi.useRealTimers();
    act(() => useTropyReindexStore.getState().clear());
  });

  it('en cours : les sources faites sur le total, le message entier en infobulle', async () => {
    await mountWith({ filePath: null, isDirty: false });
    act(() =>
      useTropyReindexStore
        .getState()
        .receive({ phase: 'running', done: 12, total: 345, chunks: 4000, waitingForSync: false })
    );

    expect(reindexLabel()).toHaveTextContent('statusBar.tropyReindex');
    expect(reindexLabel()).toHaveAttribute('title', 'primarySources.reindexAll.running');
    expect(reindexLabel()).toHaveClass('status-bar__item--active');
  });

  it('arrêtée : dite en avertissement, avec sa cause en infobulle', async () => {
    await mountWith({ filePath: null, isDirty: false });
    act(() =>
      useTropyReindexStore
        .getState()
        .receive({ phase: 'stopped', reason: 'no-embedding-provider', total: 345, remaining: 333 })
    );

    expect(reindexLabel()).toHaveTextContent('statusBar.tropyReindexStopped');
    expect(reindexLabel()).toHaveAttribute('title', 'primarySources.reindexAll.stoppedNoProvider');
    expect(reindexLabel()).toHaveClass('status-bar__item--warning');
  });

  it('finie : dite un moment, puis effacée', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mountWith({ filePath: null, isDirty: false });
    act(() => useTropyReindexStore.getState().receive({ phase: 'done', total: 345 }));
    expect(reindexLabel()).toHaveTextContent('statusBar.tropyReindexDone');

    act(() => {
      vi.advanceTimersByTime(REINDEX_DONE_NOTICE_MS);
    });

    expect(reindexLabel()).toBeNull();
  });

  it('l’index de recherche relu incomplet, à l’ouverture : sa reconstruction se voit, puis sa fin, qui s’efface', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mountWith({ filePath: null, isDirty: false });
    act(() => useTropyReindexStore.getState().receive({ phase: 'rebuilding-index', missing: 40648 }));

    expect(reindexLabel()).toHaveTextContent('statusBar.tropyIndexRebuilding');
    expect(reindexLabel()).toHaveAttribute('title', 'primarySources.reindexAll.rebuildingIndex');
    expect(reindexLabel()).toHaveClass('status-bar__item--active');

    act(() => useTropyReindexStore.getState().receive({ phase: 'index-rebuilt' }));
    expect(reindexLabel()).toHaveTextContent('statusBar.tropyIndexRebuilt');
    act(() => {
      vi.advanceTimersByTime(REINDEX_DONE_NOTICE_MS);
    });
    expect(reindexLabel()).toBeNull();
  });

  it('témoin : rien en cours, rien d’affiché', async () => {
    await mountWith({ filePath: null, isDirty: false });

    expect(reindexLabel()).toBeNull();
  });
});

describe('StatusBar : l’index des PDF à reconstruire se voit, panneau Bibliographie fermé (J8)', () => {
  const electron = () => (window as unknown as { electron: { pdf?: unknown } }).electron;
  let getIndexState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getIndexState = vi.fn(async () => ({ success: true, rebuildDue: true }));
    electron().pdf = { getIndexState, rebuildIndex: vi.fn(async () => ({ success: true, started: true })) };
    act(() => projectLifecycle.enter('/p'));
  });

  afterEach(() => {
    act(() => projectLifecycle.enter(null));
    delete electron().pdf;
  });

  it('proposée à la réouverture : un avertissement, qui ouvre le panneau Bibliographie', async () => {
    const switches: unknown[] = [];
    const onSwitch = (event: Event) => switches.push((event as CustomEvent).detail);
    window.addEventListener('switch-panel', onSwitch);
    try {
      await mountWith({ filePath: null, isDirty: false });

      const item = await screen.findByRole('button', { name: 'pdfIndexRebuild.status' });
      expect(item).toHaveAttribute('title', 'pdfIndexRebuild.statusTooltip');
      expect(item).toHaveClass('status-bar__item--warning');
      expect(getIndexState).toHaveBeenCalledWith('/p');

      fireEvent.click(item);
      expect(switches).toEqual(['bibliography']);
    } finally {
      window.removeEventListener('switch-panel', onSwitch);
    }
  });

  it('témoin : un index sain, rien d’affiché', async () => {
    getIndexState.mockResolvedValue({ success: true, rebuildDue: false });
    await mountWith({ filePath: null, isDirty: false });

    await waitFor(() => expect(getIndexState).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText('pdfIndexRebuild.status')).toBeNull();
  });
});

describe('StatusBar : les sources primaires à réindexer pour un nouveau modèle se voient, panneau fermé (Q29)', () => {
  const electron = () => (window as unknown as { electron: { tropy?: Record<string, unknown> } }).electron;
  let getReembedProposal: ReturnType<typeof vi.fn>;
  let tropyBefore: Record<string, unknown> | undefined;

  beforeEach(() => {
    getReembedProposal = vi.fn(async () => ({
      success: true,
      proposal: { sources: 221, chunks: 40648, expected: 768, actual: 1024 },
    }));
    tropyBefore = electron().tropy;
    electron().tropy = { ...tropyBefore, getReembedProposal };
    act(() => projectLifecycle.enter('/p'));
  });

  afterEach(() => {
    act(() => projectLifecycle.enter(null));
    electron().tropy = tropyBefore;
  });

  it('proposée : un avertissement, qui ouvre le panneau Sources primaires', async () => {
    const switches: unknown[] = [];
    const onSwitch = (event: Event) => switches.push((event as CustomEvent).detail);
    window.addEventListener('switch-panel', onSwitch);
    try {
      await mountWith({ filePath: null, isDirty: false });

      const item = await screen.findByRole('button', { name: 'primarySources.reembed.status' });
      expect(item).toHaveAttribute('title', 'primarySources.reembed.statusTooltip');
      expect(item).toHaveClass('status-bar__item--warning');
      expect(getReembedProposal).toHaveBeenCalledWith('/p');

      fireEvent.click(item);
      expect(switches).toEqual(['primary-sources']);
    } finally {
      window.removeEventListener('switch-panel', onSwitch);
    }
  });

  it('témoin : rien à réindexer, rien d’affiché', async () => {
    getReembedProposal.mockResolvedValue({ success: true, proposal: null });
    await mountWith({ filePath: null, isDirty: false });

    await waitFor(() => expect(getReembedProposal).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText('primarySources.reembed.status')).toBeNull();
  });
});
