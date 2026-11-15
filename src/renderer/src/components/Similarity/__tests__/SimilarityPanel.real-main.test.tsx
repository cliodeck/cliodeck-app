// @vitest-environment jsdom
/**
 * Le panneau de similarité devant le VRAI main : deux chapitres aux intertitres communs (S13-1-3,
 * revue de L11-2).
 *
 * La relecture du cache gardait tout segment dont le contenu y figurait. Or deux chapitres d'un
 * livre partagent presque toujours des intertitres (« ## Introduction », « ## Conclusion ») ou un
 * astérisme, qui forment chacun un segment, identique d'un chapitre à l'autre : le chapitre 2,
 * jamais analysé, affichait « 4 segments analysés, 1 recommandations » au lieu de l'écran vide et
 * de « Analyser », et l'historien pouvait croire son chapitre analysé.
 *
 * Vrais panneau, stores, handlers `similarity:*` et service, vrai fichier de cache dans un projet
 * temporaire. Simulés : le projet courant du main, la recherche et l'état des corpus.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';

const main = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      main.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('../../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => main.projectPath },
}));
vi.mock('../../../../../main/services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }) },
}));
vi.mock('../../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({ getLLM: () => null, dispose: async () => undefined }),
}));
vi.mock('../../../../../main/services/pdf-service.js', () => ({
  pdfService: {
    // Un seul PDF répond, à tout segment assez long pour être cherché.
    search: async () => [
      {
        sourceType: 'secondary',
        similarity: 0.5,
        document: { id: 'pdf-berstein', title: 'Le 6 février 1934', author: 'Berstein' },
        chunk: { content: 'Extrait', pageNumber: 12 },
      },
    ],
    getIndexFreshness: () => ({
      documentCount: 1,
      chunkCount: 1,
      lastIndexedAt: '2026-11-14T09:00:00.000Z',
      rebuildDue: false,
      collectionDocumentIds: null,
    }),
  },
}));
vi.mock('../../../../../main/services/tropy-service.js', () => ({ tropyService: { getIndexFreshness: () => null } }));
vi.mock('../SimilarityResults', () => ({
  SimilarityResults: () => <div data-testid="results-stub" />,
}));

const { setupSimilarityHandlers } = await import('../../../../../main/ipc/handlers/similarity-handlers');
setupSimilarityHandlers();

import { SimilarityPanel } from '../SimilarityPanel';
import { useSimilarityStore } from '../../../stores/similarityStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';
import type { EditorFacade } from '@/editor/facade';

/** Deux chapitres : chacun son introduction, sa partie sur les sources, son astérisme, sa conclusion. */
const CHAPTER_1 = [
  '# Chapitre 1 : Le 6 février',
  '',
  '## Introduction',
  '',
  'Le préfet Chiappe est muté au Maroc en février 1934, et la rue gronde.',
  '',
  '## Sources et méthode de l’enquête',
  '',
  'Les rapports de police de la série F7 couvrent la nuit du 6 au 7 février.',
  '',
  '* * *',
  '',
  '## Conclusion',
  '',
  'La commission d’enquête siège tout le printemps sans rien conclure.',
].join('\n');

const CHAPTER_2 = [
  '# Chapitre 2 : Le Front populaire',
  '',
  '## Introduction',
  '',
  'Le Front populaire gagne les élections de mai 1936 contre toute attente.',
  '',
  '## Sources et méthode de l’enquête',
  '',
  'Les archives syndicales racontent les occupations d’usines de juin.',
  '',
  '* * *',
  '',
  '## Conclusion',
  '',
  'Les grèves de juin occupent les usines dans une atmosphère de fête.',
].join('\n');

let project = '';
const chapterPath = (n: number) => path.join(project, 'chapters', `0${n}.md`);

const ipc = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = main.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: {} }, ...args) as Promise<unknown>;
};

let similarity: Record<string, ReturnType<typeof vi.fn>>;
let originalElectron: unknown;

/** Une façade qui rend le texte vivant de l'éditeur, comme celle de CM6. */
const facade = (text: string) => ({ getValue: () => text }) as unknown as EditorFacade;

