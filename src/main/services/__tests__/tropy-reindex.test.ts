/**
 * Une source a tous ses extraits ou aucun (S08-1-30).
 *
 * `indexSourceChunks` avalait l'échec de chaque extrait et continuait : une
 * erreur passagère du fournisseur (délai, modèle déchargé) laissait une source
 * à 9 extraits sur 10, et la synchro, qui ne reprend que les sources sans
 * extrait, ne la complétait jamais. `reindexSource` supprimait les extraits,
 * n'en recréait aucun quand le fournisseur était en panne, et répondait
 * `success: true` : une transcription corrigée Ollama éteint était annoncée
 * enregistrée alors que la source sortait du RAG.
 *
 * Vrai `tropyService`, vrai `TropySync` sur un .tpy écrit par `makeTpy`, vrai
 * `PrimarySourcesVectorStore` dans un brain.db temporaire, vrai gestionnaire
 * `tropy:update-transcription`. Simulés : Electron, la configuration et le
 * fournisseur d'embeddings (un vecteur calculé localement, sans réseau), qui
 * tombe en panne sur commande.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards';
import { makeTpy } from '../../../../backend/integrations/tropy/__tests__/helpers/make-tpy';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
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

/**
 * `ok` : répond ; `fail-at-3` : seul le 3e texte demandé échoue, comme un délai
 * passager ; `down` : tout échoue, comme Ollama arrêté ; `absent` : le registre
 * ne se construit pas, aucun fournisseur.
 */
type ProviderMode = 'ok' | 'fail-at-3' | 'down' | 'absent';
const provider = vi.hoisted(() => ({ mode: 'ok' as ProviderMode, texts: 0 }));

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
  createRegistryFromClioDeckConfig: () => {
    if (provider.mode === 'absent') throw new Error('aucun fournisseur configuré');
    return {
      getLLM: () => null,
      getEmbedding: () => ({
        id: 'local-test',
        name: 'local-test',
        model: 'hashed-bag-of-words',
        dimension: DIMENSION,
        getStatus: () => ({ state: 'ready' }),
        healthCheck: async () => ({ state: 'ready' }),
        embed: async (texts: string[]) => {
          for (let i = 0; i < texts.length; i++) {
            provider.texts += 1;
            if (provider.mode === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
            if (provider.mode === 'fail-at-3' && provider.texts === 3) {
              throw new Error('The operation was aborted due to timeout');
            }
          }
          return texts.map(hashedVector);
        },
        dispose: async () => undefined,
      }),
      dispose: async () => undefined,
    };
  },
}));

const { tropyService } = await import('../tropy-service.js');
const { setupTropyHandlers } = await import('../../ipc/handlers/tropy-handlers.js');
setupTropyHandlers();

// MARK: - Données

/**
 * Une longue transcription faite dans Tropy (note de 500 caractères ou plus,
 * Q26) : 2 400 mots, soit dix extraits de 300 mots (pas de 250). Des mots tous
 * distincts, sinon le filtre de qualité écarte les extraits répétitifs.
 */
const OLD_OPENING = 'Registre des réunions publiques tenues à Nantes en mars 1907.';
const SYLLABLES = ['ba', 'cor', 'di', 'fu', 'gal', 'le', 'mi', 'nor', 'pa', 'ru', 'sel', 'to', 'van', 'ze', 'qui', 'ran', 'tel', 'mor'];
function word(n: number): string {
  let s = '';
  for (let k = 0, x = n; k < 3; k++, x = Math.floor(x / SYLLABLES.length)) s += SYLLABLES[x % SYLLABLES.length];
  return s;
}
const LONG_NOTE = [
  OLD_OPENING,
  ...Array.from({ length: 200 }, (_, i) =>
    `${Array.from({ length: 12 }, (_, k) => word(12 * i + k)).join(' ')}.`
  ),
].join(' ');

const NEW_TEXT =
  'Transcription revue : le préfet signale au ministre que la grève du port est terminée ' +
  'et que les ouvriers ont repris le travail le lundi 25 mars au matin.';

let root: string;
let projectDir: string;

function chunksOf(sourceId: string): string[] {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    return (
      db.prepare('SELECT content FROM tropy_chunks WHERE source_id = ? ORDER BY chunk_index').all(sourceId) as Array<{
        content: string;
      }>
    ).map((r) => r.content);
  } finally {
    db.close();
  }
}

function sourceRow(sourceId: string): { transcription: string | null; transcription_source: string | null; ocr_confidence: number | null } {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT transcription, transcription_source, ocr_confidence FROM tropy_sources WHERE id = ?')
      .get(sourceId) as { transcription: string | null; transcription_source: string | null; ocr_confidence: number | null };
  } finally {
    db.close();
  }
}

async function linkAndSync(): Promise<string> {
  const tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(tropyDir);
  const tpy = makeTpy(tropyDir, {
    projectId: 'projet-tropy-A',
    name: 'Grèves nantaises',
    items: [{ id: 10, title: 'Dossier des réunions publiques', notes: [{ text: LONG_NOTE }] }],
  });
  expect((await tropyService.openProject(tpy)).success).toBe(true);
  return tpy;
}

