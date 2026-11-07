/**
 * Un projet ClioDeck, un projet Tropy (L06-3, S02-1-18 ; décision Q25).
 *
 * Les identifiants d'items et de photos d'un .tpy sont locaux, de 1 à N dans
 * chaque projet Tropy, et la synchro rapprochait une source de son item par ce
 * seul numéro. Ouvrir un second projet Tropy rattachait donc l'item 10 de B à
 * la source 10 de A : titre de B sur le texte OCR de A (la lettre de Blum
 * attribuée au rapport du préfet), photos en conflit UNIQUE, OCR de A écrasé.
 * La contre-vérification l'a reproduit sur deux vrais .tpy ; ce fichier
 * reprend son scénario, avec les mêmes vrais composants que
 * `TropySync.e2e.test.ts` : vrai .tpy, vrai brain.db, vrai `tropyService`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable, symlinkAvailable } from '../../../__tests__/helpers/native-guards';
import { makeTpy, type TpySpec } from './helpers/make-tpy';
import { TropyOCRPipeline } from '../TropyOCRPipeline';
import { TropySync } from '../TropySync';
import { PrimarySourcesVectorStore } from '../../../core/vector-store/PrimarySourcesVectorStore';

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

// Même fournisseur local que TropySync.e2e.test.ts : de vrais vecteurs, sans réseau.
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

// MARK: - Deux fonds numérotés pareil

const OCR_TEXT = [
  'Mon cher ami, je vous écris au lendemain de la victoire du Front populaire.',
  'La semaine de quarante heures et les congés payés seront votés avant l’été, je vous le promets.',
  'Léon Blum, président du Conseil, aux militants de la fédération socialiste de la Seine.',
].join(' ');

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
let dirA: string;
let dirB: string;
let scans: string;
let ocrSpy: ReturnType<typeof vi.spyOn>;

const scan = (name: string) => path.join(scans, name);

/** Le fonds lié : l'item 10 a été passé à l'OCR, l'item 20 est transcrit dans Tropy. */
function specA(): TpySpec {
  return {
    projectId: 'projet-tropy-A',
    name: 'Grèves nantaises',
    items: [
      { id: 10, title: 'Lettre de Léon Blum', date: '1936-05-04', photos: [{ id: 11, path: scan('blum.jpg') }] },
      {
        id: 20,
        title: 'Lettre du commissaire central',
        notes: [{ text: NOTE_TEXT }],
        photos: [{ id: 21, path: scan('commissaire.jpg') }],
      },
    ],
  };
}

/**
 * Un autre dépôt, numéroté par Tropy de la même façon : item 10, item 20. Ses
 * photos 21 et 11 croisent celles de A — la photo 21 de B va sur l'item 10,
 * déjà pris par la source 20 de A : le conflit UNIQUE de la contre-vérification.
 */
function specB(): TpySpec {
  return {
    projectId: 'projet-tropy-B',
    name: 'Comité',
    items: [
      { id: 10, title: 'Rapport du préfet 1851', photos: [{ id: 21, path: scan('prefet.jpg') }] },
      { id: 20, title: 'Affiche de 1936', photos: [{ id: 11, path: scan('affiche.jpg') }] },
    ],
  };
}

const syncOptions = { performOCR: true, ocrLanguage: 'fra', forceReindex: false };

function brainPath(): string {
  return path.join(projectDir, '.cliodeck', 'brain.db');
}

/** Tout ce que la synchro peut toucher, ligne à ligne. */
function snapshot() {
  const db = new Database(brainPath(), { readonly: true });
  try {
    return {
      sources: db.prepare('SELECT * FROM tropy_sources ORDER BY tropy_id').all() as Array<
        Record<string, unknown>
      >,
      photos: db.prepare('SELECT * FROM tropy_photos ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM tropy_tags ORDER BY source_id, tag').all(),
      chunks: db
        .prepare('SELECT id, source_id, content FROM tropy_chunks ORDER BY source_id, chunk_index')
        .all() as Array<{ id: string; source_id: string; content: string }>,
      projects: db.prepare('SELECT * FROM tropy_projects ORDER BY last_sync').all() as Array<
        Record<string, unknown>
      >,
    };
  } finally {
    db.close();
  }
}

/** Ramène brain.db au schéma d'avant L06-3, comme sur les postes avant la mise à jour. */
function dropProjectUuidColumn(): void {
  const db = new Database(brainPath());
  try {
    const cols = db.prepare("PRAGMA table_info('tropy_projects')").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'project_uuid')) {
      db.exec('ALTER TABLE tropy_projects DROP COLUMN project_uuid');
    }
  } finally {
    db.close();
  }
}

