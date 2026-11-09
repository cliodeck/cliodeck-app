/**
 * Synchronisation Tropy de bout en bout, sur de vrais .tpy.
 *
 * Le 2026-08-30, cinq défauts de ce chemin faisaient perdre en silence tout
 * l'OCR d'un corpus (~24 h de calcul, 221 documents). Les tests de
 * `TropySyncPersistence.test.ts` tiennent `processItem` isolé, lecteur et
 * magasin simulés ; ici, rien n'est simulé de ce qui décide du sort d'une
 * transcription : vrai `TropyReader` sur un .tpy écrit par `makeTpy`, vrai
 * `TropySync`, vrai `PrimarySourcesVectorStore` dans un brain.db temporaire,
 * vrai `tropyService` pour la phase d'embeddings (découpage, filtre qualité,
 * dédoublonnage). Seuls sont remplacés : Electron, la configuration, le
 * fournisseur d'embeddings (un vecteur calculé localement, sans réseau) et
 * la reconnaissance elle-même (`performBatchOCR`), qui rendrait sinon des
 * heures de calcul et un modèle de langue téléchargé.
 *
 * Tests de caractérisation : verts sur le code du 2026-11-07, ils servent de
 * référence aux correctifs de L06-2 à L06-17.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';
import {
  makeTpy,
  openTpyForWrite,
  tpyDatabasePath,
  type TpyItemSpec,
  type TpySpec,
} from './helpers/make-tpy';
import { TropyReader } from '../TropyReader';
import { OcrEngineUnavailableError, TropyOCRPipeline } from '../TropyOCRPipeline';
import { PDFConverter, PopplerNotFoundError } from '../PDFConverter';

// Un userData par test, sous la racine temporaire : le dossier des modèles de
// Tesseract y est créé quand le vrai pipeline tourne.
const electronPaths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => electronPaths.userData },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Le moteur, pour les rares tests qui laissent tourner le vrai pipeline :
// aucun modèle téléchargé, aucun réseau. Comme tesseract.js 7, `terminate` ne
// règle pas une reconnaissance en cours. `recognize` reçoit la langue du
// moteur qui reconnaît, celle de sa création.
const tess = vi.hoisted(() => ({
  recognize: (_file: string, _language: string): Promise<{ data: { text: string; confidence: number } }> =>
    new Promise(() => undefined),
  terminated: 0,
}));
vi.mock('tesseract.js', () => ({
  createWorker: async (language: string) => ({
    recognize: (file: string) => tess.recognize(file, language),
    terminate: async () => {
      tess.terminated++;
    },
    reinitialize: async () => undefined,
  }),
}));

vi.mock('../../../../src/main/services/config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

// Fournisseur d'embeddings local et déterministe : un sac de mots haché sur
// 768 dimensions. Assez pour que HNSW et la recherche aient de vrais vecteurs,
// sans Ollama ni réseau.
const DIMENSION = 768;
const embedCalls = vi.hoisted(() => ({ texts: 0 }));
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
vi.mock('../../../core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => null,
    getEmbedding: () => ({
      id: 'local-test',
      name: 'local-test',
      model: 'hashed-bag-of-words',
      dimension: DIMENSION,
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      embed: async (texts: string[]) => {
        embedCalls.texts += texts.length;
        return texts.map(hashedVector);
      },
      dispose: async () => undefined,
    }),
    dispose: async () => undefined,
  }),
}));

const { tropyService } = await import('../../../../src/main/services/tropy-service.js');

// MARK: - Données

const OCR_TEXT = [
  'Le préfet de la Loire-Inférieure au ministre de l’Intérieur, Nantes, le 14 mars 1907.',
  'Les ouvriers du port réclament une hausse de salaire de cinquante centimes par journée.',
  'Monsieur Durand, docker demeurant rue des Remparts, est désigné comme meneur de la grève.',
  'La gendarmerie a dispersé un rassemblement devant la Bourse du travail sans blessé grave.',
  'Je vous prie de bien vouloir me faire connaître les instructions du gouvernement à ce sujet.',
].join(' ');

// Au moins 500 caractères : une vraie transcription au sens de la décision Q26
// (en dessous, une note est un commentaire et l'OCR passe). Le jeu de base ne
// doit pas dépendre de ce seuil, que L06-2 introduit.
const NOTE_TEXT =
  'Transcription faite à la main dans Tropy : lettre du commissaire central au maire de Nantes, ' +
  'relative aux réunions publiques tenues salle Colbert pendant la semaine du 18 mars, ' +
  'avec la liste des orateurs inscrits et le nombre approximatif des auditeurs présents. ' +
  'Le commissaire signale que la réunion du mardi a rassemblé près de huit cents personnes, ' +
  'dont une majorité de dockers et de charretiers, et que les orateurs ont appelé à la grève générale ' +
  'du port si la compagnie refusait la hausse demandée. Il ajoute que deux agents en civil ont pris ' +
  'des notes pendant toute la séance et que leur rapport sera transmis au préfet dès le lendemain matin.';

let root: string;
let projectDir: string;
let tropyDir: string;
let photoPath: string;
let ocrSpy: ReturnType<typeof vi.spyOn>;

function baseItems(): TpyItemSpec[] {
  return [
    {
      id: 10,
      title: 'Rapport du préfet sur la grève du port',
      date: '1907-03-14',
      creator: 'Préfet de la Loire-Inférieure',
      tags: ['grève', 'port'],
      photos: [{ id: 11, path: photoPath }],
    },
    {
      id: 20,
      title: 'Lettre du commissaire central',
      notes: [{ text: NOTE_TEXT }],
      photos: [{ id: 21, path: photoPath.replace('rapport', 'lettre') }],
    },
  ];
}

function spec(overrides: Partial<TpySpec> = {}): TpySpec {
  return { projectId: 'projet-tropy-A', name: 'Grèves nantaises', items: baseItems(), ...overrides };
}

const syncOptions = { performOCR: true, ocrLanguage: 'fra', forceReindex: false };

/**
 * La conversion par Poppler remplacée : `count` pages PNG factices, dans un
 * dossier sous la racine du test. Le nettoyage du pipeline reste le vrai.
 */
function convertPdfTo(count: number) {
  return vi.spyOn(PDFConverter.prototype, 'convertToTempFiles').mockImplementation(async () => {
    const tempDir = fs.mkdtempSync(path.join(root, 'pages-'));
    const files = Array.from({ length: count }, (_, i) => {
      const file = path.join(tempDir, `page-${i + 1}.png`);
      fs.writeFileSync(file, 'png factice');
      return file;
    });
    return { tempDir, files, pageCount: count };
  });
}

/** La reconnaissance a-t-elle reçu cette photo, seule ou avec d'autres ? */
function ocrReached(photo: string): boolean {
  return ocrSpy.mock.calls.some((call: unknown[]) => (call[0] as string[]).includes(photo));
}

function brainDb(): Database.Database {
  return new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
}

function snapshot() {
  const db = brainDb();
  try {
    const sources = db
      .prepare(
        `SELECT id, tropy_id, transcription, transcription_source, ocr_confidence, indexed_at
         FROM tropy_sources ORDER BY tropy_id`
      )
      .all() as Array<{
      id: string;
      tropy_id: number;
      transcription: string | null;
      transcription_source: string | null;
      ocr_confidence: number | null;
      indexed_at: string;
    }>;
    const chunks = db
      .prepare('SELECT id, source_id, content FROM tropy_chunks ORDER BY source_id, chunk_index')
      .all() as Array<{ id: string; source_id: string; content: string }>;
    const projects = db.prepare('SELECT COUNT(*) AS n FROM tropy_projects').get() as { n: number };
    return { sources, chunks, projectRows: projects.n };
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-e2e-'));
  projectDir = path.join(root, 'projet-cliodeck');
  tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(tropyDir, { recursive: true });
  electronPaths.userData = path.join(root, 'userData');
  tess.terminated = 0;
  // Le moteur qui ne répond pas, sauf pour le test qui le dit : un test ne
  // reconnaît pas avec la doublure du précédent.
  tess.recognize = () => new Promise(() => undefined);
  // `performOCROnItem` écarte les photos absentes du disque : il faut de vrais fichiers.
  photoPath = path.join(tropyDir, 'rapport.jpg');
  fs.writeFileSync(photoPath, 'jpeg factice');
  fs.writeFileSync(photoPath.replace('rapport', 'lettre'), 'jpeg factice');

  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  embedCalls.texts = 0;
  ocrSpy = vi
    .spyOn(TropyOCRPipeline.prototype, 'performBatchOCR')
    .mockResolvedValue({ text: OCR_TEXT, confidence: 88.5, language: 'fra', pageCount: 1 });

  await tropyService.init(projectDir);
});

