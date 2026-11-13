/**
 * Le préchauffage du dictionnaire de traduction ne survit pas au projet qui l'a lancé (J9).
 *
 * `retrievalService.configure` lance, une fois par processus, l'embedding des 23 termes du dictionnaire
 * FR→EN de la recherche, un par un, avec le fournisseur du projet ouvert. Une demande sans réponse
 * (Ollama qui charge un modèle sans fin) restait ouverte jusqu'au redémarrage de l'app, projet fermé
 * ou non : rien ne la coupait. La libération du fournisseur (fermeture, changement de réglages) la coupe.
 *
 * Vrai `retrievalService` ; simulés : Electron, la configuration, le fournisseur d'embeddings (il se
 * comporte comme `fetch` : une demande retenue ne répond jamais, et rejette par la raison de son
 * signal) et les services voisins que la configuration touche.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  held: [] as Array<{ texts: string[]; signal: AbortSignal | undefined; release: () => void }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userdata-de-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9', ollamaEmbeddingModel: 'faux' }),
    getRAGConfig: () => ({ topK: 5, similarityThreshold: 0.12 }),
    get: () => ({}),
  },
}));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => ({}),
    getEmbedding: () => ({
      id: 'faux-embed',
      model: 'faux',
      dimension: 4,
      embed: (texts: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<number[][]>((resolve, reject) => {
          const signal = opts?.signal;
          state.held.push({ texts, signal, release: () => resolve(texts.map(() => [1, 0, 0, 0])) });
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    }),
    dispose: async () => undefined,
  }),
}));
vi.mock('../tropy-service.js', () => ({ tropyService: { search: vi.fn(async () => []) } }));
vi.mock('../manuscript-index-service.js', () => ({
  manuscriptIndexService: { configure: vi.fn(), clear: vi.fn() },
}));
vi.mock('../reading-notes-index-service.js', () => ({
  readingNotesIndexService: { configure: vi.fn(), clear: vi.fn(), getSearchStore: () => null },
}));

const { retrievalService } = await import('../retrieval-service.js');

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-prechauffage-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  retrievalService.clear();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('préchauffage du dictionnaire de traduction (J9)', () => {
  it('la fermeture du projet coupe sa requête sans réponse', async () => {
    retrievalService.configure({ vectorStore: {} as never, workspaceRoot: path.join(root, 'projet') });
    await vi.waitFor(() => expect(state.held).toHaveLength(1));

    retrievalService.clear();
    try {
      await vi.waitFor(() => expect(state.held[0].signal?.aborted).toBe(true), { timeout: 1_000 });
    } finally {
      // Le défaut : rien ne l'a coupée. La libérer, pour que le préchauffage finisse.
      for (const request of state.held) request.release();
    }
  });
});
