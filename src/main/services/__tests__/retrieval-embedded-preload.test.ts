/**
 * Le modèle d'embeddings embarqué de la recherche se charge à l'ouverture du projet, sans qu'aucun
 * texte ne parte ni que rien ne s'inscrive au journal d'usage (revue de L09-16, J11).
 *
 * La recherche a son propre registre, donc son propre client llama.cpp : le préchauffage de
 * `pdfService` (`warmup query`) charge celui de l'indexeur, pas le sien (le partage d'un GGUF entre
 * clients est à venir, L08-16). Les 23 termes du dictionnaire d'expansion, embarqués à la première
 * ouverture, le chargeaient en passant. Ils ne partent plus : sans préchargement, la première
 * question attendait le chargement du modèle.
 *
 * Le préchargement ne vaut que pour le moteur embarqué : Ollama tient son modèle dans son démon, que
 * `warmup query` a déjà chargé, et le `healthCheck` d'un fournisseur distant peut envoyer un texte
 * (celui de Gemini embarque « ping »).
 *
 * Vrais `retrievalService`, `FallbackEmbeddingProvider`, `EmbeddedEmbeddingProvider` et décorateur
 * du journal. Simulés : la configuration, le client llama.cpp du moteur embarqué (il compte ses
 * chargements et ses embeddings), Ollama et le fournisseur distant, les corpus voisins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EmbeddingProvider, ProviderStatus } from '../../../../backend/core/llm/providers/base.js';
import type { EmbeddedLLMClient } from '../../../../backend/core/llm/EmbeddedLLMClient.js';
import type { RecordInferenceInput } from '../../../../backend/core/usage-journal/types.js';
import type { VectorStore } from '../../../../backend/core/vector-store/VectorStore.js';

const state = vi.hoisted(() => ({
  /** Le fournisseur d'embeddings du prochain registre, tel que l'adaptateur l'assemblerait. */
  makeEmbedding: null as (() => unknown) | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userdata-de-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }),
    getRAGConfig: () => ({ topK: 5, similarityThreshold: 0.12 }),
    get: () => ({}),
  },
}));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => {
    const embedding = state.makeEmbedding?.() as EmbeddingProvider;
    return {
      getLLM: () => ({}),
      getEmbedding: () => embedding,
      dispose: async () => embedding.dispose(),
    };
  },
}));
vi.mock('../tropy-service.js', () => ({ tropyService: { search: vi.fn(async () => []) } }));
vi.mock('../manuscript-index-service.js', () => ({
  manuscriptIndexService: { configure: vi.fn(), clear: vi.fn() },
}));
vi.mock('../reading-notes-index-service.js', () => ({
  readingNotesIndexService: { configure: vi.fn(), clear: vi.fn(), getSearchStore: () => null },
}));

const { retrievalService } = await import('../retrieval-service.js');
const { EmbeddedEmbeddingProvider } = await import('../../../../backend/core/llm/providers/embedded.js');
const { FallbackEmbeddingProvider } = await import('../../../../backend/core/llm/providers/fallback.js');
const { instrumentEmbedding } = await import('../../../../backend/core/llm/providers/instrument.js');
const { setInferenceSink } = await import('../../../../backend/core/usage-journal/context.js');

/** Le client llama.cpp du moteur embarqué : il compte ses chargements et ses embeddings. */
function llamaClient() {
  const calls = { loads: 0, embeddings: [] as string[], disposed: 0 };
  const client = {
    initializeEmbedding: async () => {
      calls.loads++;
      return true;
    },
    generateEmbedding: async (text: string) => {
      calls.embeddings.push(text);
      return new Float32Array([1, 0]);
    },
    getEmbeddingDimensions: () => 2,
    dispose: async () => {
      calls.disposed++;
    },
  };
  return { calls, client: client as unknown as EmbeddedLLMClient };
}

function embedded(client: EmbeddedLLMClient): EmbeddingProvider {
  return new EmbeddedEmbeddingProvider({
    modelPath: '/modeles/nomic-embed-text-v2.gguf',
    modelId: 'nomic-embed-text-v2',
    dimension: 2,
    client,
  });
}