afterEach(async () => {
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// MARK: - Le .tpy fabriqué

describe.skipIf(!sqliteAvailable)('makeTpy : un .tpy que TropyReader lit comme un vrai', () => {
  it('rend titre, métadonnées, tags, notes, photos et sélections', () => {
    const tpy = makeTpy(tropyDir, {
      projectId: 'p',
      name: 'Lecture',
      items: [
        {
          title: 'Procès-verbal',
          date: '1907',
          metadata: { 'https://tropy.org/v1/tropy#box': 'Carton 12' },
          tags: ['grève'],
          notes: [{ text: 'note visible' }, { text: 'note supprimée', deleted: true }],
          photos: [
            {
              path: photoPath,
              notes: [{ text: 'note de photo' }],
              selections: [{ x: 5, y: 6, notes: [{ text: 'note de sélection' }] }],
            },
          ],
        },
      ],
    });

    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      expect(reader.getProjectName()).toBe('Lecture');
      const [item] = reader.listItems();
      expect(item.id).toBe(1);
      expect(item.title).toBe('Procès-verbal');
      expect(item.date).toBe('1907');
      expect((item as unknown as Record<string, unknown>).box).toBe('Carton 12');
      expect(item.modified).toBe('2026-05-06T13:13:22.394Z');
      expect(item.tags).toEqual(['grève']);
      expect(item.notes.map((n) => n.text)).toEqual(['note visible']);
      expect(item.photos).toHaveLength(1);
      expect(item.photos[0].id).toBe(2);
      expect(item.photos[0].path).toBe(photoPath);
      expect(item.photos[0].notes.map((n) => n.text)).toEqual(['note de photo']);
      expect(item.photos[0].selections).toMatchObject([{ id: 3, x: 5, y: 6 }]);
      expect(item.photos[0].selections[0].notes.map((n) => n.text)).toEqual(['note de sélection']);
    } finally {
      reader.closeProject();
    }
  });

  it('lit un paquet .tropy en WAL, photo relative au dossier assets', () => {
    const tpy = makeTpy(tropyDir, {
      projectId: 'p',
      name: 'Paquet',
      packaged: true,
      wal: true,
      items: [{ title: 'Pièce', photos: [{ path: 'scan.jpg' }] }],
    });
    fs.writeFileSync(path.join(tpy, 'assets', 'scan.jpg'), 'jpeg factice');
    expect(tpy.endsWith('Paquet.tropy')).toBe(true);

    const probe = new Database(path.join(tpy, 'project.tpy'), { readonly: true });
    expect(probe.pragma('journal_mode', { simple: true })).toBe('wal');
    probe.close();

    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      const [item] = reader.listItems();
      expect(item.photos[0].path).toBe(path.join(tpy, 'assets', 'scan.jpg'));
    } finally {
      reader.closeProject();
    }
  });

  it('écrit une transcription native sans texte, comme le permet Tropy 1.17.3', () => {
    const tpy = makeTpy(tropyDir, {
      projectId: 'p',
      name: 'Transcriptions',
      items: [
        {
          id: 1,
          title: 'Pièce',
          photos: [{ id: 2, path: photoPath, transcriptions: [{ text: null, status: 0 }, { text: 'lu', status: 1 }] }],
        },
      ],
    });

    const probe = new Database(tpyDatabasePath(tpy), { readonly: true });
    try {
      const rows = probe
        .prepare('SELECT id, text, status FROM transcriptions ORDER BY transcription_id')
        .all() as Array<{ id: number; text: string | null; status: number }>;
      expect(rows).toEqual([
        { id: 2, text: null, status: 0 },
        { id: 2, text: 'lu', status: 1 },
      ]);
    } finally {
      probe.close();
    }
  });
});

// MARK: - sync() de bout en bout

