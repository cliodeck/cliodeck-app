/**
 * Une recherche ne lit jamais un magasin fermé (S04-1-14).
 *
 * `retrievalService.search` prend le magasin du projet, puis attend l'embedding de la requête. La
 * fermeture du projet passait pendant ce temps : `pdfService.close()` n'attendait que les
 * indexations, fermait le magasin, et la recherche le lisait ensuite (« The database connection is
 * not open »). La bibliographie tombait en échec, et la réponse partait sans ses PDF.
 *
 * Vrai `pdfService`, vrai `retrievalService`, vrai `VectorStore` sur un vrai `brain.db` temporaire.
 * Simulés : le fournisseur d'embeddings (une requête « lente » attend qu'on la libère), Tropy, et les
 * services d'indexation du manuscrit et des notes de lecture. `closeProject` ferme dans l'ordre de la
 * séquence (`project-services.ts`, à rebours de l'ouverture) : le service PDF, puis la recherche.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import type { VectorStore } from '../../../../backend/core/vector-store/VectorStore.js';
import type { PDFDocument } from '../../../../backend/types/pdf-document.js';

const state = vi.hoisted(() => ({
  /** Une requête qui commence par « lente » attend cette promesse. */
  gate: Promise.resolve(),
  onHold: (): void => undefined,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userdata-de-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9', ollamaEmbeddingModel: 'faux' }),
    // Recherche linéaire : le vrai `VectorStore`, qui lit SQLite à chaque recherche.
    getRAGConfig: () => ({
      topK: 5,
      similarityThreshold: 0.12,
      chunkingConfig: 'cpuOptimized',
      useHNSWIndex: false,
      useHybridSearch: false,
    }),
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
      embed: async (texts: string[]) => {
        if (texts.some((t) => t.startsWith('lente'))) {
          state.onHold();
          await state.gate;
        }
        return texts.map(() => [1, 0, 0, 0]);
      },
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
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));

const { pdfService } = await import('../pdf-service.js');
// `SEARCH_DRAIN_MS` : le délai borné de `drainSearches`, au-delà duquel la fermeture n'attend plus.
const { retrievalService, SEARCH_DRAIN_MS } = await import('../retrieval-service.js');

let projectA = '';
let projectB = '';
let warn: ReturnType<typeof vi.spyOn>;
/** Chaque requête est neuve : le cache d'embeddings du module ne doit pas répondre à la place du fournisseur. */
let turn = 0;
const slowQuery = (): string => `lente ${++turn}`;
const quickQuery = (): string => `rapide ${++turn}`;

/** La prochaine requête lente attend `release()` ; `started` se résout quand elle attend. */
function holdNextSlowQuery(): { started: Promise<void>; release: () => void } {
  let release!: () => void;
  state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    state.onHold = resolve;
  });
  return { started, release };
}

function seed(title: string): void {
  const store = pdfService.getVectorStore() as VectorStore;
  const id = `doc-${title}`;
  const document: PDFDocument = {
    id,
    fileURL: `/pdf/${title}.pdf`,
    title,
    pageCount: 1,
    metadata: { keywords: [] },
    createdAt: new Date(),
    indexedAt: new Date(),
    lastAccessedAt: new Date(),
    get displayString() {
      return title;
    },
  };
  store.saveDocument(document);
  store.saveChunk(
    { id: `chunk-${title}`, documentId: id, content: `Texte de ${title}`, pageNumber: 1, chunkIndex: 0, startPosition: 0, endPosition: 10 },
    new Float32Array([1, 0, 0, 0])
  );
}

/** La fermeture d'un projet par la séquence : le service PDF, puis la recherche. */
async function closeProject(): Promise<void> {
  await pdfService.close();
  retrievalService.clear();
}

const titles = (hits: Array<{ document?: { title?: string } }>): Array<string | undefined> =>
  hits.map((h) => h.document?.title);

/** Ce que le main a écrit en avertissement : c'est là que la bibliographie disait son échec. */
const warnings = (): string => warn.mock.calls.flat().map(String).join('\n');

/** Combien de fois une fermeture a dû attendre une recherche jusqu'au bout de son délai. */
const drainTimeouts = (): number =>
  warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('Recherche(s) toujours en vol')).length;

/** Le résultat d'une recherche, ou son erreur, sans rejet non attendu. */
function settle<T>(searching: Promise<T>): Promise<{ hits: T | null; error: unknown }> {
  return searching.then(
    (hits) => ({ hits, error: null as unknown }),
    (error: unknown) => ({ hits: null, error })
  );
}

beforeEach(async () => {
  projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-recherche-a-'));
  projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-recherche-b-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await pdfService.init(projectA);
  seed('Document de A');
});

