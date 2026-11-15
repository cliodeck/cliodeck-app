// @vitest-environment jsdom
/**
 * Le panneau de similarité ne montre que le document ouvert (S13-1-3).
 *
 * Il relisait le cache à son ouverture seulement, sans dire quel texte il affichait, et le main
 * rendait l'analyse du dernier texte analysé : dans un livre, les segments et les lignes du
 * chapitre 1 restaient sur le chapitre 2. « Analyser » envoyait le miroir du store, qui a jusqu'à
 * 300 ms de retard sur la frappe.
 *
 * Vrais panneau et stores ; le pont `window.electron.similarity` est simulé, et rend le cache d'un
 * texte comme le ferait le main : les segments de ce texte seulement.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../SimilarityResults', () => ({
  SimilarityResults: () => <div data-testid="results-stub" />,
}));

import { SimilarityPanel } from '../SimilarityPanel';
import { useSimilarityStore } from '../../../stores/similarityStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';
import type { EditorFacade } from '@/editor/facade';

const PROJECT = {
  id: 'livre',
  name: 'Livre',
  path: '/projets/livre',
  type: 'book' as const,
  createdAt: new Date(),
  lastOpenedAt: new Date(),
};

const CHAPTER_1 = '# Chapitre 1\n\nLe préfet Chiappe est muté au Maroc en février 1934.';
const CHAPTER_2 = '# Chapitre 2\n\nLe Front populaire gagne les élections de mai 1936.';

const result = (id: string) => ({
  segmentId: id,
  segment: { id, content: `Segment ${id}`, startLine: 2, endLine: 2, type: 'paragraph' },
  recommendations: [],
  analyzedAt: 1,
});

/**
 * Le cache du main : un seul par projet, celui de la dernière analyse. Il ne rend que les segments
 * du texte reçu ; appelé sans texte, comme avant S13-1-3, il rendait toute la dernière analyse.
 */
let cache: { text: string; results: unknown[] } | null = null;
const cachedFor = (text?: string): unknown[] => {
  if (!cache) return [];
  if (text === undefined) return cache.results;
  return cache.text === text ? cache.results : [];
};

function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let similarity: Record<string, ReturnType<typeof vi.fn>>;
let originalElectron: unknown;

/** Une façade qui rend le texte vivant de l'éditeur, comme celle de CM6. */
const facade = (text: string) => ({ getValue: () => text }) as unknown as EditorFacade;

/** Ce que fait `replaceBuffer` quand il ouvre un chapitre : la façade de l'ancien est retirée. */
async function openChapter(filePath: string, text: string): Promise<void> {
  await act(async () => {
    useEditorStore.setState((s) => ({
      filePath,
      content: text,
      isDirty: false,
      documentVersion: s.documentVersion + 1,
      editorFacade: null,
    }));
  });
  // La vue du chapitre entrant se monte et pose sa façade.
  await act(async () => {
    useEditorStore.setState({ editorFacade: facade(text) });
  });
}

const shownSegments = () => [...useSimilarityStore.getState().results.keys()];

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  // Le chapitre 1 a été analysé.
  cache = { text: CHAPTER_1, results: [result('seg-ch1')] };
  similarity = {
    getAllResults: vi.fn(async (text?: string) => ({ success: true, results: cachedFor(text) })),
    analyze: vi.fn(async () => ({ success: true, results: [] })),
    onProgress: vi.fn(() => () => undefined),
    cancel: vi.fn(async () => ({ success: true })),
    clearCache: vi.fn(async () => ({ success: true })),
  };
  (window as unknown as { electron: unknown }).electron = { similarity };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  projectLifecycle.enter(PROJECT.path);
  useProjectStore.setState({ currentProject: PROJECT });
  useEditorStore.setState({
    filePath: '/projets/livre/chapters/01.md',
    content: CHAPTER_1,
    isDirty: false,
    editorFacade: facade(CHAPTER_1),
  });
  useSimilarityStore.setState({ results: new Map(), isPanelOpen: true, isAnalyzing: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSimilarityStore.setState({ isPanelOpen: false, results: new Map(), isAnalyzing: false });
  useEditorStore.setState({ filePath: null, content: '', editorFacade: null });
  useProjectStore.setState({ currentProject: null });
  projectLifecycle.enter(null);
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

it('ouvrir un autre chapitre, panneau ouvert : relu avec le texte du chapitre, la liste se vide', async () => {
  render(<SimilarityPanel />);
  await waitFor(() => expect(shownSegments()).toEqual(['seg-ch1']));

  await openChapter('/projets/livre/chapters/02.md', CHAPTER_2);

  await waitFor(() => expect(similarity.getAllResults).toHaveBeenLastCalledWith(CHAPTER_2));
  expect(shownSegments()).toEqual([]);

  // Retour au chapitre 1 : son analyse revient.
  await openChapter('/projets/livre/chapters/01.md', CHAPTER_1);
  await waitFor(() => expect(shownSegments()).toEqual(['seg-ch1']));
});

it('« Analyser » envoie le texte de l’éditeur vivant, plus récent que le miroir du store', async () => {
  const typed = `${CHAPTER_2}\n\nUne phrase tapée à l’instant.`;
  cache = null;
  useEditorStore.setState({ filePath: '/projets/livre/chapters/02.md', content: CHAPTER_2, editorFacade: facade(typed) });
  render(<SimilarityPanel />);
  await waitFor(() => expect(similarity.getAllResults).toHaveBeenCalled());

  fireEvent.click(screen.getByText('similarity.analyze'));

  await waitFor(() => expect(similarity.analyze).toHaveBeenCalledTimes(1));
  expect(similarity.analyze.mock.calls[0][0]).toBe(typed);
});

it('une analyse du chapitre 1 finie après l’ouverture du chapitre 2 ne s’y affiche pas', async () => {
  const analysis = held<unknown>();
  similarity.analyze.mockReturnValueOnce(analysis.promise);
  cache = null;
  render(<SimilarityPanel />);
  await waitFor(() => expect(similarity.getAllResults).toHaveBeenCalled());
  fireEvent.click(screen.getByText('similarity.analyze'));
  await waitFor(() => expect(useSimilarityStore.getState().isAnalyzing).toBe(true));

  await openChapter('/projets/livre/chapters/02.md', CHAPTER_2);
  await waitFor(() => expect(similarity.getAllResults).toHaveBeenLastCalledWith(CHAPTER_2));
  // Le main a fini, et écrit le cache du chapitre 1.
  cache = { text: CHAPTER_1, results: [result('seg-ch1')] };
  await act(async () => {
    analysis.release({ success: true, results: [result('seg-ch1')] });
  });

  await waitFor(() => expect(useSimilarityStore.getState().isAnalyzing).toBe(false));
  expect(shownSegments()).toEqual([]);

  // De retour sur le chapitre 1, son analyse est là.
  await openChapter('/projets/livre/chapters/01.md', CHAPTER_1);
  await waitFor(() => expect(shownSegments()).toEqual(['seg-ch1']));
});