/** Ce que fait `replaceBuffer` quand il ouvre un chapitre : la façade de l'ancien est retirée. */
async function openChapter(n: number, text: string): Promise<void> {
  await act(async () => {
    useEditorStore.setState((s) => ({
      filePath: chapterPath(n),
      content: text,
      isDirty: false,
      documentVersion: s.documentVersion + 1,
      editorFacade: null,
    }));
  });
  await act(async () => {
    useEditorStore.setState({ editorFacade: facade(text) });
  });
}

const shownSegments = () => [...useSimilarityStore.getState().results.values()].map((r) => r.segment.content);

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-panneau-'));
  fs.mkdirSync(path.join(project, '.cliodeck'));
  fs.mkdirSync(path.join(project, 'chapters'));
  fs.writeFileSync(chapterPath(1), CHAPTER_1);
  fs.writeFileSync(chapterPath(2), CHAPTER_2);
  main.projectPath = project;

  originalElectron = (window as unknown as { electron?: unknown }).electron;
  similarity = {
    analyze: vi.fn((...args: unknown[]) => ipc('similarity:analyze', ...args)),
    getAllResults: vi.fn((...args: unknown[]) => ipc('similarity:get-all-results', ...args)),
    onProgress: vi.fn(() => () => undefined),
    cancel: vi.fn((...args: unknown[]) => ipc('similarity:cancel', ...args)),
    clearCache: vi.fn((...args: unknown[]) => ipc('similarity:clear-cache', ...args)),
  };
  (window as unknown as { electron: unknown }).electron = { similarity };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const book = { id: 'livre', name: 'Livre', path: project, type: 'book' as const, createdAt: new Date(), lastOpenedAt: new Date() };
  projectLifecycle.enter(project);
  useProjectStore.setState({ currentProject: book });
  useEditorStore.setState({ filePath: chapterPath(1), content: CHAPTER_1, isDirty: false, editorFacade: facade(CHAPTER_1) });
  useSimilarityStore.setState({ results: new Map(), isPanelOpen: true, isAnalyzing: false, error: null });
  // Le reclassement coupé, comme dans le contrôle à la main : rien ne part vers le modèle.
  useSimilarityStore.getState().setOptions({ useReranking: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSimilarityStore.setState({ isPanelOpen: false, results: new Map(), isAnalyzing: false });
  useSimilarityStore.getState().setOptions({ useReranking: true });
  useEditorStore.setState({ filePath: null, content: '', editorFacade: null });
  useProjectStore.setState({ currentProject: null });
  projectLifecycle.enter(null);
  (window as unknown as { electron?: unknown }).electron = originalElectron;
  fs.rmSync(project, { recursive: true, force: true });
});

it('le chapitre 1 analysé, le chapitre 2 ouvert panneau ouvert : l’écran vide et « Analyser », pas ses intertitres communs', async () => {
  render(<SimilarityPanel />);
  await waitFor(() => expect(similarity.getAllResults).toHaveBeenCalled());

  fireEvent.click(screen.getByText('similarity.analyze'));
  await waitFor(() => expect(useSimilarityStore.getState().isAnalyzing).toBe(false));
  await waitFor(() => expect(screen.getByText('similarity.summary')).toBeTruthy());
  // Témoin : les intertitres communs sont bien des segments de l'analyse du chapitre 1.
  expect(shownSegments()).toEqual(expect.arrayContaining(['## Introduction', '## Sources et méthode de l’enquête', '* * *']));

  await openChapter(2, CHAPTER_2);

  await waitFor(() => expect(similarity.getAllResults).toHaveBeenLastCalledWith(CHAPTER_2, chapterPath(2)));
  await waitFor(() => expect(shownSegments()).toEqual([]));
  expect(screen.getByText('similarity.emptyState')).toBeTruthy();
  expect(screen.queryByText('similarity.summary')).toBeNull();

  // Retour au chapitre 1 : toute son analyse revient.
  await openChapter(1, CHAPTER_1);
  await waitFor(() => expect(shownSegments().length).toBeGreaterThan(0));
  expect(screen.getByText('similarity.summary')).toBeTruthy();
});