afterEach(async () => {
  vi.useRealTimers();
  await closeProject();
  vi.restoreAllMocks();
  state.gate = Promise.resolve();
  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('une recherche et la fermeture de son magasin (S04-1-14)', () => {
  it('une recherche en vol finit avant la fermeture du magasin', async () => {
    const slow = holdNextSlowQuery();
    const searching = pdfService.search(slowQuery(), { sourceType: 'secondary' });
    await slow.started;

    let closed = false;
    const closing = closeProject().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // La fermeture attend la recherche, qui attend son embedding.
    expect(closed).toBe(false);

    slow.release();
    expect(titles(await searching)).toEqual(['Document de A']);
    await closing;
    expect(warnings()).not.toContain('database connection is not open');
  });

  it('une recherche bloquée au-delà du délai n’empêche pas la fermeture, et n’est pas servie avec le corpus du projet suivant', async () => {
    const slow = holdNextSlowQuery();
    const searching = pdfService.search(slowQuery(), { sourceType: 'secondary' });
    const outcome = searching.then(
      (hits) => ({ hits, error: null as unknown }),
      (error: unknown) => ({ hits: null, error })
    );
    await slow.started;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = closeProject();
    await vi.advanceTimersByTimeAsync(SEARCH_DRAIN_MS);
    // Pas d'attente sans sortie : le délai tombé, le magasin se ferme quand même.
    await closing;
    vi.useRealTimers();

    // B s'ouvre, avec ses propres PDF, avant que l'embedding de la recherche de A ne revienne.
    await pdfService.init(projectB);
    seed('Document de B');
    slow.release();

    const { hits, error } = await outcome;
    expect(hits).toBeNull();
    expect(error).toMatchObject({ code: 'project-changed' });
    expect(warnings()).not.toContain('database connection is not open');
    // Une recherche dans B répond avec les PDF de B.
    expect(titles(await pdfService.search(quickQuery(), { sourceType: 'secondary' }))).toEqual(['Document de B']);
  });

  /**
   * Dans la séquence, une attente sépare `store.close()` de `retrievalService.clear()` : le service PDF
   * libère ses registres. Une recherche dont l'embedding revient dans cette fenêtre ne lit pas le
   * magasin fermé : `drainSearches` a rendu le magasin, délai dépassé ou non, sans attendre `clear()`.
   */
  it('une recherche dont l’embedding revient entre la fermeture du magasin et `clear()` s’arrête sur `project-changed`', async () => {
    const slow = holdNextSlowQuery();
    const outcome = settle(pdfService.search(slowQuery(), { sourceType: 'secondary' }));
    await slow.started;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = pdfService.close();
    await vi.advanceTimersByTimeAsync(SEARCH_DRAIN_MS);
    await closing;
    vi.useRealTimers();

    // Magasin fermé, `clear()` pas encore passé : l'embedding revient maintenant.
    slow.release();
    const { hits, error } = await outcome;
    retrievalService.clear();

    expect(hits).toBeNull();
    expect(error).toMatchObject({ code: 'project-changed' });
    expect(warnings()).not.toContain('database connection is not open');
  });

  /**
   * Un embedding qui ne revient jamais (Ollama figé : la requête n'a pas de délai) laisse sa recherche
   * en vol après le délai de la fermeture. Son magasin rendu, elle ne peut plus rien lire : les
   * fermetures suivantes ne l'attendent plus, sinon chaque bascule coûtait 5 s jusqu'au redémarrage.
   */
  it('une recherche perdue au-delà du délai ne retarde pas la fermeture du projet suivant', async () => {
    const lost = holdNextSlowQuery();
    const lostOutcome = settle(pdfService.search(slowQuery(), { sourceType: 'secondary' }));
    await lost.started;

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const closingA = closeProject();
      await vi.advanceTimersByTimeAsync(SEARCH_DRAIN_MS);
      await closingA;
      vi.useRealTimers();
      expect(drainTimeouts()).toBe(1);

      await pdfService.init(projectB);
      seed('Document de B');
      expect(titles(await pdfService.search(quickQuery(), { sourceType: 'secondary' }))).toEqual(['Document de B']);

      // B n'a aucune recherche en vol : sa fermeture n'attend rien.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const closingB = closeProject();
      await vi.advanceTimersByTimeAsync(SEARCH_DRAIN_MS);
      await closingB;
      vi.useRealTimers();
      expect(drainTimeouts()).toBe(1);
    } finally {
      // Revenue enfin (même si le test échoue : sinon elle resterait en vol pour les suivants).
      lost.release();
    }

    // La recherche perdue ne répond avec aucun projet.
    const { hits, error } = await lostOutcome;
    expect(hits).toBeNull();
    expect(error).toMatchObject({ code: 'project-changed' });
    expect(warnings()).not.toContain('database connection is not open');
  });

  it('une recherche lancée pendant la fermeture, ou après, échoue proprement', async () => {
    const slow = holdNextSlowQuery();
    const first = pdfService.search(slowQuery(), { sourceType: 'secondary' });
    await slow.started;

    const closing = closeProject();
    // Le chemin du chat, qui interroge la recherche sans passer par le service PDF.
    const during = retrievalService.search({ query: slowQuery(), sourceType: 'secondary' });
    const duringOutcome = during.then(
      () => null,
      (error: unknown) => error
    );
    slow.release();
    await first;
    await closing;

    expect(String(await duringOutcome)).toMatch(/not configured|project-changed/);
    await expect(pdfService.search(quickQuery(), { sourceType: 'secondary' })).rejects.toThrow(/not initialized/);
    await expect(retrievalService.search({ query: quickQuery(), sourceType: 'secondary' })).rejects.toThrow(
      /not configured/
    );
    expect(warnings()).not.toContain('database connection is not open');
  });

  it('une ouverture sans fermeture d’abord (reprise de `init`) attend aussi la recherche en vol', async () => {
    const slow = holdNextSlowQuery();
    const searching = pdfService.search(slowQuery(), { sourceType: 'secondary' });
    await slow.started;

    const opening = pdfService.init(projectB);
    await new Promise((resolve) => setImmediate(resolve));
    slow.release();

    expect(titles(await searching)).toEqual(['Document de A']);
    await opening;
    seed('Document de B');
    expect(titles(await pdfService.search(quickQuery(), { sourceType: 'secondary' }))).toEqual(['Document de B']);
    expect(warnings()).not.toContain('database connection is not open');
  });
});
