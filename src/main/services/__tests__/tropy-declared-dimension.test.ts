/**
 * Un modèle d'embeddings Ollama hors de la table de l'adaptateur (L06-9, revue).
 *
 * La proposition de réindexation (Q29) et le filtre de la passe d'ouverture (J7) lisent la
 * dimension que le fournisseur déclare (`embedding.dimension`). Pour Ollama, l'adaptateur la tire
 * d'une table de trois modèles (`OLLAMA_EMBEDDING_DIMS`) et déclare 768 pour tout autre : bge-m3,
 * qui rend des vecteurs de 1024, est déclaré en 768 (S05-1-14, confié à L07-12, hors rc.6).
 *
 * La revue craignait des vecteurs de 1024 qui atteignent le magasin sous une dimension déclarée de
 * 768 : proposition absente ou fausse, passe d'ouverture qui écarte tout. Ce test passe par le vrai
 * adaptateur, le vrai registre et le vrai `OllamaEmbeddingProvider` ; seul le serveur Ollama est
 * simulé (`fetch`), qui rend la vraie dimension de chaque modèle. Le fournisseur refuse tout
 * vecteur d'une autre taille que celle qu'il déclare (`ollama.ts`, « Embedding dimension
 * mismatch ») : aucun vecteur d'une dimension non déclarée n'atteint le magasin, et la dimension
 * déclarée est celle de tout vecteur écrit. OpenAI et Mistral font le même contrôle ; Gemini et le
 * modèle embarqué n'ont qu'un modèle, de dimension connue.
 *
 * Cas voisin, laissé à L07-12 : des archives indexées par mxbai-embed-large (1024, de la table),
 * puis bge-m3. La proposition dit alors « le modèle actuel en produit 768 », et sa passe, confirmée,
 * s'arrête au premier extrait (« le modèle n'a pas répondu ») sans rien écrire en base ; l'index en
 * mémoire, passé à 768, se refait au retour de mxbai-embed-large. Faux texte, rien de perdu.
 *
 * Quand L07-12 fera adopter au fournisseur la dimension de sa première réponse, ce test changera :
 * la proposition et la passe d'ouverture devront alors lire cette dimension réelle, et ne rien
 * conclure d'une dimension supposée avant la première réponse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards';
import { makeTpy } from '../../../../backend/integrations/tropy/__tests__/helpers/make-tpy';

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {},
}));

const { tropyService } = await import('../tropy-service.js');
const { configManager } = await import('../config-manager.js');
const { EmbeddingSpaceMismatchError } = await import('../../../../backend/core/vector-store/embedding-space.js');

/** La dimension que chaque modèle rend vraiment. */
const REAL_DIMENSION: Record<string, number> = { 'nomic-embed-text': 768, 'bge-m3': 1024 };

function hashedVector(text: string, dimension: number): number[] {
  const v = new Array<number>(dimension).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % dimension] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Le serveur Ollama simulé : `/api/embed` rend la vraie dimension du modèle demandé. */