describe.skipIf(!sqliteAvailable)('TropySync de bout en bout (vrai .tpy, vrai brain.db)', () => {
  it('deux synchros de suite : OCR une fois, rien de réécrit, extraits stables, une seule ligne de projet', async () => {
    const tpy = makeTpy(tropyDir, spec());
    expect((await tropyService.openProject(tpy)).success).toBe(true);

    const first = await tropyService.sync(syncOptions);
    expect(first.success).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.newItems).toBe(2);
    expect(first.transcriptionsWritten).toBe(2);
    // L'item 20 a une transcription (note de 500 caractères ou plus) : pas d'OCR pour lui.
    // Seul l'item 10 passe à la reconnaissance.
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(ocrSpy.mock.calls[0][0]).toEqual([photoPath]);

    const after1 = snapshot();
    expect(after1.projectRows).toBe(1);
    const ocred = after1.sources.find((s) => s.tropy_id === 10);
    expect(ocred?.transcription).toBe(OCR_TEXT);
    expect(ocred?.transcription_source).toBe('tesseract');
    expect(ocred?.ocr_confidence).toBeCloseTo(88.5);
    expect(after1.sources.find((s) => s.tropy_id === 20)?.transcription_source).toBe('tropy-notes');
    // Chaque source a des extraits, et le texte de l'OCR y est.
    for (const s of after1.sources) {
      expect(after1.chunks.filter((c) => c.source_id === s.id).length).toBeGreaterThan(0);
    }
    expect(after1.chunks.some((c) => c.content.includes('Monsieur Durand'))).toBe(true);
    const embeddedAfter1 = embedCalls.texts;

    const second = await tropyService.sync(syncOptions);
    expect(second.success).toBe(true);
    expect(second.errors).toEqual([]);
    expect(second.newItems).toBe(0);
    expect(second.updatedItems).toBe(0);
    expect(second.skippedItems).toBe(2);
    expect(second.transcriptionsWritten).toBe(0);
    expect(second.ocrPerformed).toBe(0);

    const after2 = snapshot();
    // Pas de nouvelle reconnaissance, pas de réécriture des sources (indexed_at intact),
    // les mêmes extraits — mêmes identifiants, même texte — et aucun réembarquement.
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(after2.sources).toEqual(after1.sources);
    expect(after2.chunks).toEqual(after1.chunks);
    expect(embedCalls.texts).toBe(embeddedAfter1);
    expect(after2.projectRows).toBe(1);
  });

  it('un item modifié dans Tropy est réenregistré sans perdre son OCR ni ses extraits', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);
    const before = snapshot();

    // L'historien ajoute un tag dans Tropy : `subjects.modified` avance pour CET item.
    // Un tag n'entre pas dans le texte des extraits (le titre, si : voir plus bas).
    const items = baseItems();
    items[0] = { ...items[0], tags: ['grève', 'port', 'préfecture'], modified: '2026-06-01T08:00:00.000Z' };
    makeTpy(tropyDir, spec({ items }));

    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.updatedItems).toBe(1);
    expect(result.skippedItems).toBe(1);
    expect(ocrSpy).toHaveBeenCalledTimes(1);

    const after = snapshot();
    const s10 = after.sources.find((s) => s.tropy_id === 10);
    const s10Before = before.sources.find((s) => s.tropy_id === 10);
    expect(s10?.id).toBe(s10Before?.id);
    expect(s10?.transcription).toBe(OCR_TEXT);
    expect(s10?.transcription_source).toBe('tesseract');
    expect(s10?.ocr_confidence).toBeCloseTo(88.5);
    // Réenregistrer la source n'emporte pas ses extraits (piège d'INSERT OR REPLACE).
    expect(after.chunks.filter((c) => c.source_id === s10?.id)).toEqual(
      before.chunks.filter((c) => c.source_id === s10Before?.id)
    );
    expect(after.projectRows).toBe(1);
  });

  it('un OCR infructueux à la passe suivante ne fait pas perdre la transcription acquise', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);
    const before = snapshot();

    ocrSpy.mockResolvedValue({ text: '', confidence: 0, language: 'fra', pageCount: 1 });
    const result = await tropyService.sync({ ...syncOptions, forceReindex: true });
    expect(result.success).toBe(true);
    // Ciblé sur la photo de l'item 10 : sous forceReindex, Q26 (L06-2) fera
    // repasser l'item 20 à l'OCR (sa note n'est pas un corps), et ce test ne
    // doit pas en dépendre.
    expect(ocrSpy.mock.calls.filter((c: unknown[]) => (c[0] as string[])[0] === photoPath)).toHaveLength(2);

    const after = snapshot();
    expect(after.sources.find((s) => s.tropy_id === 10)?.transcription).toBe(OCR_TEXT);
    expect(after.chunks.length).toBe(before.chunks.length);
  });

  // L06-2 (S08-1-1) : une note ajoutée dans Tropy devenait la transcription
  // ('tropy-notes') et ses extraits remplaçaient ceux de l'OCR.
  it('une note ajoutée après l’OCR ne remplace pas la transcription (L06-2, S08-1-1)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    const items = baseItems();
    items[0] = { ...items[0], notes: [{ text: 'Voir aussi carton 12' }], modified: '2026-06-01T08:00:00.000Z' };
    makeTpy(tropyDir, spec({ items }));
    await tropyService.sync(syncOptions);

    const after = snapshot();
    const s10 = after.sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tesseract');
    expect(s10?.transcription).toBe(OCR_TEXT);
    const chunks = after.chunks.filter((c) => c.source_id === s10?.id).map((c) => c.content).join(' ');
    expect(chunks).toContain('Monsieur Durand');
    expect(chunks).toContain('carton 12');
  });

  // L06-2 (décision Q26) : toute note, même un commentaire de quelques mots,
  // tenait lieu de transcription et empêchait l'OCR. Sous 500 caractères, une
  // note est un commentaire : l'OCR doit passer.
  it('une note de moins de 500 caractères n’empêche pas l’OCR (L06-2, Q26)', async () => {
    const items = baseItems();
    items[0] = { ...items[0], notes: [{ text: 'Voir aussi carton 12' }] };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    expect(ocrSpy).toHaveBeenCalledWith([photoPath], expect.anything());
    const s10 = snapshot().sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tesseract');
    expect(s10?.transcription).toBe(OCR_TEXT);
  });

  it('un titre corrigé dans Tropy passe dans l’en-tête des extraits (L06-2)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    const items = baseItems();
    items[0] = { ...items[0], title: 'Rapport du préfet (corrigé)', modified: '2026-06-01T08:00:00.000Z' };
    makeTpy(tropyDir, spec({ items }));
    const result = await tropyService.sync(syncOptions);
    expect(result.updatedItems).toBe(1);
    expect(ocrSpy).toHaveBeenCalledTimes(1);

    const after = snapshot();
    const s10 = after.sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription).toBe(OCR_TEXT);
    const chunks = after.chunks.filter((c) => c.source_id === s10?.id).map((c) => c.content).join(' ');
    expect(chunks).toContain('Titre: Rapport du préfet (corrigé)');
    expect(chunks).toContain('Monsieur Durand');
  });

  it('une base d’avant la colonne notes_text s’initialise sans réembarquer (L06-2, A20)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);
    await tropyService.close();

    // Ramener brain.db au schéma d'avant L06-2 : sans la colonne, comme sur
    // les postes des historiens avant la mise à jour.
    const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'));
    db.exec('ALTER TABLE tropy_sources DROP COLUMN notes_text');
    db.close();
    const before = snapshot();
    const embeddedBefore = embedCalls.texts;

    await tropyService.init(projectDir);
    await tropyService.openProject(tpy);
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.updatedItems).toBe(0);

    const after = snapshot();
    expect(embedCalls.texts).toBe(embeddedBefore);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.sources.map((s) => [s.id, s.transcription, s.transcription_source])).toEqual(
      before.sources.map((s) => [s.id, s.transcription, s.transcription_source])
    );
    const probe = brainDb();
    try {
      const notes = probe
        .prepare('SELECT tropy_id, notes_text FROM tropy_sources ORDER BY tropy_id')
        .all() as Array<{ tropy_id: number; notes_text: string | null }>;
      expect(notes).toEqual([
        { tropy_id: 10, notes_text: '' },
        { tropy_id: 20, notes_text: NOTE_TEXT },
      ]);
    } finally {
      probe.close();
    }
  });

  // Décision G1 : le seuil des 500 caractères porte sur chaque note (de
  // l'item, d'une photo ou d'une sélection), pas sur leur somme ; la plus
  // longue décide. Sous la règle de la somme, quelques notes courtes
  // (« voir carton 12 », « date douteuse ») retenaient l'OCR ensemble.

  /** `notes_text` de la source d'un item Tropy. */
  function notesTextOf(tropyId: number): string | null {
    const db = brainDb();
    try {
      const row = db.prepare('SELECT notes_text FROM tropy_sources WHERE tropy_id = ?').get(tropyId) as
        | { notes_text: string | null }
        | undefined;
      return row?.notes_text ?? null;
    } finally {
      db.close();
    }
  }

  /** La longueur de la plus longue note, gardée pour le rapport de chaque source. */
  function longestNotes(): Array<{ tropy_id: number; longest_note_length: number | null }> {
    const db = brainDb();
    try {
      return db
        .prepare('SELECT tropy_id, longest_note_length FROM tropy_sources ORDER BY tropy_id')
        .all() as Array<{ tropy_id: number; longest_note_length: number | null }>;
    } finally {
      db.close();
    }
  }

  /** Vingt-quatre annotations de sélection : chacune un commentaire, plus de 500 caractères ensemble. */
  function shortAnnotations() {
    return Array.from({ length: 24 }, (_, i) => ({
      id: 100 + i,
      notes: [{ text: `Tampon de la préfecture, pièce ${i + 1}` }],
    }));
  }

  it('des notes de page, chacune sous 500 caractères, ne retiennent pas l’OCR (G1)', async () => {
    const half = Math.ceil(NOTE_TEXT.length / 2);
    const pages = [NOTE_TEXT.slice(0, half), NOTE_TEXT.slice(half)];
    expect(Math.max(...pages.map((p) => p.trim().length))).toBeLessThan(500);
    const page2 = path.join(tropyDir, 'rapport-p2.jpg');
    fs.writeFileSync(page2, 'jpeg factice');
    const items = baseItems();
    items[0] = {
      ...items[0],
      photos: [
        { id: 11, path: photoPath, notes: [{ text: pages[0] }] },
        { id: 12, path: page2, notes: [{ text: pages[1] }] },
      ],
    };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    expect(ocrReached(photoPath)).toBe(true);
    const s10 = snapshot().sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tesseract');
    expect(s10?.transcription).toBe(OCR_TEXT);
    // Les notes ne sont pas perdues : elles restent à côté du corps.
    expect(notesTextOf(10)).toContain('salle Colbert');
  });

  // Témoin du revers de G1, sans correctif en rc.6 : un manuscrit transcrit
  // page à page, dont l'OCR ne tire rien de lisible, n'acquiert jamais de
  // corps. Il repasse donc à l'OCR à chaque « Lancer l'OCR », comme un item
  // sans note ; la règle de la somme l'écartait. Ses notes restent son texte.
  it('des notes de page sous 500 caractères sur un manuscrit illisible : l’OCR repasse à chaque synchro, les notes restent le texte (G1)', async () => {
    const half = Math.ceil(NOTE_TEXT.length / 2);
    const pages = [NOTE_TEXT.slice(0, half), NOTE_TEXT.slice(half)];
    const page2 = path.join(tropyDir, 'rapport-p2.jpg');
    fs.writeFileSync(page2, 'jpeg factice');
    const items = baseItems();
    items[0] = {
      ...items[0],
      photos: [
        { id: 11, path: photoPath, notes: [{ text: pages[0] }] },
        { id: 12, path: page2, notes: [{ text: pages[1] }] },
      ],
    };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    // Sous les seuils de `performOCROnItem` (plus de 50 caractères et une
    // confiance de plus de 30) : rien d'exploitable.
    ocrSpy.mockResolvedValue({ text: 'xx ~~ ;; illisible', confidence: 12, language: 'fra', pageCount: 2 });

    for (let pass = 0; pass < 3; pass++) {
      const result = await tropyService.sync(syncOptions);
      expect(result.success).toBe(true);
    }

    // Une reconnaissance par passe, toujours sur les deux pages de l'item 10.
    expect(ocrSpy).toHaveBeenCalledTimes(3);
    for (const call of ocrSpy.mock.calls) {
      expect(call[0]).toEqual([photoPath, page2]);
    }
    const s10 = snapshot().sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tropy-notes');
    expect(s10?.transcription).toContain('salle Colbert');
    // Aucun message sous la source : sa plus longue note est sous le seuil.
    expect(tropyService.getSourceOCRReport(s10!.id)?.longestNoteLength).toBeLessThan(500);
  });

  it('des annotations courtes qui dépassent ensemble 500 caractères ne retiennent pas l’OCR (G1)', async () => {
    const annotations = shortAnnotations();
    expect(annotations.map((a) => a.notes[0].text).join('\n\n').length).toBeGreaterThanOrEqual(500);
    const items = baseItems();
    items[0] = { ...items[0], photos: [{ id: 11, path: photoPath, selections: annotations }] };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    expect(ocrReached(photoPath)).toBe(true);
    const s10 = snapshot().sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tesseract');
    expect(s10?.transcription).toBe(OCR_TEXT);
    expect(notesTextOf(10)).toContain('pièce 24');
    // Le rapport de la source lit la plus longue note, pas leur somme.
    const report = tropyService.getSourceOCRReport(s10!.id);
    expect(report?.longestNoteLength).toBe('Tampon de la préfecture, pièce 24'.length);
  });

  // Ce que fera la première synchro après G1 sur un projet existant : une
  // source à notes courtes, tenue jusque-là pour transcrite, passe à l'OCR
  // sans « Relancer l'OCR ». C'est voulu, mais c'est du calcul : le bilan le
  // compte.
  it('une source à notes courtes retenue par la règle de la somme passe à l’OCR à la synchro suivante, et le bilan le compte (G1)', async () => {
    const items = baseItems();
    items[0] = { ...items[0], photos: [{ id: 11, path: photoPath, selections: shortAnnotations() }] };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    // L'état que laissait la règle de la somme : les notes pour tout texte,
    // pas d'OCR. Une passe sans OCR laisse le même.
    await tropyService.sync({ ...syncOptions, performOCR: false });
    expect(snapshot().sources.find((s) => s.tropy_id === 10)?.transcription_source).toBe('tropy-notes');
    expect(ocrSpy).not.toHaveBeenCalled();

    const result = await tropyService.sync(syncOptions);

    expect(result.success).toBe(true);
    // Un seul item passe à l'OCR, une page : l'item 20, transcrit dans une
    // note de plus de 500 caractères, reste à ses notes.
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(ocrSpy.mock.calls[0][0]).toEqual([photoPath]);
    expect(result.ocrPerformed).toBe(1);
    expect(result.transcriptionsWritten).toBe(1);
    expect(result.updatedItems).toBe(1);
    const after = snapshot().sources;
    expect(after.find((s) => s.tropy_id === 10)?.transcription_source).toBe('tesseract');
    expect(after.find((s) => s.tropy_id === 20)?.transcription_source).toBe('tropy-notes');
  });

  it('une note de 500 caractères ou plus retient l’OCR, même parmi des notes courtes : la plus longue décide (G1)', async () => {
    const items = baseItems();
    items[0] = {
      ...items[0],
      notes: [{ text: 'Voir aussi carton 12' }],
      photos: [
        {
          id: 11,
          path: photoPath,
          notes: [{ text: 'Date douteuse' }],
          selections: [{ id: 30, notes: [{ text: NOTE_TEXT }] }],
        },
      ],
    };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    expect(ocrReached(photoPath)).toBe(false);
    const s10 = snapshot().sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tropy-notes');
    expect(s10?.transcription).toContain('salle Colbert');
  });

  it('une note de 500 caractères ou plus ajoutée après l’OCR ne remplace pas la transcription (G1)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    const items = baseItems();
    items[0] = { ...items[0], notes: [{ text: NOTE_TEXT }], modified: '2026-06-01T08:00:00.000Z' };
    makeTpy(tropyDir, spec({ items }));
    await tropyService.sync(syncOptions);

    expect(ocrSpy).toHaveBeenCalledTimes(1);
    const s10 = snapshot().sources.find((s) => s.tropy_id === 10);
    expect(s10?.transcription_source).toBe('tesseract');
    expect(s10?.transcription).toBe(OCR_TEXT);
    expect(notesTextOf(10)).toBe(NOTE_TEXT);
  });

  it('une base d’avant la colonne longest_note_length la remplit à la synchro suivante, sans réembarquer (G1)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);
    await tropyService.close();

    // Ramener brain.db au schéma d'avant G1, comme sur les postes des
    // historiens avant la mise à jour.
    const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'));
    db.exec('ALTER TABLE tropy_sources DROP COLUMN longest_note_length');
    db.close();
    const before = snapshot();
    const embeddedBefore = embedCalls.texts;

    await tropyService.init(projectDir);
    // Ligne d'avant la colonne : le rapport ne sait pas encore, et ne
    // conclut rien.
    const s20 = before.sources.find((s) => s.tropy_id === 20)!;
    expect(tropyService.getSourceOCRReport(s20.id)?.longestNoteLength).toBeNull();

    await tropyService.openProject(tpy);
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.updatedItems).toBe(0);

    const after = snapshot();
    expect(embedCalls.texts).toBe(embeddedBefore);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.sources.map((s) => [s.id, s.transcription, s.transcription_source])).toEqual(
      before.sources.map((s) => [s.id, s.transcription, s.transcription_source])
    );
    expect(longestNotes()).toEqual([
      { tropy_id: 10, longest_note_length: 0 },
      { tropy_id: 20, longest_note_length: NOTE_TEXT.length },
    ]);
    expect(tropyService.getSourceOCRReport(s20.id)?.longestNoteLength).toBe(NOTE_TEXT.length);
  });

  // L06-5 (S02-1-10) : Tropy garde l'id d'une photo qu'il déplace d'un item à
  // l'autre (`UPDATE photos SET item_id`, pour un déplacement comme pour une
  // fusion) et avance la date `modified` de l'item qui la reçoit. Réécrire
  // celui-ci levait UNIQUE sur `tropy_photos.id` tant que la photo restait,
  // en base, à la source qui l'a perdue.
  function movePhoto(tpy: string, photoId: number, toItem: number, modified: number[]): void {
    const db = openTpyForWrite(tpy);
    try {
      db.prepare('UPDATE photos SET item_id = ?, position = 99 WHERE id = ?').run(toItem, photoId);
      const touch = db.prepare("UPDATE subjects SET modified = '2026-06-01T08:00:00.000Z' WHERE id = ?");
      for (const id of modified) touch.run(id);
    } finally {
      db.close();
    }
  }

  function photoOwners(): Array<{ photo: number; tropy_id: number }> {
    const db = brainDb();
    try {
      return db
        .prepare(
          `SELECT p.id AS photo, s.tropy_id FROM tropy_photos p
           JOIN tropy_sources s ON s.id = p.source_id ORDER BY p.id`
        )
        .all() as Array<{ photo: number; tropy_id: number }>;
    } finally {
      db.close();
    }
  }

  it('une photo déplacée vers un item traité avant celui qui la perd change de source, sans erreur (L06-5)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    expect((await tropyService.sync(syncOptions)).errors).toEqual([]);
    expect(photoOwners()).toEqual([
      { photo: 11, tropy_id: 10 },
      { photo: 21, tropy_id: 20 },
    ]);

    // La photo 21 passe de l'item 20 à l'item 10, lu le premier ; les deux
    // items sont datés de la modification.
    movePhoto(tpy, 21, 10, [10, 20]);
    const result = await tropyService.sync(syncOptions);

    expect(result.errors).toEqual([]);
    expect(result.updatedItems).toBe(2);
    expect(photoOwners()).toEqual([
      { photo: 11, tropy_id: 10 },
      { photo: 21, tropy_id: 10 },
    ]);
  });

  it('une photo déplacée depuis un item que la passe ne réécrit pas change de source, sans erreur (L06-5)', async () => {
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    // Comme une fusion de l'item 10 dans l'item 20 : seul l'item qui reçoit
    // la photo est daté de la modification ; l'item 10, inchangé pour la
    // synchro, n'est pas réécrit et garde la photo en base.
    movePhoto(tpy, 11, 20, [20]);
    const result = await tropyService.sync(syncOptions);

    expect(result.errors).toEqual([]);
    expect(result.updatedItems).toBe(1);
    expect(result.skippedItems).toBe(1);
    expect(photoOwners()).toEqual([
      { photo: 11, tropy_id: 20 },
      { photo: 21, tropy_id: 20 },
    ]);
  });

  // L06-12 (S08-1-10) : la table `transcriptions` de Tropy n'est pas lue, la
  // photo repart à l'OCR.
  it.fails('une photo transcrite dans Tropy ne repart pas à l’OCR (L06-12, S08-1-10)', async () => {
    const items = baseItems();
    items[0] = {
      ...items[0],
      photos: [{ id: 11, path: photoPath, transcriptions: [{ text: OCR_TEXT, status: 1 }] }],
    };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    // Ciblé sur la photo de l'item 10 : l'item 20 ne doit pas peser sur ce rouge.
    expect(ocrSpy).not.toHaveBeenCalledWith([photoPath], expect.anything());
    expect(snapshot().sources.find((s) => s.tropy_id === 10)?.transcription).toContain('Monsieur Durand');
  });

  // L06-12 (S08-1-3) : la table `trash` n'est pas filtrée.
  it.fails('un item à la corbeille de Tropy n’est ni synchronisé ni passé à l’OCR (L06-12, S08-1-3)', async () => {
    const items = baseItems();
    items[0] = { ...items[0], trash: 'user' };
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);
    await tropyService.sync(syncOptions);

    // Ciblé sur la photo de l'item 10 : l'item 20 ne doit pas peser sur ce rouge.
    expect(ocrSpy).not.toHaveBeenCalledWith([photoPath], expect.anything());
    expect(snapshot().sources.map((s) => s.tropy_id)).toEqual([20]);
  });

  // L06-10 (S08-1-34) : Poppler absent faisait sauter chaque item à PDF — ni
  // source créée ni métadonnées écrites — et la marche à suivre restait dans
  // la console.
  it('Poppler absent : 40 items PDF enregistrés sans OCR, une seule issue au bilan (L06-10, S08-1-34)', async () => {
    const items: TpyItemSpec[] = Array.from({ length: 40 }, (_, i) => {
      const pdf = path.join(tropyDir, `liasse-${i + 1}.pdf`);
      fs.writeFileSync(pdf, '%PDF factice');
      return { title: `Liasse ${i + 1}`, photos: [{ path: pdf }] };
    });
    ocrSpy.mockRejectedValue(new PopplerNotFoundError());
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);

    const result = await tropyService.sync(syncOptions);

    expect(result.success).toBe(true);
    expect(result.newItems).toBe(40);
    expect(result.issues).toEqual([{ code: 'poppler-missing' }]);
    // L'issue tient lieu de message : pas aussi « 1 erreur — voir la console ».
    expect(result.errors).toEqual([]);
    const sources = snapshot().sources;
    expect(sources).toHaveLength(40);
    expect(sources.every((s) => s.transcription === null)).toBe(true);
  });

  it('Poppler absent pour le PDF d’un item mixte : l’OCR de ses images est gardé, et le bilan le dit (L06-10, S08-1-14)', async () => {
    ocrSpy.mockResolvedValue({ text: OCR_TEXT, confidence: 88.5, language: 'fra', pageCount: 1, missingTool: 'poppler' });
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);

    const result = await tropyService.sync(syncOptions);

    expect(result.issues).toEqual([{ code: 'poppler-missing' }]);
    expect(snapshot().sources.find((s) => s.tropy_id === 10)?.transcription).toBe(OCR_TEXT);
  });

  // Revue de L06-10. Un item qui mêle images et PDF, reconnu par le vrai
  // `performBatchOCR` : seul `performOCR`, fichier par fichier, est simulé, le
  // PDF levant PopplerNotFoundError tant que Poppler manque.
  describe('item mixte, Poppler installé ou retiré entre deux passes (revue L06-10)', () => {
    const PDF_TEXT = 'TEXTE DU PDF ' + OCR_TEXT;
    const IMAGE_TEXT = 'TEXTE DE L IMAGE ' + OCR_TEXT;
    let poppler: boolean;
    /** Le PDF échoue pour une raison ordinaire (illisible, chiffré), Poppler présent. */
    let pdfBroken: boolean;
    let pdfPath: string;
    let ocrFiles: string[];

    beforeEach(() => {
      ocrSpy.mockRestore();
      pdfPath = path.join(tropyDir, 'annexe.pdf');
      fs.writeFileSync(pdfPath, '%PDF factice');
      poppler = true;
      pdfBroken = false;
      ocrFiles = [];
      vi.spyOn(TropyOCRPipeline.prototype, 'performOCR').mockImplementation(async (file: string) => {
        ocrFiles.push(file);
        if (file.endsWith('.pdf')) {
          if (!poppler) throw new PopplerNotFoundError();
          if (pdfBroken) throw new Error('Failed to convert PDF: Syntax Error');
          return { text: PDF_TEXT, confidence: 90, language: 'fra', pageCount: 1 };
        }
        return { text: IMAGE_TEXT, confidence: 90, language: 'fra', pageCount: 1 };
      });
    });

    async function openMixedItem(): Promise<void> {
      const item = { ...baseItems()[0], photos: [{ id: 11, path: photoPath }, { id: 12, path: pdfPath }] };
      await tropyService.openProject(makeTpy(tropyDir, spec({ items: [item] })));
    }

    /** La marque « en attente de Poppler » de chaque source, dans l'ordre des items. */
    function pendingMarks(): Array<string | null> {
      const db = brainDb();
      try {
        const rows = db.prepare('SELECT ocr_pending FROM tropy_sources ORDER BY tropy_id').all() as Array<{
          ocr_pending: string | null;
        }>;
        return rows.map((row) => row.ocr_pending);
      } finally {
        db.close();
      }
    }

    // Le texte des seules images était tenu pour une transcription acquise :
    // « Lancer l'OCR », une fois Poppler installé, ne reprenait jamais le PDF.
    it('Poppler installé après une passe sans lui : « Lancer l’OCR », sans forcer, reprend le PDF', async () => {
      poppler = false;
      await openMixedItem();
      const first = await tropyService.sync(syncOptions);
      expect(first.issues).toEqual([{ code: 'poppler-missing' }]);
      // Le travail déjà fait est gardé en attendant (S08-1-14).
      expect(snapshot().sources[0].transcription).toContain('TEXTE DE L IMAGE');

      poppler = true;
      const second = await tropyService.sync(syncOptions);

      expect(second.issues).toEqual([]);
      expect(second.transcriptionsWritten).toBe(1);
      const after = snapshot();
      expect(after.sources[0].transcription).toContain('TEXTE DU PDF');
      expect(after.sources[0].transcription).toContain('TEXTE DE L IMAGE');
      // Les extraits suivent le texte complet.
      expect(after.chunks.some((c) => c.content.includes('TEXTE DU PDF'))).toBe(true);

      // Reprise faite une fois : la passe d'après ne refait rien.
      ocrFiles = [];
      await tropyService.sync(syncOptions);
      expect(ocrFiles).toEqual([]);
    });

    // La reprise, Poppler installé, peut rendre exactement le texte partiel déjà
    // enregistré : un PDF illisible, que le lot saute, ou retiré du disque. Rien
    // d'autre ne changeant, la marque n'était jamais levée, et chaque « Lancer
    // l'OCR » refaisait l'OCR de l'item, sans fin, pour un bilan vide.
    it.each([
      ['un PDF illisible', 'illisible'],
      ['un PDF retiré du disque', 'retiré'],
    ] as const)('Poppler installé, %s : la source sort de l’attente, et la passe suivante ne refait rien', async (_label, mode) => {
      poppler = false;
      await openMixedItem();
      await tropyService.sync(syncOptions);
      const partial = snapshot().sources[0].transcription;
      expect(pendingMarks()).toEqual(['poppler']);

      poppler = true;
      if (mode === 'illisible') pdfBroken = true;
      else fs.unlinkSync(pdfPath);
      ocrFiles = [];
      const second = await tropyService.sync(syncOptions);

      expect(second.issues).toEqual([]);
      expect(ocrFiles.some((f) => f.endsWith('.jpg'))).toBe(true);
      // Le même texte qu'avant : rien de neuf à écrire ni à réembarquer.
      expect(snapshot().sources[0].transcription).toBe(partial);
      expect(second.transcriptionsWritten).toBe(0);
      expect(pendingMarks()).toEqual([null]);

      ocrFiles = [];
      await tropyService.sync(syncOptions);
      expect(ocrFiles).toEqual([]);
    });

    // Des notes Tropy qui font une transcription (Q26) tiennent l'OCR à
    // l'écart sans forcer. Mais « Relancer l'OCR sur toutes les sources » sans
    // Poppler y mettait le texte des seules images, en attente : la reprise
    // que promet l'avis ne venait jamais, la source restait partielle.
    it('notes valant transcription, passe forcée sans Poppler, puis Poppler installé : « Lancer l’OCR » reprend le PDF', async () => {
      const item = { ...baseItems()[1], photos: [{ id: 21, path: photoPath }, { id: 22, path: pdfPath }] };
      await tropyService.openProject(makeTpy(tropyDir, spec({ items: [item] })));
      await tropyService.sync(syncOptions);
      expect(snapshot().sources[0].transcription_source).toBe('tropy-notes');

      poppler = false;
      const forced = await tropyService.sync({ ...syncOptions, forceReindex: true });
      expect(forced.issues).toEqual([{ code: 'poppler-missing' }]);
      expect(snapshot().sources[0].transcription).toContain('TEXTE DE L IMAGE');

      poppler = true;
      ocrFiles = [];
      const resumed = await tropyService.sync(syncOptions);

      expect(ocrFiles.some((f) => f.endsWith('.pdf'))).toBe(true);
      expect(resumed.transcriptionsWritten).toBe(1);
      expect(snapshot().sources[0].transcription).toContain('TEXTE DU PDF');
      expect(pendingMarks()).toEqual([null]);

      ocrFiles = [];
      await tropyService.sync(syncOptions);
      expect(ocrFiles).toEqual([]);
    });

    // Le bilan comptait le PDF resté faute de Poppler parmi les pages passées
    // à la reconnaissance, puis encore une fois à sa reprise.
    it('sans Poppler, le bilan ne compte pas le PDF parmi les pages passées à la reconnaissance', async () => {
      poppler = false;
      await openMixedItem();
      const first = await tropyService.sync(syncOptions);
      expect(first.ocrPerformed).toBe(1);

      poppler = true;
      const second = await tropyService.sync(syncOptions);
      expect(second.ocrPerformed).toBe(2);
    });

    // L06-11 (S08-2-8) : le bilan comptait les fichiers de l'item, PDF sauté
    // compris (« 4 page(s) » pour 3, mesuré par L06-10).
    it('Poppler présent, PDF illisible : il ne compte pas parmi les pages passées à la reconnaissance (L06-11)', async () => {
      pdfBroken = true;
      await openMixedItem();

      const result = await tropyService.sync(syncOptions);

      expect(result.transcriptionsWritten).toBe(1);
      expect(result.ocrPerformed).toBe(1);
    });

    // Une source à reprendre l'est à chaque passe OCR. Tant que Poppler manque,
    // chaque reprise referait l'OCR de ses images pour le même texte partiel :
    // une fois la passe sûre que Poppler manque, elle n'y revient plus.
    it('Poppler toujours absent : la passe ne refait pas, source après source, l’OCR des images déjà reconnues', async () => {
      poppler = false;
      const items = [1, 2, 3].map((n) => {
        const image = path.join(tropyDir, `dossier-${n}.jpg`);
        const pdf = path.join(tropyDir, `dossier-${n}.pdf`);
        fs.writeFileSync(image, 'jpeg factice');
        fs.writeFileSync(pdf, '%PDF factice');
        return { id: n * 10, title: `Dossier ${n}`, photos: [{ id: n * 10 + 1, path: image }, { id: n * 10 + 2, path: pdf }] };
      });
      await tropyService.openProject(makeTpy(tropyDir, spec({ items })));
      await tropyService.sync(syncOptions);
      const firstTexts = snapshot().sources.map((s) => s.transcription);
      expect(firstTexts.every((t) => t?.includes('TEXTE DE L IMAGE'))).toBe(true);

      ocrFiles = [];
      const second = await tropyService.sync(syncOptions);

      // La première source reprise apprend à la passe que Poppler manque.
      expect(ocrFiles.filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
      expect(second.issues).toEqual([{ code: 'poppler-missing' }]);
      expect(snapshot().sources.map((s) => s.transcription)).toEqual(firstTexts);

      // Poppler installé : toutes sont reprises.
      poppler = true;
      await tropyService.sync(syncOptions);
      expect(snapshot().sources.every((s) => s.transcription?.includes('TEXTE DU PDF'))).toBe(true);
    });

    // « Relancer l'OCR sur toutes les sources » sans Poppler remplaçait une
    // transcription complète par celle des seules images : le texte du PDF,
    // déjà acquis, était perdu.
    it('passe forcée sans Poppler : la transcription complète déjà acquise est gardée', async () => {
      await openMixedItem();
      await tropyService.sync(syncOptions);
      const before = snapshot();
      expect(before.sources[0].transcription).toContain('TEXTE DU PDF');

      poppler = false;
      const forced = await tropyService.sync({ ...syncOptions, forceReindex: true });

      expect(forced.success).toBe(true);
      expect(forced.issues).toEqual([{ code: 'poppler-missing' }]);
      expect(forced.errors).toEqual([]);
      expect(forced.transcriptionsWritten).toBe(0);
      const after = snapshot();
      expect(after.sources[0].transcription).toBe(before.sources[0].transcription);
      expect(after.chunks.map((c) => c.content)).toEqual(before.chunks.map((c) => c.content));
    });

    // Une transcription écrite par l'historien sur une source en attente de
    // Poppler n'est plus « à reprendre » : la passe suivante ne l'écrase pas.
    it('une transcription saisie entre-temps n’est pas reprise par l’OCR', async () => {
      poppler = false;
      await openMixedItem();
      await tropyService.sync(syncOptions);
      const id = snapshot().sources[0].id;
      const manual = 'Transcription revue par l’historienne, images et annexe comprises. ' + OCR_TEXT;
      expect((await tropyService.updateSourceTranscription(id, manual, 'manual')).success).toBe(true);

      poppler = true;
      ocrFiles = [];
      await tropyService.sync(syncOptions);

      expect(ocrFiles).toEqual([]);
      expect(snapshot().sources[0]).toMatchObject({ transcription: manual, transcription_source: 'manual' });
    });

    // L'OCR manuel de la carte suit le même chemin : sans Poppler, il rendait
    // `success: true` avec le texte des seules images, que le store écrivait
    // à la place de la transcription complète, sans rien en dire.
    it('OCR manuel sans Poppler sur un item mixte : un échec, pas un texte partiel', async () => {
      poppler = false;
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await tropyService.performBatchOCR([photoPath, pdfPath], 'fra');

      expect(result.success).toBe(false);
      expect(result.text).toBeUndefined();
      expect(result.error).toMatch(/Poppler/);
    });
  });

  // L06-10 (S08-1-29) : chaque item retentait un moteur qui ne pouvait pas
  // démarrer — avec le vrai tesseract.js, la passe restait bloquée au premier.
  it('modèle de langue introuvable : une tentative pour la passe, items enregistrés, une issue (L06-10, S08-1-29)', async () => {
    const third = path.join(tropyDir, 'affiche.jpg');
    fs.writeFileSync(third, 'jpeg factice');
    const items = [...baseItems(), { id: 30, title: 'Affiche du syndicat', photos: [{ id: 31, path: third }] }];
    ocrSpy.mockRejectedValue(
      new OcrEngineUnavailableError('frk', 'Network error while fetching frk.traineddata.gz. Response code: 404')
    );
    const tpy = makeTpy(tropyDir, spec({ items }));
    await tropyService.openProject(tpy);

    const result = await tropyService.sync({ ...syncOptions, ocrLanguage: 'frk' });

    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.newItems).toBe(3);
    expect(result.issues).toEqual([{ code: 'ocr-language-unavailable', language: 'frk' }]);
    expect(result.errors).toEqual([]);
    expect(snapshot().sources.map((s) => s.tropy_id)).toEqual([10, 20, 30]);
  });

  // L06-11 (S08-1-5) : le moteur de la synchro gardait la langue de la
  // première passe. Relancer en « Allemand » un fonds pris pour français
  // refaisait des heures d'OCR avec le modèle français, étiqueté 'deu'.
  it('relancer l’OCR en allemand après une passe en français : reconnu par le modèle allemand (L06-11, S08-1-5)', async () => {
    ocrSpy.mockRestore();
    tess.recognize = async (_file, language) => ({ data: { text: `[${language}] ${OCR_TEXT}`, confidence: 88 } });
    await tropyService.openProject(makeTpy(tropyDir, spec()));

    await tropyService.sync(syncOptions);
    expect(snapshot().sources[0].transcription).toBe(`[fra] ${OCR_TEXT}`);

    await tropyService.sync({ ...syncOptions, ocrLanguage: 'deu', forceReindex: true });

    const after = snapshot();
    expect(after.sources[0].transcription).toBe(`[deu] ${OCR_TEXT}`);
    expect(after.chunks.some((c) => c.content.includes('[fra]'))).toBe(false);
  });

  // L06-11 (S08-2-1) : une lettre photographiée en quatre vues, recto écrit,
  // verso et enveloppe blancs. La moyenne simple des confiances (75/4) tombait
  // sous le seuil de la synchro : l'OCR du recto était jeté, à chaque passe.
  it('une lettre et trois vues blanches : le texte du recto est gardé, avec sa confiance (L06-11, S08-2-1)', async () => {
    ocrSpy.mockRestore();
    const views = ['recto', 'verso', 'enveloppe-recto', 'enveloppe-verso'].map((name) => {
      const file = path.join(tropyDir, `${name}.jpg`);
      fs.writeFileSync(file, 'jpeg factice');
      return file;
    });
    tess.recognize = async (file) =>
      file === views[0] ? { data: { text: OCR_TEXT, confidence: 75 } } : { data: { text: '', confidence: 0 } };
    const item = { id: 40, title: 'Lettre du maire', photos: views.map((p) => ({ path: p })) };
    await tropyService.openProject(makeTpy(tropyDir, spec({ items: [item] })));

    const result = await tropyService.sync(syncOptions);

    expect(snapshot().sources[0]).toMatchObject({ transcription: OCR_TEXT, ocr_confidence: 75 });
    expect(result.transcriptionsWritten).toBe(1);
    expect(result.ocrPerformed).toBe(4);
  });

  // Rien à moyenner : ni NaN en base, ni en-tête « --- Page 1 --- » seul, que
  // l'OCR manuel de la carte écrivait comme une transcription.
  it('un PDF d’une seule page blanche : ni transcription ni confiance, par la synchro comme par l’OCR manuel (L06-11, S08-2-1)', async () => {
    ocrSpy.mockRestore();
    const pdf = path.join(tropyDir, 'feuillet.pdf');
    fs.writeFileSync(pdf, '%PDF factice');
    convertPdfTo(1);
    tess.recognize = async () => ({ data: { text: '', confidence: 0 } });
    const item = { id: 50, title: 'Feuillet blanc', photos: [{ path: pdf }] };
    await tropyService.openProject(makeTpy(tropyDir, spec({ items: [item] })));

    const result = await tropyService.sync(syncOptions);
    const manual = await tropyService.performBatchOCR([pdf], 'fra');

    expect(snapshot().sources[0]).toMatchObject({ transcription: null, ocr_confidence: null });
    expect(result.transcriptionsWritten).toBe(0);
    // Le store n'écrit qu'un texte non vide.
    expect(manual).toEqual({ success: true, text: '', confidence: 0 });
  });

  // L06-11 (S08-2-8) : Tropy crée une photo par page de PDF, toutes sur le
  // même fichier. « N page(s) passée(s) à la reconnaissance » comptait les
  // fichiers : 1 pour un registre de 120 pages.
  it('un registre PDF de 120 pages : 120 pages au bilan (L06-11, S08-2-8)', async () => {
    ocrSpy.mockRestore();
    const pdf = path.join(tropyDir, 'registre.pdf');
    fs.writeFileSync(pdf, '%PDF factice');
    convertPdfTo(120);
    tess.recognize = async (file) => ({ data: { text: `${path.basename(file)} : ${OCR_TEXT}`, confidence: 88 } });
    const photos = Array.from({ length: 120 }, (_, page) => ({ path: pdf, page }));
    await tropyService.openProject(makeTpy(tropyDir, spec({ items: [{ id: 60, title: 'Registre des délibérations', photos }] })));

    const result = await tropyService.sync(syncOptions);

    expect(result.transcriptionsWritten).toBe(1);
    expect(result.ocrPerformed).toBe(120);
  });

  // L06-10 (S08-1-16) : le moteur de la synchro n'était jamais libéré au
  // changement de projet. Le libérer ne doit pas laisser la passe du projet
  // quitté attendre pour toujours une reconnaissance que `terminate` ne règle pas.
  it('un changement de projet pendant l’OCR : moteur libéré, et la passe quittée échoue franchement (L06-10, S08-1-16)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ocrSpy.mockRestore();
    const recognizing = vi.fn((_file: string) => new Promise<never>(() => undefined));
    tess.recognize = recognizing;
    const tpy = makeTpy(tropyDir, spec());
    await tropyService.openProject(tpy);
    const running = tropyService.sync(syncOptions);
    await vi.waitFor(() => expect(recognizing).toHaveBeenCalledTimes(1), { timeout: 15_000 });

    const otherProject = path.join(root, 'projet-B');
    fs.mkdirSync(otherProject);
    await tropyService.init(otherProject);

    const result = await running;
    expect(tess.terminated).toBe(1);
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toMatch(/OCR engine stopped/);
  }, 30_000);

  it('un paquet .tropy en WAL se synchronise comme un .tpy nu', async () => {
    const pkg = makeTpy(tropyDir, {
      projectId: 'projet-paquet',
      name: 'Paquet',
      packaged: true,
      wal: true,
      items: [{ id: 5, title: 'Pièce scannée', photos: [{ id: 6, path: 'scan.jpg' }] }],
    });
    const asset = path.join(pkg, 'assets', 'scan.jpg');
    fs.writeFileSync(asset, 'jpeg factice');

    expect((await tropyService.openProject(pkg)).success).toBe(true);
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(ocrSpy).toHaveBeenCalledWith([asset], { language: 'fra' });

    const after = snapshot();
    expect(after.projectRows).toBe(1);
    expect(after.sources).toHaveLength(1);
    expect(after.sources[0].transcription).toBe(OCR_TEXT);
    expect(after.chunks.length).toBeGreaterThan(0);
  });

  // G2 : `TropyReader` ouvrait le .tpy par `new Database(…, { readonly: true })`.
  // Sur une base en WAL, Tropy fermé, SQLite créait `-wal` et `-shm` à côté
  // et les y laissait : deux fichiers étrangers dans le dossier de l'historien.
  describe('Tropy fermé, base en WAL : rien de créé ni laissé à côté du .tpy (G2)', () => {
    function files(dir: string): string[] {
      return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
    }

    function digest(file: string): string {
      return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }

    it('un .tpy nu : ouverture, synchro et photos d’une source', async () => {
      const tpy = makeTpy(tropyDir, spec({ wal: true }));
      const before = files(tropyDir);
      const bytes = digest(tpy);
      expect(before.filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toEqual([]);

      expect((await tropyService.openProject(tpy)).success).toBe(true);
      const result = await tropyService.sync(syncOptions);
      expect(result.success).toBe(true);
      expect(result.projectName).toBe('Grèves nantaises');
      expect(result.newItems).toBe(2);
      const ocred = snapshot().sources.find((s) => s.tropy_id === 10);
      expect(ocred?.transcription).toBe(OCR_TEXT);
      // L'OCR manuel relit le .tpy pour trouver les photos de la source.
      expect(tropyService.getSourcePhotoPaths(ocred!.id)).toEqual([photoPath]);

      expect(files(tropyDir)).toEqual(before);
      expect(digest(tpy)).toBe(bytes);
    });

    it('un paquet .tropy : photo relative au dossier assets', async () => {
      const pkg = makeTpy(tropyDir, {
        projectId: 'projet-paquet',
        name: 'Paquet',
        packaged: true,
        wal: true,
        items: [{ id: 5, title: 'Pièce scannée', photos: [{ id: 6, path: 'scan.jpg' }] }],
      });
      const asset = path.join(pkg, 'assets', 'scan.jpg');
      fs.writeFileSync(asset, 'jpeg factice');
      const before = files(pkg);
      const bytes = digest(tpyDatabasePath(pkg));

      expect((await tropyService.openProject(pkg)).success).toBe(true);
      const result = await tropyService.sync(syncOptions);
      expect(result.success).toBe(true);
      expect(result.newItems).toBe(1);
      expect(ocrSpy).toHaveBeenCalledWith([asset], { language: 'fra' });

      expect(files(pkg)).toEqual(before);
      expect(digest(tpyDatabasePath(pkg))).toBe(bytes);
    });
  });

  // Témoin de G2 : Tropy ouvert, ses `-wal` et `-shm` existent et le journal
  // tient ce qu'il n'a pas encore reporté dans la base. La synchro doit le voir.
  it('Tropy ouvert : la synchro voit l’item qu’il n’a pas encore reporté dans la base (G2, témoin)', async () => {
    const tpy = makeTpy(tropyDir, spec({ wal: true }));
    const tropy = openTpyForWrite(tpy);
    try {
      tropy.pragma('journal_mode = WAL');
      tropy.pragma('wal_autocheckpoint = 0');
      // Un item créé dans Tropy, encore dans le journal.
      tropy.transaction(() => {
        tropy
          .prepare('INSERT INTO subjects (id, modified) VALUES (30, ?)')
          .run('2026-06-01T08:00:00.000Z');
        tropy.prepare('INSERT INTO items (id) VALUES (30)').run();
        const { value_id } = tropy
          .prepare('INSERT INTO metadata_values (datatype, text) VALUES (?, ?) RETURNING value_id')
          .get('http://www.w3.org/2001/XMLSchema#string', 'Affiche du syndicat des dockers') as {
          value_id: number;
        };
        tropy
          .prepare('INSERT INTO metadata (id, property, value_id) VALUES (30, ?, ?)')
          .run('http://purl.org/dc/elements/1.1/title', value_id);
      })();
      const dbFile = tpyDatabasePath(tpy);
      expect(fs.existsSync(`${dbFile}-wal`) && fs.existsSync(`${dbFile}-shm`)).toBe(true);

      expect((await tropyService.openProject(tpy)).success).toBe(true);
      const result = await tropyService.sync(syncOptions);
      expect(result.success).toBe(true);
      expect(result.totalItems).toBe(3);
      expect(result.newItems).toBe(3);

      const db = brainDb();
      try {
        const row = db.prepare('SELECT title FROM tropy_sources WHERE tropy_id = 30').get() as
          | { title: string }
          | undefined;
        expect(row?.title).toBe('Affiche du syndicat des dockers');
      } finally {
        db.close();
      }
    } finally {
      tropy.close();
    }
  });

  // L06-7 (S15-1-36) : l'import d'un dossier de transcriptions (modale
  // d'import, mode « dossier ») étiquetait 'transkribus' tout fichier trouvé,
  // ALTO et texte brut compris ; le rapport OCR et les statistiques par
  // provenance les comptaient comme des exports Transkribus.
  it('un dossier de transcriptions importé : la provenance suit le format de chaque fichier (L06-7)', async () => {
    const transcriptionDir = path.join(root, 'transcriptions');
    fs.mkdirSync(transcriptionDir);
    fs.writeFileSync(
      path.join(transcriptionDir, '10.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"><Layout><Page ID="p1"><PrintSpace><TextBlock>' +
        '<TextLine><String CONTENT="Rapport"/><String CONTENT="du"/><String CONTENT="préfet"/></TextLine>' +
        '<TextLine><String CONTENT="sur"/><String CONTENT="la"/><String CONTENT="grève"/></TextLine>' +
        '</TextBlock></PrintSpace></Page></Layout></alto>\n'
    );
    fs.writeFileSync(
      path.join(transcriptionDir, '20.txt'),
      'Lettre du commissaire central, transcrite à la main hors de ClioDeck.\n'
    );
    fs.writeFileSync(
      path.join(transcriptionDir, '30.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2013-07-15"><Page imageFilename="affiche.jpg">' +
        '<TextRegion><TextLine><TextEquiv><Unicode>Affiche du syndicat des dockers</Unicode></TextEquiv></TextLine></TextRegion>' +
        '</Page></PcGts>\n'
    );
    const tpy = makeTpy(
      tropyDir,
      spec({
        items: [
          { id: 10, title: 'Rapport du préfet', photos: [{ id: 11, path: photoPath }] },
          { id: 20, title: 'Lettre du commissaire', photos: [{ id: 21, path: photoPath.replace('rapport', 'lettre') }] },
          { id: 30, title: 'Affiche du syndicat', photos: [{ id: 31, path: photoPath }] },
        ],
      })
    );
    expect((await tropyService.openProject(tpy)).success).toBe(true);

    // Ce que fait la modale en mode « dossier ».
    const result = await tropyService.sync({
      performOCR: false,
      ocrLanguage: 'fra',
      transcriptionDirectory: transcriptionDir,
      forceReindex: true,
    });
    expect(result.success).toBe(true);
    expect(result.transcriptionsImported).toBe(3);

    const bySource = new Map(snapshot().sources.map((s) => [s.tropy_id, s]));
    expect(bySource.get(10)).toMatchObject({
      transcription: 'Rapport du préfet\nsur la grève',
      transcription_source: 'imported',
      ocr_confidence: null,
    });
    expect(bySource.get(20)).toMatchObject({
      transcription: 'Lettre du commissaire central, transcrite à la main hors de ClioDeck.',
      transcription_source: 'imported',
      ocr_confidence: null,
    });
    expect(bySource.get(30)).toMatchObject({
      transcription: 'Affiche du syndicat des dockers',
      transcription_source: 'transkribus',
      ocr_confidence: null,
    });
  });
});