const syncOptions = { performOCR: false, ocrLanguage: 'fra' };

async function setProvider(mode: ProviderMode): Promise<void> {
  provider.mode = mode;
  provider.texts = 0;
  await tropyService.rebuildProviders({ embeddingChanged: true });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-reindex-'));
  projectDir = path.join(root, 'projet-cliodeck');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  provider.mode = 'ok';
  provider.texts = 0;
  await tropyService.init(projectDir);
});

afterEach(async () => {
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// MARK: - Synchro

describe.skipIf(!sqliteAvailable)('synchro : une source a tous ses extraits ou aucun', () => {
  it('témoin : sans panne, la source a une dizaine d’extraits', async () => {
    await linkAndSync();
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.issues).toEqual([]);
    const [source] = tropyService.getAllSources();
    expect(chunksOf(source.id)).toHaveLength(10);
  });

  it('le fournisseur échoue au 3e extrait sur 10 : aucun extrait écrit, la synchro le dit, la suivante reprend la source', async () => {
    await linkAndSync();
    await setProvider('fail-at-3');

    const first = await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();
    // La transcription, elle, est enregistrée : seule l'indexation manque.
    expect(source.transcription).toContain(OLD_OPENING);
    expect(chunksOf(source.id)).toEqual([]);
    expect(first.success).toBe(true);
    expect(first.issues).toEqual([{ code: 'embedding-failed', sources: 1 }]);

    // Le fournisseur se rétablit : la passe suivante reprend la source d'elle-même.
    await setProvider('ok');
    const second = await tropyService.sync(syncOptions);
    expect(second.issues).toEqual([]);
    expect(chunksOf(source.id)).toHaveLength(10);
  });

  it('aucun fournisseur : la synchro dit combien de sources restent sans extrait', async () => {
    await linkAndSync();
    await setProvider('absent');

    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.issues).toEqual([{ code: 'no-embedding-provider', sources: 1 }]);
    const [source] = tropyService.getAllSources();
    expect(chunksOf(source.id)).toEqual([]);
  });
});

// MARK: - Réindexation et écriture d'une transcription

describe.skipIf(!sqliteAvailable)('réindexation : jamais annoncée réussie sans extraits', () => {
  it('reindexSource, fournisseur en panne : échec et code renvoyés, les extraits d’un texte inchangé restent', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();
    const before = chunksOf(source.id);
    expect(before).toHaveLength(10);

    await setProvider('down');
    const reindexed = await tropyService.reindexSource(source.id);

    expect(reindexed).toMatchObject({ success: false, code: 'embedding-failed' });
    expect(chunksOf(source.id)).toEqual(before);
  });

  it('reindexSource sans fournisseur : code no-embedding-provider', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();

    await setProvider('absent');
    expect(await tropyService.reindexSource(source.id)).toMatchObject({
      success: false,
      code: 'no-embedding-provider',
    });
    expect(chunksOf(source.id)).toHaveLength(10);
  });

  it('OCR manuel enregistré Ollama arrêté : écrit avec sa provenance, aucun extrait de l’ancien texte, « pas indexé » dit, repris à la synchro', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();
    expect(chunksOf(source.id).length).toBeGreaterThan(0);

    await setProvider('down');
    const update = handlers.get('tropy:update-transcription');
    const response = await update?.({}, source.id, NEW_TEXT, 'tesseract', 77.5);

    expect(response).toMatchObject({ success: true, reindexCode: 'embedding-failed' });
    expect(sourceRow(source.id)).toEqual({
      transcription: NEW_TEXT,
      transcription_source: 'tesseract',
      ocr_confidence: 77.5,
    });
    // Rien de l'ancien texte ne reste servi au RAG.
    expect(chunksOf(source.id)).toEqual([]);

    await setProvider('ok');
    const resynced = await tropyService.sync(syncOptions);
    expect(resynced.issues).toEqual([]);
    // Le nouveau corps ouvre les extraits ; les notes Tropy suivent (L06-2).
    const chunks = chunksOf(source.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toContain('la grève du port est terminée');
  });

  it('fournisseur disponible : l’écriture réindexe, sans code d’échec', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();

    const update = handlers.get('tropy:update-transcription');
    const response = await update?.({}, source.id, NEW_TEXT, 'manual');

    expect(response).toEqual({ success: true });
    expect(sourceRow(source.id).transcription_source).toBe('manual');
    expect(chunksOf(source.id).join(' ')).toContain('la grève du port est terminée');
  });

  it('une source inconnue : rien d’écrit, échec avec le code source-not-found', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);

    const written = await tropyService.updateSourceTranscription('source-disparue', NEW_TEXT, 'imported');
    expect(written).toMatchObject({ success: false, code: 'source-not-found' });

    const update = handlers.get('tropy:update-transcription');
    expect(await update?.({}, 'source-disparue', NEW_TEXT, 'imported')).toMatchObject({
      success: false,
      code: 'source-not-found',
    });
  });
});
