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
import { TropyOCRPipeline } from '../../../../backend/integrations/tropy/TropyOCRPipeline';

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
 * ne se construit pas, aucun fournisseur ; `gate` : le 1er texte attend qu'on
 * ouvre `gate`, comme un Ollama lent, le temps d'écrire la source pendant
 * l'embarquement (`gateFirstEmbed`).
 */
type ProviderMode = 'ok' | 'fail-at-3' | 'down' | 'absent' | 'gate';
const provider = vi.hoisted(() => ({
  mode: 'ok' as ProviderMode,
  texts: 0,
  gate: null as Promise<void> | null,
  reached: null as (() => void) | null,
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
            if (provider.mode === 'gate' && provider.texts === 1 && provider.gate) {
              provider.reached?.();
              await provider.gate;
            }
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

const IMPORTED_TEXT =
  'Transcription importée : le commissaire central rapporte que les dockers réunis à la Bourse ' +
  'du travail ont voté la reprise pour le mardi 26 mars, malgré l’opposition du syndicat.';

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

/**
 * Arrête le 1er texte embarqué jusqu'à `open()` ; `reached` se résout quand
 * l'embarquement y est : la source peut alors être réécrite en plein milieu.
 */
async function gateFirstEmbed(): Promise<{ reached: Promise<void>; open: () => void }> {
  let open!: () => void;
  provider.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    provider.reached = resolve;
  });
  await setProvider('gate');
  return { reached, open };
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
  provider.gate = null;
  provider.reached = null;
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

  // Le même fichier réimporté, un OCR relancé qui rend le même texte : les
  // extraits découpent toujours ce texte. Les retirer à chaque écriture faisait
  // sortir la source du RAG dès que le fournisseur était en panne, jusqu'à la
  // synchro suivante, pour un texte qui n'avait pas changé.
  it('la même transcription réécrite, fournisseur en panne : les extraits restent, et la source reste indexée', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const update = handlers.get('tropy:update-transcription');
    const [source] = tropyService.getAllSources();
    expect(await update?.({}, source.id, NEW_TEXT, 'imported')).toEqual({ success: true });
    const before = chunksOf(source.id);
    expect(before.length).toBeGreaterThan(0);

    await setProvider('down');
    // Réimport du même fichier : la provenance peut changer, pas le texte.
    const response = await update?.({}, source.id, NEW_TEXT, 'transkribus');

    expect(response).toEqual({ success: true });
    expect(sourceRow(source.id)).toEqual({
      transcription: NEW_TEXT,
      transcription_source: 'transkribus',
      ocr_confidence: null,
    });
    expect(chunksOf(source.id)).toEqual(before);
  });

  it('la même transcription réécrite sur une source restée sans extrait : elle est réindexée', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();
    const update = handlers.get('tropy:update-transcription');
    // Écrite Ollama arrêté : la source reste à 0 extrait.
    await setProvider('down');
    expect(await update?.({}, source.id, NEW_TEXT, 'imported')).toMatchObject({
      success: true,
      reindexCode: 'embedding-failed',
    });
    expect(chunksOf(source.id)).toEqual([]);

    // Le même texte, réécrit une fois le fournisseur revenu : il n'a pas
    // changé, mais la source n'a rien d'indexé, elle est donc réembarquée.
    await setProvider('ok');
    expect(await update?.({}, source.id, NEW_TEXT, 'imported')).toEqual({ success: true });
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

// MARK: - Écriture pendant un embarquement

/**
 * Une passe embarque le texte d'une source tel qu'il était à son départ, à
 * travers des dizaines d'`await`. Une écriture de transcription (OCR manuel,
 * import) qui tombe pendant ce temps réindexe la source avec le nouveau texte ;
 * la passe, en finissant, écrasait ces extraits avec ceux de l'ancien. La
 * source gardait des extraits, donc le filtre « sans extrait » ne la reprenait
 * jamais : l'assistant citait pour toujours un texte qui n'existait plus.
 */
describe.skipIf(!sqliteAvailable)('écriture pendant un embarquement : les extraits suivent le dernier texte', () => {
  it('OCR manuel pendant la synchro : la synchro ne remet pas les extraits de l’ancien texte', async () => {
    await linkAndSync();
    // Ollama arrêté à la première passe : la source reste à 0 extrait.
    await setProvider('down');
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();
    expect(chunksOf(source.id)).toEqual([]);

    // Ollama relancé, lent : la synchro s'arrête sur le 1er extrait de la source.
    const gate = await gateFirstEmbed();
    const pending = tropyService.sync(syncOptions);
    let afterWrite: string[] = [];
    try {
      await gate.reached;
      // Pendant ce temps, l'historien lance l'OCR manuel sur la carte.
      const update = handlers.get('tropy:update-transcription');
      expect(await update?.({}, source.id, NEW_TEXT, 'tesseract', 80)).toEqual({ success: true });
      afterWrite = chunksOf(source.id);
      expect(afterWrite[0]).toContain('la grève du port est terminée');
    } finally {
      gate.open();
    }
    const result = await pending;

    // Les extraits restent ceux du nouveau texte, et la passe abandonnée
    // n'est pas une panne du modèle.
    expect(chunksOf(source.id)).toEqual(afterWrite);
    expect(result.issues).toEqual([]);
  });

  it('deux écritures de suite : la réindexation de la première n’écrit pas son texte par-dessus la seconde', async () => {
    await linkAndSync();
    await tropyService.sync(syncOptions);
    const [source] = tropyService.getAllSources();

    const gate = await gateFirstEmbed();
    const update = handlers.get('tropy:update-transcription');
    // OCR manuel : la ligne est écrite, sa réindexation s'arrête au 1er extrait.
    const first = update?.({}, source.id, NEW_TEXT, 'tesseract', 80);
    try {
      await gate.reached;
      // Pendant ce temps, un import réécrit la même source et la réindexe.
      expect(await update?.({}, source.id, IMPORTED_TEXT, 'imported')).toEqual({ success: true });
    } finally {
      gate.open();
    }
    // L'écriture a bien eu lieu ; son indexation revient à l'écrivain suivant.
    expect(await first).toEqual({ success: true });

    expect(sourceRow(source.id)).toMatchObject({ transcription: IMPORTED_TEXT, transcription_source: 'imported' });
    const chunks = chunksOf(source.id);
    expect(chunks[0]).toContain('les dockers réunis à la Bourse');
    expect(chunks.join(' ')).not.toContain('la grève du port est terminée');
  });
});

// MARK: - Écriture pendant la reconnaissance d'un item

/**
 * Même course, une phase plus tôt. `processItem` lit la source, attend l'OCR
 * de l'item (des secondes réelles), puis réécrit la ligne d'après sa lecture.
 * Un import ou un OCR manuel qui tombe pendant cette attente était écrasé : la
 * transcription importée disparaissait sans rien dire. Sous « Relancer l'OCR »,
 * l'OCR rendait le même texte qu'avant, si bien que la ligne revenait à
 * l'ancien texte en gardant les extraits de l'import, et le filtre « sans
 * extrait » ne la reprenait jamais.
 */
describe.skipIf(!sqliteAvailable)('écriture pendant la reconnaissance : l’OCR ne réécrit pas une source récrite entre-temps', () => {
  const OCR_TEXT =
    'Rapport du commissaire central au préfet sur la réunion tenue salle Colbert le 18 mars 1907, ' +
    'où près de huit cents dockers et charretiers ont voté la grève générale du port de Nantes.';

  async function linkWithPhoto(): Promise<void> {
    const tropyDir = path.join(root, 'tropy');
    fs.mkdirSync(tropyDir);
    // `performOCROnItem` écarte les photos absentes du disque.
    const photo = path.join(tropyDir, 'rapport.jpg');
    fs.writeFileSync(photo, 'jpeg factice');
    const tpy = makeTpy(tropyDir, {
      projectId: 'projet-tropy-A',
      name: 'Grèves nantaises',
      items: [{ id: 10, title: 'Rapport du commissaire', photos: [{ id: 11, path: photo }] }],
    });
    expect((await tropyService.openProject(tpy)).success).toBe(true);
  }

  /** La reconnaissance n° `held` attend `open()` ; `reached` se résout quand elle y est. */
  function holdOCR(held: number): { reached: Promise<void>; open: () => void } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    let calls = 0;
    vi.spyOn(TropyOCRPipeline.prototype, 'performBatchOCR').mockImplementation(async () => {
      calls += 1;
      if (calls === held) {
        reach();
        await gate;
      }
      // Tesseract, mêmes images, même langue : le même texte à chaque passe.
      return { text: OCR_TEXT, confidence: 82, language: 'fra', pageCount: 1 };
    });
    return { reached, open };
  }

  it.each([
    {
      cas: '« Relancer l’OCR » sur une source déjà reconnue',
      held: 2,
      before: { performOCR: true, ocrLanguage: 'fra' },
      during: { performOCR: true, forceReindex: true, ocrLanguage: 'fra' },
    },
    {
      cas: 'premier OCR d’une source sans transcription',
      held: 1,
      before: { performOCR: false, ocrLanguage: 'fra' },
      during: { performOCR: true, ocrLanguage: 'fra' },
    },
  ])('$cas : l’import fait pendant la reconnaissance reste, avec ses extraits', async ({ held, before, during }) => {
    await linkWithPhoto();
    const ocr = holdOCR(held);
    await tropyService.sync(before);
    const [source] = tropyService.getAllSources();

    const pending = tropyService.sync(during);
    try {
      await ocr.reached;
      // Pendant la reconnaissance de l'item, l'historien importe un fichier
      // Transkribus pour cette source.
      const update = handlers.get('tropy:update-transcription');
      expect(await update?.({}, source.id, IMPORTED_TEXT, 'transkribus')).toEqual({ success: true });
    } finally {
      ocr.open();
    }
    const result = await pending;

    // L'écriture la plus récente l'emporte : la passe n'a rien réécrit.
    expect(sourceRow(source.id)).toEqual({
      transcription: IMPORTED_TEXT,
      transcription_source: 'transkribus',
      ocr_confidence: null,
    });
    // Et les extraits découpent ce texte, pas celui de l'OCR.
    const chunks = chunksOf(source.id).join(' ');
    expect(chunks).toContain('les dockers réunis à la Bourse');
    expect(chunks).not.toContain('salle Colbert');
    // Une reconnaissance jetée n'est ni une panne, ni un OCR « effectué ».
    expect(result.issues).toEqual([]);
    expect(result.ocrPerformed).toBe(0);
  });
});