const ollama = { embedded: 0 };
function fakeOllamaFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/api/embed')) {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    const dimension = REAL_DIMENSION[body.model.split(':')[0]];
    ollama.embedded += body.input.length;
    return Promise.resolve(
      new Response(JSON.stringify({ embeddings: body.input.map((text) => hashedVector(text, dimension)) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

const ARCHIVE_NOTE =
  'Rapport du commissaire central au préfet sur la réunion tenue salle Colbert le 18 mars 1907. ' +
  'Près de huit cents dockers et charretiers y ont voté la grève générale du port de Nantes, ' +
  'malgré les réserves du syndicat, et désigné un comité chargé de porter leurs revendications.';
const SECOND_NOTE =
  'Lettre du syndicat des dockers au maire de Nantes, datée du 20 mars 1907, demandant que la salle ' +
  'Colbert reste ouverte aux réunions ouvrières pendant toute la durée du conflit avec les négociants.';

const FIRST = { id: 10, title: 'Rapport du commissaire central', notes: [{ text: ARCHIVE_NOTE }] };
const SECOND = { id: 20, title: 'Lettre du syndicat des dockers', notes: [{ text: SECOND_NOTE }] };

let root = '';
let projectDir = '';
let embeddingModel = 'nomic-embed-text';

function writeTpy(items: Array<typeof FIRST>): string {
  return makeTpy(path.join(root, 'tropy'), { projectId: 'projet-tropy-l069', name: 'Grèves nantaises', items });
}

/** Les dimensions des vecteurs des archives en base, et le nombre d'extraits embarqués. */
function chunksInBase(): { dimensions: number[]; embedded: number } {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    const dimensions = (
      db
        .prepare('SELECT DISTINCT length(embedding) / 4 AS d FROM tropy_chunks WHERE embedding IS NOT NULL ORDER BY d')
        .all() as Array<{ d: number }>
    ).map((r) => r.d);
    const embedded = (
      db.prepare('SELECT COUNT(*) AS n FROM tropy_chunks WHERE embedding IS NOT NULL').get() as { n: number }
    ).n;
    return { dimensions, embedded };
  } finally {
    db.close();
  }
}

/** Change de modèle d'embeddings comme les Paramètres : Tropy refait son fournisseur. */
async function useModel(model: string): Promise<void> {
  embeddingModel = model;
  await tropyService.rebuildProviders({ embeddingChanged: true });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-dimension-declaree-'));
  projectDir = path.join(root, 'projet-cliodeck');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  embeddingModel = 'nomic-embed-text';
  ollama.embedded = 0;
  vi.stubGlobal('fetch', vi.fn(fakeOllamaFetch));
  vi.spyOn(configManager, 'getLLMConfig').mockImplementation(
    () =>
      ({
        backend: 'ollama',
        ollamaURL: 'http://127.0.0.1:11434',
        ollamaChatModel: 'test',
        ollamaEmbeddingModel: embeddingModel,
      }) as ReturnType<typeof configManager.getLLMConfig>
  );
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
    topK: 5,
    similarityThreshold: 0,
  } as ReturnType<typeof configManager.getRAGConfig>);
  await tropyService.init(projectDir);
});

afterEach(async () => {
  await tropyService.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('modèle Ollama hors table (bge-m3 : 1024 réels, 768 déclarés) : aucun vecteur d’une dimension non déclarée n’atteint le magasin', () => {
  it('témoin : nomic-embed-text, de la table, indexe les archives en 768', async () => {
    expect((await tropyService.openProject(writeTpy([FIRST]))).success).toBe(true);
    expect((await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' })).issues).toEqual([]);
    expect(chunksInBase()).toMatchObject({ dimensions: [768] });
    expect(ollama.embedded).toBeGreaterThan(0);
    expect((await tropyService.search('grève générale du port de Nantes')).length).toBeGreaterThan(0);
  });

  it('archives en 768, puis bge-m3 : le fournisseur refuse ses vecteurs ; la recherche lève, la synchro dit l’échec du modèle, rien n’est écrit ni proposé', async () => {
    expect((await tropyService.openProject(writeTpy([FIRST]))).success).toBe(true);
    expect((await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' })).issues).toEqual([]);
    const before = chunksInBase();

    await useModel('bge-m3');

    const error = await tropyService.search('grève générale du port de Nantes').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EmbeddingSpaceMismatchError);
    expect((error as Error).message).toContain('Embedding dimension mismatch: got 1024, declared 768');

    // Une pièce ajoutée dans Tropy : refusée par le fournisseur, pas par le magasin.
    writeTpy([FIRST, SECOND]);
    const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
    expect(result.issues).toEqual([{ code: 'embedding-failed', sources: 1 }]);
    expect(chunksInBase()).toEqual(before);

    // Rien à proposer : aucune réindexation ne pourrait aboutir avec ce fournisseur.
    expect(tropyService.getReembedProposal()).toBeNull();
    expect(tropyService.requestReembed()).toEqual({ started: false, reason: 'nothing-to-reembed' });
  });

  it('bge-m3 dès le départ : rien ne s’indexe, et une base en 1024 sous une dimension déclarée de 768 ne peut pas se former', async () => {
    await useModel('bge-m3');
    expect((await tropyService.openProject(writeTpy([FIRST, SECOND]))).success).toBe(true);
    const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });

    expect(result.issues).toEqual([{ code: 'embedding-failed', sources: 2 }]);
    expect(ollama.embedded).toBeGreaterThan(0);
    expect(chunksInBase()).toEqual({ dimensions: [], embedded: 0 });
    expect(tropyService.getReembedProposal()).toBeNull();
  });
});