/** Ollama simulé : son sondage (la liste des modèles, aucun texte) répond `up`, après `gate`. */
function ollama(up: boolean, gate: Promise<void> = Promise.resolve()) {
  const sent: string[] = [];
  const probes = { count: 0 };
  const status: ProviderStatus = up ? { state: 'ready' } : { state: 'failed' };
  const provider: EmbeddingProvider = {
    id: 'ollama-embedding',
    name: 'Ollama',
    model: 'nomic-embed-text',
    dimension: 2,
    getStatus: () => status,
    healthCheck: async () => {
      probes.count++;
      await gate;
      return status;
    },
    dispose: async () => undefined,
    embed: async (texts) => {
      sent.push(...texts);
      return texts.map(() => [1, 0]);
    },
  };
  return { provider, sent, probes };
}

/** Toutes les suites de promesses déjà résolues ont tourné : aucun délai, aucune horloge. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let project = '';
let events: RecordInferenceInput[];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-prechargement-'));
  events = [];
  setInferenceSink((e) => events.push(e));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  retrievalService.clear();
  await settle();
  setInferenceSink(undefined);
  state.makeEmbedding = null;
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

const open = (): void =>
  retrievalService.configure({ vectorStore: {} as VectorStore, workspaceRoot: project });

describe('ouvrir un projet charge le modèle embarqué de la recherche, sans rien envoyer', () => {
  it('réglage « embarqué » : le modèle se charge, aucun embedding n’est calculé, rien n’est inscrit', async () => {
    const llama = llamaClient();
    state.makeEmbedding = () => instrumentEmbedding(embedded(llama.client), 'embedded');

    open();

    await vi.waitFor(() => expect(llama.calls.loads).toBe(1), { timeout: 5_000 });
    expect(llama.calls.embeddings).toEqual([]);
    expect(events).toEqual([]);
  });

  it('réglage « auto », Ollama arrêté : le modèle embarqué se charge, et rien ne part vers Ollama', async () => {
    const llama = llamaClient();
    const down = ollama(false);
    state.makeEmbedding = () =>
      instrumentEmbedding(
        new FallbackEmbeddingProvider(down.provider, embedded(llama.client)),
        'ollama',
        'http://127.0.0.1:11434'
      );

    open();

    await vi.waitFor(() => expect(llama.calls.loads).toBe(1), { timeout: 5_000 });
    expect(llama.calls.embeddings).toEqual([]);
    expect(down.sent).toEqual([]);
    expect(events).toEqual([]);
  });

  it('réglage « auto », Ollama disponible : le modèle embarqué ne se charge pas, et aucun texte ne part', async () => {
    const llama = llamaClient();
    const up = ollama(true);
    state.makeEmbedding = () =>
      instrumentEmbedding(
        new FallbackEmbeddingProvider(up.provider, embedded(llama.client)),
        'ollama',
        'http://127.0.0.1:11434'
      );

    open();
    await vi.waitFor(() => expect(up.probes.count).toBe(1), { timeout: 5_000 });
    await settle();

    expect(llama.calls.loads).toBe(0);
    expect(up.sent).toEqual([]);
    expect(events).toEqual([]);
  });

  it('fournisseur distant : son `healthCheck`, qui envoie un texte, n’est pas appelé', async () => {
    const sent: string[] = [];
    const cloud: EmbeddingProvider = {
      id: 'gemini-embedding',
      name: 'Gemini',
      model: 'text-embedding-004',
      dimension: 2,
      getStatus: () => ({ state: 'ready' }),
      // Comme le vrai : le sondage embarque « ping ».
      healthCheck: async () => {
        sent.push('ping');
        return { state: 'ready' };
      },
      dispose: async () => undefined,
      embed: async (texts) => {
        sent.push(...texts);
        return texts.map(() => [1, 0]);
      },
    };
    state.makeEmbedding = () => instrumentEmbedding(cloud, 'gemini');

    open();
    await settle();

    expect(sent).toEqual([]);
    expect(events).toEqual([]);
  });

  it('projet fermé pendant le sondage d’Ollama : le modèle de son registre libéré ne se charge pas', async () => {
    const llama = llamaClient();
    let answer = (): void => undefined;
    const down = ollama(false, new Promise<void>((resolve) => (answer = resolve)));
    state.makeEmbedding = () =>
      instrumentEmbedding(
        new FallbackEmbeddingProvider(down.provider, embedded(llama.client)),
        'ollama',
        'http://127.0.0.1:11434'
      );

    open();
    await vi.waitFor(() => expect(down.probes.count).toBe(1), { timeout: 5_000 });
    retrievalService.clear();
    await vi.waitFor(() => expect(llama.calls.disposed).toBeGreaterThan(0), { timeout: 5_000 });
    answer();
    await settle();

    // Chargé ici, le modèle resterait au client libéré jusqu'à la sortie de l'app.
    expect(llama.calls.loads).toBe(0);
  });
});
