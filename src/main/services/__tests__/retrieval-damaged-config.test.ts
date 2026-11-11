/**
 * Un `topK` et un seuil à `null` dans le fichier, mesurés sur une vraie recherche.
 *
 * `null` passe le `??` et le `||` : `selectWithOwnTextBands` lit `null <= 0` et rend zéro extrait, sans
 * erreur, et `similarity >= null` ne filtre plus rien. Vrai `retrievalService`, vrai `ConfigManager` sur
 * un vrai fichier ; seuls les corpus sont remplacés, par leurs points d'entrée (voir `corpusRetrievers`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const place = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron-store', async () => {
  const { default: Conf } = await import('conf');
  return {
    default: class extends Conf<Record<string, unknown>> {
      // Ce que fait electron-store : `name` s'appelle `configName` pour `conf`.
      constructor({ name, ...options }: Record<string, unknown>) {
        super({ ...options, configName: name as string, cwd: place.dir, projectVersion: '1.0.0' });
      }
    },
  };
});
vi.mock('electron', () => ({ app: { getPath: () => place.dir } }));
vi.mock('../secure-storage.js', () => ({
  SENSITIVE_KEYS: [],
  isSensitiveKey: () => false,
  secureStorage: { init: async () => undefined, getKey: () => '', setKey: () => undefined, deleteKey: () => undefined },
}));

const { retrievalService } = await import('../retrieval-service.js');
const { configManager } = await import('../config-manager.js');
const { DEFAULT_CONFIG } = await import('../../../../backend/types/config.js');

interface Internals {
  ensureReady(): void;
  searchSecondary(query: string, options: { topK: number; threshold: number }): Promise<unknown[]>;
  inspectAndFilter<T>(results: T[]): { results: T[]; securityEvents: unknown[] };
}
const internals = retrievalService as unknown as Internals;

const hit = (id: string, similarity: number) => ({
  chunk: { id, content: `contenu ${id}`, documentId: 'doc', chunkIndex: 0 },
  document: { id: 'doc', title: 'doc', author: null, bibtexKey: 'k' },
  similarity,
});

const file = () => join(place.dir, 'cliodeck-config.json');

let searchSecondary: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  place.dir = mkdtempSync(join(tmpdir(), 'cliodeck-recherche-nombres-'));
  await configManager.init();
});

afterAll(() => {
  rmSync(place.dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(internals, 'ensureReady').mockImplementation(() => undefined);
  vi.spyOn(internals, 'inspectAndFilter').mockImplementation((results) => ({ results, securityEvents: [] }));
  // Ce que fait le vrai corpus de ce seuil : `applyThreshold`, sans repli ici.
  searchSecondary = vi.fn(async (_query: string, options: { topK: number; threshold: number }) =>
    [hit('fort', 0.9), hit('faible', 0.01)].filter((h) => h.similarity >= options.threshold).slice(0, options.topK)
  );
  internals.searchSecondary = searchSecondary as unknown as Internals['searchSecondary'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('une recherche sur un fichier abîmé', () => {
  it('topK à null : l’extrait pertinent revient, pas zéro source en silence', async () => {
    writeFileSync(file(), JSON.stringify({ language: 'fr', recentProjects: [], rag: { topK: null, similarityThreshold: 0.12 } }));

    const { hits } = await retrievalService.search({ query: 'douane', sourceType: 'secondary' });

    expect(hits.map((h) => h.chunk.id)).toEqual(['fort']);
    expect(searchSecondary.mock.calls[0][1]).toMatchObject({ topK: DEFAULT_CONFIG.rag.topK });
  });

  it('seuil à null : le corpus reçoit le seuil par défaut, et l’extrait hors sujet reste dehors', async () => {
    writeFileSync(file(), JSON.stringify({ language: 'fr', recentProjects: [], rag: { topK: 5, similarityThreshold: null } }));

    const { hits } = await retrievalService.search({ query: 'douane', sourceType: 'secondary' });

    expect(searchSecondary.mock.calls[0][1]).toMatchObject({ threshold: DEFAULT_CONFIG.rag.similarityThreshold });
    expect(hits.map((h) => h.chunk.id)).toEqual(['fort']);
  });

  it('le fichier est réparé en passant', async () => {
    writeFileSync(file(), JSON.stringify({ language: 'fr', recentProjects: [], rag: { topK: null, similarityThreshold: null } }));

    await retrievalService.search({ query: 'douane', sourceType: 'secondary' });

    const { rag } = JSON.parse(readFileSync(file(), 'utf8')) as { rag: Record<string, unknown> };
    expect(rag).toEqual({ topK: DEFAULT_CONFIG.rag.topK, similarityThreshold: DEFAULT_CONFIG.rag.similarityThreshold });
  });

  it('un topK retiré par `stripNonFinite` : même chose, le fichier reste tel quel', async () => {
    const written = JSON.stringify({ language: 'fr', recentProjects: [], rag: { chunkingConfig: 'large' } });
    writeFileSync(file(), written);

    const { hits } = await retrievalService.search({ query: 'douane', sourceType: 'secondary' });

    expect(hits.map((h) => h.chunk.id)).toEqual(['fort']);
    expect(JSON.parse(readFileSync(file(), 'utf8')).rag).toEqual({ chunkingConfig: 'large' });
  });
});
