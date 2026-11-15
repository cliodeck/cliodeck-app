/**
 * L'empreinte des sources primaires dans le cache de similarité (S13-1-1, revue de L11-2).
 *
 * La transcription d'une carte et la réindexation des extraits périmés (H7) refont les extraits
 * d'une source par `reindexSource` / `indexSourceChunks`, sans toucher sa ligne : `indexed_at` ne
 * bouge pas, et le nombre d'extraits souvent non plus. Seul l'id du dernier extrait écrit le dit
 * (`getLastChunkId`). Le test du magasin prouve qu'il bouge, celui du cache simule tout
 * `tropyService.getIndexFreshness` : rien ne vérifiait qu'il arrive jusqu'à l'empreinte. Ici, le
 * même texte est réindexé (autant d'extraits, même date) : une analyse faite avant ne doit plus
 * être servie.
 *
 * Vrais `tropyService`, `PrimarySourcesVectorStore` dans un brain.db temporaire et
 * `similarityService`, vrai fichier de cache. Simulés : Electron, la configuration, le fournisseur
 * d'embeddings (un vecteur calculé localement, sans réseau), le projet courant et la recherche.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards';

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

const DIMENSION = 768;
function hashedVector(text: string): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % DIMENSION] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => null,
    getEmbedding: () => ({
      id: 'local-test',
      name: 'local-test',
      model: 'hashed-bag-of-words',
      dimension: DIMENSION,
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      embed: async (texts: string[]) => texts.map(hashedVector),
      dispose: async () => undefined,
    }),
    dispose: async () => undefined,
  }),
}));

const h = vi.hoisted(() => ({ projectPath: null as string | null }));
vi.mock('../project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
// La recherche est simulée ; l'état du corpus des PDF ne doit pas entrer dans une analyse des
// seules sources primaires.
vi.mock('../pdf-service.js', () => ({
  pdfService: {
    search: async () => [
      {
        sourceType: 'primary',
        similarity: 0.5,
        source: { id: 'src-1', title: 'Rapport du préfet' },
        chunk: { content: 'Le préfet signale au ministre la fin de la grève.' },
      },
    ],
    getIndexFreshness: () => {
      throw new Error('le corpus des PDF n’est pas celui de l’analyse');
    },
  },
}));

const { tropyService } = await import('../tropy-service.js');
const { similarityService } = await import('../similarity-service.js');
const { PrimarySourcesVectorStore } = await import('../../../../backend/core/vector-store/PrimarySourcesVectorStore.js');

/** Des mots tous distincts : le filtre de qualité écarte les extraits répétitifs. */
const SYLLABLES = ['ba', 'cor', 'di', 'fu', 'gal', 'le', 'mi', 'nor', 'pa', 'ru', 'sel', 'to', 'van', 'ze', 'qui', 'ran', 'tel', 'mor'];
function word(n: number): string {
  let s = '';
  for (let k = 0, x = n; k < 3; k++, x = Math.floor(x / SYLLABLES.length)) s += SYLLABLES[x % SYLLABLES.length];
  return s;
}
const transcription = (offset: number): string =>
  Array.from({ length: 30 }, (_, i) => `${Array.from({ length: 10 }, (_, k) => word(offset + 10 * i + k)).join(' ')}.`).join(' ');

const CHAPTER = [
  '# Chapitre 3 : La grève du port',
  '',
  'Le préfet signale au ministre que la grève du port est terminée au matin du 25 mars.',
  '',
  'Les dockers réunis à la Bourse du travail votent la reprise malgré le syndicat.',
].join('\n');

let project = '';
const chapterPath = () => path.join(project, 'chapters', '03.md');

const analyse = () =>
  similarityService.analyzeDocument(
    CHAPTER,
    { granularity: 'paragraph', sourceType: 'primary', useReranking: false, useContextualEmbedding: false },
    undefined,
    chapterPath()
  );

describe.skipIf(!sqliteAvailable)('cache de similarité — sources primaires réindexées sans changer de date', () => {
  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-primaires-'));
    fs.mkdirSync(path.join(project, '.cliodeck'));
    fs.mkdirSync(path.join(project, 'chapters'));
    fs.writeFileSync(chapterPath(), CHAPTER);
    h.projectPath = project;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Deux sources transcrites, écrites par la synchro (`saveSource`).
    const seed = new PrimarySourcesVectorStore(project);
    try {
      for (const [n, id] of ['src-1', 'src-2'].entries()) {
        seed.saveSource({
          id,
          tropyId: n + 1,
          title: `Pièce ${id}`,
          tags: [],
          photos: [],
          transcription: transcription(1000 * n),
          transcriptionSource: 'tesseract',
          lastModified: new Date('2026-05-06T13:13:22.394Z'),
          metadata: {},
        });
      }
    } finally {
      seed.close();
    }

    await tropyService.init(project);
    await tropyService.whenFullReindexSettled();
    expect((await tropyService.reindexSource('src-1')).success).toBe(true);
    expect((await tropyService.reindexSource('src-2')).success).toBe(true);
  });

  afterEach(async () => {
    await tropyService.close();
    vi.restoreAllMocks();
    h.projectPath = null;
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('la dernière source réindexée, autant d’extraits et même date : l’analyse d’avant n’est plus servie', async () => {
    await analyse();
    // Témoin : sans changement, la relecture rend l'analyse.
    expect(await similarityService.getAllCachedResults(CHAPTER, chapterPath())).not.toEqual([]);
    const before = tropyService.getIndexFreshness();
    expect(before?.chunkCount).toBeGreaterThan(0);

    // Ce que font la transcription d'une carte et la réindexation H7 : les extraits seuls.
    expect((await tropyService.reindexSource('src-2')).success).toBe(true);

    const after = tropyService.getIndexFreshness();
    expect(after).toMatchObject({
      sourceCount: before?.sourceCount,
      chunkCount: before?.chunkCount,
      lastIndexedAt: before?.lastIndexedAt,
    });
    expect(after).not.toEqual(before);
    expect(await similarityService.getAllCachedResults(CHAPTER, chapterPath())).toEqual([]);
  });
});
