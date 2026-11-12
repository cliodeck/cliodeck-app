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

  // S04-2-5 : `searchWithStats` publiait `cacheHit: false` en dur, et le panneau d'explication ne
  // pouvait jamais dire « (cache) ». « Vient du cache » : l'embedding de la question elle-même était
  // déjà là avant ce tour.
  it('panneau d’explication : cacheHit dit si l’embedding de la question était déjà en cache', async () => {
    const nomic = fakeEmbedding('nomic-embed-text');
    const question = 'La flotte de Venise zxq-mention ?';

    state.current = nomic;
    retrievalService.configure({ vectorStore: store!, workspaceRoot: project });
    const first = await retrievalService.searchWithStats({ query: question, sourceType: 'secondary' });
    expect(askedWith(nomic, 'zxq-mention')).toBe(true);
    expect(first.stats.search.cacheHit).toBe(false);

    // La même question reposée : le fournisseur n'est plus appelé, et le panneau le dit.
    nomic.embed.mockClear();
    const again = await retrievalService.searchWithStats({ query: question, sourceType: 'secondary' });
    expect(askedWith(nomic, 'zxq-mention')).toBe(false);
    expect(again.stats.search.cacheHit).toBe(true);

    // Sources primaires seules : Tropy embarque la question de son côté, ce cache n'a rien servi.
    const primaryOnly = await retrievalService.searchWithStats({ query: question, sourceType: 'primary' });
    expect(primaryOnly.stats.search.cacheHit).toBe(false);

    // Une autre question n'est pas servie par le cache.
    const other = await retrievalService.searchWithStats({ query: 'Le sel de Venise zxq-autre-mention ?', sourceType: 'secondary' });
    expect(other.stats.search.cacheHit).toBe(false);

    // Autre modèle : la clé du cache change, la même question est embarquée de nouveau.
    const bge = fakeEmbedding('bge-m3');
    state.current = bge;
    retrievalService.rebuildEmbeddingProvider();
    const otherModel = await retrievalService.searchWithStats({ query: question, sourceType: 'secondary' });
    expect(askedWith(bge, 'zxq-mention')).toBe(true);
    expect(otherModel.stats.search.cacheHit).toBe(false);
  });

  // Plusieurs corpus dans la portée (le cas ordinaire en Écriture : le manuscrit est indexé par
  // défaut). `fanOutCorpora` les interroge l'un après l'autre : la bibliographie embarque la question
  // et la range dans le cache, puis le vault et le manuscrit l'y trouvent dans le même tour. Seule la
  // première consultation dit l'état d'avant le tour ; sans cette règle, une question posée pour la
  // première fois afficherait « (cache) ».
  it('panneau d’explication : plusieurs corpus dans le même tour, la première question ne vient pas du cache', async () => {
    const nomic = fakeEmbedding('nomic-embed-text');
    const question = 'Les galères de Raguse zxq-plusieurs ?';
    const query = { query: question, sourceType: 'secondary' as const, includeVault: true, includeManuscript: true };

    state.current = nomic;
    retrievalService.configure({ vectorStore: store!, workspaceRoot: project });
    const first = await retrievalService.searchWithStats(query);

    // Trois corpus ont consulté le cache, et le fournisseur n'a embarqué la question qu'une fois : les
    // deux derniers l'ont trouvée en cache, rangée par le premier.
    const attempted = first.outcomes.filter((o) => o.attempted).map((o) => o.source);
    expect(attempted).toEqual(expect.arrayContaining(['secondary', 'vault', 'manuscript']));
    const embeddedQuestion = nomic.embed.mock.calls.filter(([texts]) => (texts as string[]).includes(question));
    expect(embeddedQuestion).toHaveLength(1);
    expect(first.stats.search.cacheHit).toBe(false);

    nomic.embed.mockClear();
    const again = await retrievalService.searchWithStats(query);
    expect(askedWith(nomic, 'zxq-plusieurs')).toBe(false);
    expect(again.stats.search.cacheHit).toBe(true);
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