/** Déplace le projet Tropy (Finder → glisser ailleurs) et rend son nouveau chemin. */
function moveProject(from: string, folder: string): string {
  const target = path.join(root, folder);
  fs.mkdirSync(target, { recursive: true });
  const to = path.join(target, path.basename(from));
  fs.renameSync(from, to);
  return to;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-binding-'));
  projectDir = path.join(root, 'projet-cliodeck');
  dirA = path.join(root, 'tropy-A');
  dirB = path.join(root, 'tropy-B');
  scans = path.join(root, 'scans');
  for (const d of [projectDir, dirA, dirB, scans]) fs.mkdirSync(d, { recursive: true });
  // `performOCROnItem` écarte les photos absentes du disque : il faut de vrais fichiers.
  for (const f of ['blum.jpg', 'commissaire.jpg', 'prefet.jpg', 'affiche.jpg']) {
    fs.writeFileSync(scan(f), 'jpeg factice');
  }

  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  embedCalls.texts = 0;
  ocrSpy = vi
    .spyOn(TropyOCRPipeline.prototype, 'performBatchOCR')
    .mockResolvedValue({ text: OCR_TEXT, confidence: 91, language: 'fra' });

  await tropyService.init(projectDir);
});

afterEach(async () => {
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Lie A et le synchronise : OCR de l'item 10, extraits des deux sources. */
async function linkAndSyncA(): Promise<string> {
  const tpyA = makeTpy(dirA, specA());
  expect((await tropyService.openProject(tpyA)).success).toBe(true);
  const first = await tropyService.sync(syncOptions);
  expect(first.success).toBe(true);
  expect(first.errors).toEqual([]);
  expect(ocrSpy).toHaveBeenCalledTimes(1);
  return tpyA;
}

// MARK: - Un autre projet Tropy

describe.skipIf(!sqliteAvailable)('un autre projet Tropy ne s’apparie plus au projet lié', () => {
  it('l’ouverture de B est refusée, nomme les deux projets, et la synchro suivante reste sur A', async () => {
    await linkAndSyncA();
    const before = snapshot();
    const tpyB = makeTpy(dirB, specB());

    const opened = await tropyService.openProject(tpyB);
    expect(opened.success).toBe(false);
    expect(opened.issue).toEqual({
      code: 'different-project',
      linkedName: 'Grèves nantaises',
      candidateName: 'Comité',
      sourceCount: 2,
    });

    // Le projet suivi n'a pas changé : la synchro automatique qui suivait
    // l'ouverture, ou un clic sur « Synchroniser », porte toujours sur A.
    const after = await tropyService.sync(syncOptions);
    expect(after.success).toBe(true);
    expect(after.projectName).toBe('Grèves nantaises');
    expect(after.skippedItems).toBe(2);

    const now = snapshot();
    expect(now.sources).toEqual(before.sources);
    expect(now.photos).toEqual(before.photos);
    expect(now.chunks).toEqual(before.chunks);
    expect(now.projects.map((p) => p.tpy_path)).toEqual([before.projects[0].tpy_path]);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
  });

  it('TropySync refuse B avant toute écriture : sources, photos, extraits et lien intacts', async () => {
    // La garde est dans sync() lui-même : bouton, ouverture et surveillance
    // passent tous par là, quel que soit le chemin qu'on lui donne.
    await linkAndSyncA();
    await tropyService.close();
    const before = snapshot();
    const tpyB = makeTpy(dirB, specB());

    const store = new PrimarySourcesVectorStore(projectDir);
    const tropySync = new TropySync();
    const result = await tropySync
      .sync(tpyB, store, { performOCR: false, ocrLanguage: 'fra' })
      .finally(async () => {
        await tropySync.dispose();
        store.close();
      });

    expect(result.success).toBe(false);
    expect(result.issues).toEqual([
      { code: 'different-project', linkedName: 'Grèves nantaises', candidateName: 'Comité', sourceCount: 2 },
    ]);
    expect(result.errors.join('\n')).not.toMatch(/UNIQUE/);
    expect(result.newItems + result.updatedItems).toBe(0);

    // Pas une ligne de changée, pas même la date de synchro du lien.
    expect(snapshot()).toEqual(before);
    const blum = before.sources.find((s) => s.tropy_id === 10);
    expect(blum?.title).toBe('Lettre de Léon Blum');
    expect(blum?.transcription).toBe(OCR_TEXT);
    expect(before.chunks.some((c) => c.content.includes('Front populaire'))).toBe(true);
  });
});

// MARK: - Le même projet, ailleurs

describe.skipIf(!sqliteAvailable)('le projet lié, déplacé ou d’avant la colonne, reste accepté', () => {
  it('A déplacé (même project_id, autre dossier) : synchro acceptée, chemin mis à jour, une seule ligne, OCR intact', async () => {
    const tpyA = await linkAndSyncA();
    const before = snapshot();
    const embeddedBefore = embedCalls.texts;
    const moved = moveProject(tpyA, 'Archives déplacées');

    expect((await tropyService.openProject(moved)).success).toBe(true);
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.skippedItems).toBe(2);

    const after = snapshot();
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0]).toMatchObject({ tpy_path: moved, project_uuid: 'projet-tropy-A' });
    expect(after.sources.map((s) => [s.id, s.transcription, s.transcription_source])).toEqual(
      before.sources.map((s) => [s.id, s.transcription, s.transcription_source])
    );
    expect(after.chunks).toEqual(before.chunks);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(embedCalls.texts).toBe(embeddedBefore);
  });

  it('deux synchros de suite conservent project_uuid (A5)', async () => {
    await linkAndSyncA();
    await tropyService.sync(syncOptions);

    const { projects } = snapshot();
    expect(projects).toHaveLength(1);
    expect(projects[0].project_uuid).toBe('projet-tropy-A');
  });

  it('ligne sans uuid, ancien chemin disparu : l’empreinte des photos reconnaît A déplacé', async () => {
    const tpyA = await linkAndSyncA();
    await tropyService.close();
    dropProjectUuidColumn();
    const moved = moveProject(tpyA, 'Disque externe');
    const before = snapshot();

    // L'ancien chemin n'existe plus : init ne peut rien compléter.
    await tropyService.init(projectDir);
    expect((await tropyService.openProject(moved)).success).toBe(true);
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);

    const after = snapshot();
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0]).toMatchObject({ tpy_path: moved, project_uuid: 'projet-tropy-A' });
    expect(after.chunks).toEqual(before.chunks);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
  });

  it('ligne sans uuid, ancien chemin disparu : une empreinte discordante est refusée', async () => {
    const tpyA = await linkAndSyncA();
    await tropyService.close();
    dropProjectUuidColumn();
    moveProject(tpyA, 'Corbeille');
    const before = snapshot();
    const tpyB = makeTpy(dirB, specB());

    await tropyService.init(projectDir);
    const opened = await tropyService.openProject(tpyB);
    expect(opened.success).toBe(false);
    expect(opened.issue).toMatchObject({ code: 'different-project', linkedName: 'Grèves nantaises' });

    const after = snapshot();
    expect(after.sources).toEqual(before.sources);
    expect(after.chunks).toEqual(before.chunks);
  });

  it.skipIf(!symlinkAvailable)('le même fichier par un autre chemin n’oblige pas à resynchroniser', async () => {
    // checkSyncNeeded comparait les chemins comme des chaînes : par un lien
    // (ou une casse différente sous macOS), A frais semblait toujours à refaire.
    const tpyA = await linkAndSyncA();
    const link = path.join(root, 'lien-vers-A');
    fs.symlinkSync(dirA, link);
    const viaLink = path.join(link, path.basename(tpyA));

    expect((await tropyService.openProject(viaLink)).success).toBe(true);
    expect(tropyService.checkSyncNeeded()).toBe(false);
  });
});

