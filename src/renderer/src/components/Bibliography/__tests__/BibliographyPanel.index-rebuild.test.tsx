// @vitest-environment jsdom
/**
 * J8 : à la réouverture du projet, le panneau Bibliographie propose de reconstruire l'index de
 * recherche des PDF qu'une session précédente a laissé périmé. Rien ne le disait : l'index gardait
 * les extraits de PDF retirés, qui prenaient des places dans les réponses, en silence.
 *
 * Le panneau tel quel ; le main est simulé par `window.electron.pdf`, et le projet à l'écran passe
 * par le vrai registre (`projectLifecycle`), comme le fait `projectStore`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Progress = { current: number; total: number; status: string; percentage: number; phase: 'running' | 'done' | 'failed' };

const preload = vi.hoisted(() => {
  const progressListeners: Array<(progress: Progress) => void> = [];
  const electron = (window as unknown as { electron: { project: Record<string, unknown> } }).electron;
  // Les stores s'abonnent au suivi de reconstruction à leur chargement : on garde leurs écouteurs.
  electron.project = {
    ...electron.project,
    onRebuildProgress: (callback: (progress: Progress) => void) => {
      progressListeners.push(callback);
      return () => undefined;
    },
  };
  return { progressListeners };
});

vi.mock('../CitationList', () => ({ CitationList: () => null }));
vi.mock('../ZoteroImport', () => ({ ZoteroImport: () => null }));
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
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

let getIndexState: ReturnType<typeof vi.fn>;
let rebuildIndex: ReturnType<typeof vi.fn>;

const electron = () => (window as unknown as { electron: { pdf?: unknown } }).electron;

/** L'écran passe au projet `path`, comme `openProjectContents`. */
function enterProject(path: string | null): void {
  act(() => {
    projectLifecycle.enter(path);
    useProjectStore.setState({
      currentProject:
        path === null
          ? null
          : { id: path, name: 'Thèse', path, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    } as never);
  });
}

function showPanel(): void {
  act(() => {
    render(<BibliographyPanel />);
  });
}

const notice = () => screen.queryByText('pdfIndexRebuild.title');

function finishRebuild(phase: 'done' | 'failed'): void {
  act(() => {
    for (const listener of preload.progressListeners) {
      listener({ current: 100, total: 100, status: 'Rebuild complete', percentage: 100, phase });
    }
  });
}

beforeEach(() => {
  getIndexState = vi.fn(async () => ({ success: true, rebuildDue: true }));
  rebuildIndex = vi.fn(async () => ({ success: true, started: true }));
  electron().pdf = { getIndexState, rebuildIndex };
  useBibliographyStore.setState({
    citations: [],
    filteredCitations: [],
    refreshIndexedPDFs: vi.fn(async () => undefined),
    loadReadingNotes: vi.fn(async () => undefined),
  } as never);
  enterProject('/p/these');
});

afterEach(() => {
  cleanup();
  enterProject(null);
  delete electron().pdf;
});

describe('l’index des PDF à reconstruire, proposé à la réouverture (J8)', () => {
  it('le bandeau le propose, pour le projet ouvert', async () => {
    showPanel();

    expect(await screen.findByText('pdfIndexRebuild.title')).toBeInTheDocument();
    expect(screen.getByText('pdfIndexRebuild.message')).toBeInTheDocument();
    expect(getIndexState).toHaveBeenCalledWith('/p/these');
  });

  it('« Reconstruire » le retire, et la reconstruction part pour ce projet', async () => {
    showPanel();
    await screen.findByText('pdfIndexRebuild.title');

    fireEvent.click(screen.getByRole('button', { name: /pdfIndexRebuild\.rebuild/ }));

    await waitFor(() => expect(rebuildIndex).toHaveBeenCalledWith('/p/these'));
    expect(notice()).toBeNull();
    // Sa fin relit l'état du main : plus rien à proposer.
    getIndexState.mockResolvedValue({ success: true, rebuildDue: false });
    finishRebuild('done');
    await waitFor(() => expect(getIndexState).toHaveBeenCalledTimes(2));
    expect(notice()).toBeNull();
  });

  it('rien n’est parti (plus rien à proposer) : l’état du main fait foi', async () => {
    rebuildIndex.mockResolvedValue({ success: true, started: false });
    showPanel();
    await screen.findByText('pdfIndexRebuild.title');
    getIndexState.mockResolvedValue({ success: true, rebuildDue: false });

    fireEvent.click(screen.getByRole('button', { name: /pdfIndexRebuild\.rebuild/ }));

    await waitFor(() => expect(getIndexState).toHaveBeenCalledTimes(2));
    expect(notice()).toBeNull();
  });

  it('fermé sans reconstruire : rien ne part, et il revient à la réouverture suivante', async () => {
    showPanel();
    await screen.findByText('pdfIndexRebuild.title');

    fireEvent.click(screen.getByRole('button', { name: 'pdfIndexRebuild.later' }));

    expect(notice()).toBeNull();
    expect(rebuildIndex).not.toHaveBeenCalled();
    enterProject(null);
    enterProject('/p/these');
    expect(await screen.findByText('pdfIndexRebuild.title')).toBeInTheDocument();
  });

  it('une reconstruction de la session (après une réindexation) finit : le bandeau part avec la marque', async () => {
    showPanel();
    await screen.findByText('pdfIndexRebuild.title');
    getIndexState.mockResolvedValue({ success: true, rebuildDue: false });

    finishRebuild('done');

    await waitFor(() => expect(notice()).toBeNull());
  });

  it('un index sain : pas de bandeau', async () => {
    getIndexState.mockResolvedValue({ success: true, rebuildDue: false });
    showPanel();

    await waitFor(() => expect(getIndexState).toHaveBeenCalled());
    await act(async () => undefined);
    expect(notice()).toBeNull();
  });

  it('la réponse d’un projet quitté ne s’affiche pas dans le suivant', async () => {
    let answerA: (value: { success: boolean; rebuildDue: boolean }) => void = () => undefined;
    getIndexState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerA = resolve;
        })
    );
    showPanel();
    await waitFor(() => expect(getIndexState).toHaveBeenCalledWith('/p/these'));

    getIndexState.mockResolvedValue({ success: true, rebuildDue: false });
    enterProject('/p/autre');
    await waitFor(() => expect(getIndexState).toHaveBeenCalledWith('/p/autre'));
    await act(async () => {
      answerA({ success: true, rebuildDue: true });
    });

    expect(notice()).toBeNull();
  });
});
