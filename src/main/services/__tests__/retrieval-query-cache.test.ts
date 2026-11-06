/**
 * Le cache des embeddings de requête était rangé sous `embedding.id`, une constante par famille de
 * fournisseur (`'ollama-embedding'`, quel que soit le modèle). Après un passage de nomic-embed-text à
 * bge-m3, la même question reposée recevait le vecteur de l'ancien modèle, comparé à un index
 * réembarqué avec le nouveau, sans aucune erreur.
 *
 * Vrai `retrievalService`, vrai `EnhancedVectorStore` sur un projet vide ; seuls les fournisseurs
 * d'embeddings sont simulés, avec le même id et deux modèles différents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

interface FakeEmbedding {
  id: string;
  model: string;
  dimension: number;
  embed: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

function fakeEmbedding(model: string): FakeEmbedding {
  return {
    id: 'ollama-embedding',
    model,
    dimension: 768,
    embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1))),
    dispose: async () => undefined,
  };
}

const state = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: {} }));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => {
      const embedding = state.current;
      return { getEmbedding: () => embedding, getLLM: () => ({}), dispose: async () => undefined };
    },
  };
});

import { FallbackEmbeddingProvider } from '../../../../backend/core/llm/providers/fallback.js';
import { instrumentEmbedding } from '../../../../backend/core/llm/providers/instrument.js';
import { setInferenceSink } from '../../../../backend/core/usage-journal/context.js';
import type { EmbeddingProvider } from '../../../../backend/core/llm/providers/base.js';
import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import { configManager } from '../config-manager.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';

let project = '';
let store: EnhancedVectorStore | null = null;

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-cache-requete-'));
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama' } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, similarityThreshold: 0.12 } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  store = new EnhancedVectorStore(project);
  await store.initialize();
});

afterEach(() => {
  retrievalService.clear();
  store?.close();
  store = null;
  fs.rmSync(project, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const askedWith = (provider: FakeEmbedding, needle: string): boolean =>
  provider.embed.mock.calls.some(([texts]) => (texts as string[]).some((t) => t.includes(needle)));

describe.skipIf(!sqliteAvailable)('cache des embeddings de requête', () => {
  it('même question, même id de fournisseur, autre modèle : le nouveau modèle est appelé', async () => {
    const nomic = fakeEmbedding('nomic-embed-text');
    const bge = fakeEmbedding('bge-m3');
    const question = 'Que dit Braudel de la Méditerranée zxq-cache ?';

    state.current = nomic;
    retrievalService.configure({ vectorStore: store!, workspaceRoot: project });
    await retrievalService.search({ query: question, sourceType: 'secondary' });
    expect(askedWith(nomic, 'zxq-cache')).toBe(true);

    state.current = bge;
    retrievalService.rebuildEmbeddingProvider();
    await retrievalService.search({ query: question, sourceType: 'secondary' });

    expect(askedWith(bge, 'zxq-cache')).toBe(true);
  });

  it('même modèle : le cache sert toujours', async () => {
    const first = fakeEmbedding('nomic-embed-text');
    const again = fakeEmbedding('nomic-embed-text');
    const question = 'Les ports de Gênes zxq-temoin ?';

    state.current = first;
    retrievalService.configure({ vectorStore: store!, workspaceRoot: project });
    await retrievalService.search({ query: question, sourceType: 'secondary' });

    state.current = again;
    retrievalService.rebuildEmbeddingProvider();
    await retrievalService.search({ query: question, sourceType: 'secondary' });

    expect(askedWith(first, 'zxq-temoin')).toBe(true);
    expect(askedWith(again, 'zxq-temoin')).toBe(false);
  });

  it('mode « auto » : le vecteur du modèle de repli n’est pas rangé sous la clé du primaire', async () => {
    // Avant tout sondage, le repli annonce le modèle du primaire ; `embed` sonde ensuite et bascule.
    // La clé lue avant l'appel rangeait le vecteur du modèle embarqué sous celle d'Ollama, et le
    // resservait une fois Ollama revenu.
    let now = 0;
    let ollamaUp = false;
    const ollama = { ...fakeEmbedding('nomic-embed-text'), healthCheck: vi.fn(async () => ({ state: ollamaUp ? 'ready' : 'failed' })) };
    const embedded = { ...fakeEmbedding('nomic-embed-text-v2'), id: 'embedded-embedding', healthCheck: vi.fn(async () => ({ state: 'ready' })) };
    const question = 'Les grèves de 1936 zxq-repli ?';

    // Comme le vrai registre (`ProviderRegistry.getEmbedding`) : le repli est enveloppé par le
    // décorateur du journal d'usage. Sans l'enveloppe, le test ne voyait pas que le correctif ne
    // s'exécutait jamais en production.
    state.current = instrumentEmbedding(
      new FallbackEmbeddingProvider(
        ollama as unknown as EmbeddingProvider,
        embedded as unknown as EmbeddingProvider,
        () => now
      ),
      'ollama',
      'http://127.0.0.1:11434'
    );
    const journal: Array<{ kind: string; model?: string }> = [];
    setInferenceSink((input) => journal.push(input));
    retrievalService.configure({ vectorStore: store!, workspaceRoot: project });
    await retrievalService.search({ query: question, sourceType: 'secondary' });
    expect(askedWith(embedded, 'zxq-repli')).toBe(true);

    // Ollama revient, après la durée de validité du sondage ; une autre question le fait choisir.
    ollamaUp = true;
    now += 60_000;
    await retrievalService.search({ query: 'Le Front populaire zxq-autre ?', sourceType: 'secondary' });
    expect(askedWith(ollama, 'zxq-autre')).toBe(true);

    // La même question qu'au début doit partir vers Ollama, pas ressortir le vecteur de l'embarqué.
    await retrievalService.search({ query: question, sourceType: 'secondary' });

    expect(askedWith(ollama, 'zxq-repli')).toBe(true);

    // Les embeddings de requête restent au journal d'usage, sous le modèle qui les a produits.
    setInferenceSink(undefined);
    const models = journal.filter((e) => e.kind === 'embedding').map((e) => e.model);
    expect(models).toContain('nomic-embed-text-v2');
    expect(models).toContain('nomic-embed-text');
  });
});