// MARK: - Migration d'une base d'avant la colonne

describe.skipIf(!sqliteAvailable)('migration : base d’avant project_uuid, lien en double', () => {
  it('uuid complété à l’ouverture, une seule ligne après la première synchro, sans réembarquer ni OCR', async () => {
    const tpyA = await linkAndSyncA();
    await tropyService.close();

    // Le cas réel (AnalyseDDF) : deux lignes pour le même .tpy, héritées de
    // l'ancien `saveTropyProject`, et pas de colonne project_uuid.
    dropProjectUuidColumn();
    const db = new Database(brainPath());
    try {
      db.prepare(
        'INSERT INTO tropy_projects (id, tpy_path, name, last_sync, auto_sync) VALUES (?, ?, ?, ?, ?)'
      ).run('doublon-ancien', tpyA, 'Grèves nantaises', '2026-08-01T00:00:00.000Z', 0);
    } finally {
      db.close();
    }
    const before = snapshot();
    expect(before.projects).toHaveLength(2);
    const embeddedBefore = embedCalls.texts;

    await tropyService.init(projectDir);
    // Complété depuis le .tpy, avant toute synchro.
    const atInit = snapshot().projects;
    expect(atInit[atInit.length - 1].project_uuid).toBe('projet-tropy-A');

    expect((await tropyService.openProject(tpyA)).success).toBe(true);
    const result = await tropyService.sync(syncOptions);
    expect(result.success).toBe(true);
    expect(result.newItems + result.updatedItems).toBe(0);

    const after = snapshot();
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0]).toMatchObject({ tpy_path: tpyA, project_uuid: 'projet-tropy-A' });
    expect(after.sources).toEqual(before.sources);
    expect(after.chunks).toEqual(before.chunks);
    expect(embedCalls.texts).toBe(embeddedBefore);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
  });
});
