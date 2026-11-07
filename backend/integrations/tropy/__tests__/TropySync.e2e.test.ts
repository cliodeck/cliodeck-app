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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';
import { makeTpy, tpyDatabasePath, type TpyItemSpec, type TpySpec } from './helpers/make-tpy';
import { TropyReader } from '../TropyReader';
import { TropyOCRPipeline } from '../TropyOCRPipeline';

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
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
  // `performOCROnItem` écarte les photos absentes du disque : il faut de vrais fichiers.
  photoPath = path.join(tropyDir, 'rapport.jpg');
  fs.writeFileSync(photoPath, 'jpeg factice');
  fs.writeFileSync(photoPath.replace('rapport', 'lettre'), 'jpeg factice');

  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  embedCalls.texts = 0;
  ocrSpy = vi
    .spyOn(TropyOCRPipeline.prototype, 'performBatchOCR')
    .mockResolvedValue({ text: OCR_TEXT, confidence: 88.5, language: 'fra' });

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

    // L'historien corrige le titre dans Tropy : `subjects.modified` avance pour CET item.
    const items = baseItems();
    items[0] = { ...items[0], title: 'Rapport du préfet (corrigé)', modified: '2026-06-01T08:00:00.000Z' };
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

    ocrSpy.mockResolvedValue({ text: '', confidence: 0, language: 'fra' });
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

  // L06-2 (S08-1-1) : une note ajoutée dans Tropy devient la transcription
  // ('tropy-notes') et ses extraits remplacent ceux de l'OCR.
  it.fails('une note ajoutée après l’OCR ne remplace pas la transcription (L06-2, S08-1-1)', async () => {
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
  // tient lieu de transcription et empêche l'OCR. Sous 500 caractères, une note
  // est un commentaire : l'OCR doit passer.
  it.fails('une note de moins de 500 caractères n’empêche pas l’OCR (L06-2, Q26)', async () => {
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
});
