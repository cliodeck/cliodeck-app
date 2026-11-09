/**
 * Persistance des transcriptions pendant la synchronisation Tropy.
 *
 * Ce chemin n'avait aucun test, et il a coûté un corpus entier : `processItem`
 * décidait d'écrire en comparant la date stockée de la source à la mtime du
 * fichier .tpy — une valeur GLOBALE, identique pour les 221 items d'un projet.
 * Tant que Tropy ne réécrivait pas le projet, aucune source n'était jamais
 * « modifiée », donc jamais sauvegardée : l'OCR tournait des heures et son
 * résultat était jeté, sans le moindre message.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TropySync } from '../TropySync';
import type { PrimarySourceItem } from '../TropyReader';
import { PrimarySourcesVectorStore } from '../../../core/vector-store/PrimarySourcesVectorStore';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';

// mtime du .tpy : une seule valeur pour TOUT le projet
const TPY_MTIME = new Date('2026-05-06T13:13:33.499Z');
const ITEM_MODIFIED = '2026-05-06T13:13:22.394Z';

// `performOCROnItem` écarte les photos absentes du disque : il faut un
// vrai fichier, `fs` n'étant pas espionnable en ESM.
const PHOTO = path.join(os.tmpdir(), 'cliodeck-tropy-sync-test.pdf');
beforeAll(() => {
  fs.writeFileSync(PHOTO, 'fake');
});

const OCR_TEXT = 'PROCES-VERBAL DE LA 141e REUNION DU COMITE. '.repeat(20);

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 305,
    title: '1980_01_08_141st_CoG_meeting_Minutes_FR',
    template: 'generic',
    modified: ITEM_MODIFIED,
    tags: [],
    notes: [],
    photos: [{ id: 1, path: PHOTO, filename: 'x.pdf', notes: [], selections: [] }],
    ...overrides,
  };
}

/**
 * Source telle qu'elle a été enregistrée par une passe précédente. `notesText`
 * vaut '' et `longestNoteLength` 0 : la passe a eu lieu après les migrations
 * et l'item n'avait pas de note. Une base d'avant migration se simule par
 * `notesText: undefined` (ou `longestNoteLength: undefined`).
 */
function storedSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'existing-uuid',
    tropyId: 305,
    title: '1980_01_08_141st_CoG_meeting_Minutes_FR',
    lastModified: ITEM_MODIFIED,
    indexedAt: '2026-07-27T11:49:11.170Z',
    notesText: '',
    longestNoteLength: 0,
    ...overrides,
  };
}

function harness(options: {
  existing?: Record<string, unknown> | null;
  ocrText?: string;
  ocrConfidence?: number;
  /** Pages que le pipeline dit avoir passées à la reconnaissance. */
  ocrPages?: number;
  /**
   * Texte des notes Tropy de l'item (item, photos et sélections confondues),
   * rendu par le lecteur simulé et porté par l'item comme une seule note : la
   * règle des notes-transcriptions lit la plus longue note sur l'item (G1).
   */
  notes?: string;
  /** Un vrai magasin à la place de la doublure : ce qu'il a écrit, la passe suivante le relit. */
  store?: PrimarySourcesVectorStore;
  item?: Record<string, unknown>;
}) {
  const sync = new TropySync();

  const notes = options.notes ?? '';
  const reader = {
    extractItemNotesOnly: () => notes,
    countItemNotes: () => {
      const n = notes ? 1 : 0;
      return { total: n, itemNotes: 0, photoNotes: 0, selectionNotes: n };
    },
    // Comme le vrai lecteur : le titre, puis les notes.
    extractItemText: () => ['1980_01_08_141st_CoG_meeting_Minutes_FR', notes].filter(Boolean).join('\n\n'),
    getLastModifiedTime: () => TPY_MTIME,
  };
  const ocrPipeline = {
    performBatchOCR: vi.fn(async () => ({
      text: options.ocrText ?? OCR_TEXT,
      confidence: options.ocrConfidence ?? 89.9,
      language: 'fra',
      pageCount: options.ocrPages ?? 1,
    })),
  };
  Object.assign(sync as unknown as Record<string, unknown>, { reader, ocrPipeline });

  const saveSource = vi.fn();
  const deleteChunks = vi.fn();
  const vectorStore = options.store ?? {
    getSourceByTropyId: () => options.existing ?? null,
    saveSource,
    deleteChunks,
    transaction: <T>(fn: () => T): T => fn(),
  };

  const item = () => makeItem({ notes: notes ? [{ id: 1, html: notes, text: notes }] : [], ...options.item });
  const run = (opts: Record<string, unknown> = {}) =>
    (
      sync as unknown as {
        processItem: (
          i: unknown,
          vs: unknown,
          o: unknown
        ) => Promise<{
          isNew: boolean;
          isUpdated: boolean;
          ocrCount: number;
          transcriptionWritten: boolean;
        }>;
      }
    ).processItem(item(), vectorStore, {
      performOCR: true,
      ocrLanguage: 'fra',
      forceReindex: false,
      ...opts,
    });

  const saved = (): PrimarySourceItem | undefined => saveSource.mock.calls[0]?.[0];

  return { run, saveSource, deleteChunks, ocrPipeline, saved };
}

describe('TropySync — persistance des transcriptions', () => {
  it("écrit la transcription même quand le .tpy n'a pas bougé", async () => {
    // Le cas qui a fait perdre le corpus : la source existe, sa date est
    // inchangée, forceReindex est décoché.
    const h = harness({ existing: storedSource() });

    const result = await h.run();

    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledTimes(1);
    expect(h.saveSource).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcription).toContain('PROCES-VERBAL');
    expect(h.saved()?.transcriptionSource).toBe('tesseract');
    expect(result.transcriptionWritten).toBe(true);
  });

  it('ne repasse pas à la reconnaissance une source déjà transcrite', async () => {
    const h = harness({
      existing: storedSource({
        transcription: 'texte déjà acquis',
        transcriptionSource: 'tesseract',
        ocrConfidence: 91,
      }),
    });

    await h.run();

    // C'est ce que promettait la case « ignorer les transcriptions
    // existantes » : sans elle, l'OCR repartait de zéro à chaque passe.
    expect(h.ocrPipeline.performBatchOCR).not.toHaveBeenCalled();
    expect(h.saveSource).not.toHaveBeenCalled();
  });

  it('relance la reconnaissance quand forceReindex est demandé', async () => {
    const h = harness({
      existing: storedSource({ transcription: 'ancien texte', transcriptionSource: 'tesseract' }),
    });

    await h.run({ forceReindex: true });

    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcription).toContain('PROCES-VERBAL');
    // Les chunks appartiennent au texte remplacé : les garder laisserait le
    // RAG répondre sur l'ancienne transcription.
    expect(h.deleteChunks).toHaveBeenCalledWith('existing-uuid');
  });

  it("n'écrase pas une transcription acquise quand l'OCR ne donne rien", async () => {
    // Sous les seuils de performOCROnItem (50 caractères / 30 % de confiance)
    const h = harness({
      existing: storedSource({
        transcription: 'texte précieux',
        transcriptionSource: 'transkribus',
      }),
      ocrText: 'illisible',
      ocrConfidence: 12,
    });

    await h.run({ forceReindex: true });

    expect(h.saveSource).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcription).toBe('texte précieux');
    expect(h.saved()?.transcriptionSource).toBe('transkribus');
    expect(h.deleteChunks).not.toHaveBeenCalled();
  });

  it('date la source par item, et non par fichier .tpy', async () => {
    const h = harness({ existing: null });

    await h.run();

    expect(h.saved()?.lastModified.toISOString()).toBe(
      new Date(ITEM_MODIFIED).toISOString()
    );
    expect(h.saved()?.lastModified.toISOString()).not.toBe(TPY_MTIME.toISOString());
  });

  // L06-11 (S08-2-8) : Tropy crée une photo par page de PDF, toutes sur le
  // même fichier. Le bilan comptait les fichiers dédoublonnés : 1 pour 120
  // pages reconnues.
  it('un PDF de 120 pages compte 120 pages passées à la reconnaissance', async () => {
    const pages = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, path: PHOTO, filename: 'x.pdf', notes: [], selections: [] }));
    const h = harness({ existing: null, ocrPages: 120, item: { photos: pages } });

    const result = await h.run();

    // Le fichier passe une fois à l'OCR ; ses pages comptent chacune.
    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledWith([PHOTO], { language: 'fra' });
    expect(result.ocrCount).toBe(120);
  });

  it('ne compte comme « OCR effectué » que ce qui a été écrit', async () => {
    const h = harness({
      existing: storedSource({ transcription: 'déjà là', transcriptionSource: 'tesseract' }),
    });

    const result = await h.run();

    expect(result.ocrCount).toBe(0);
    expect(result.transcriptionWritten).toBe(false);
  });
});

// MARK: - Notes Tropy (L06-2, S08-1-1, décision Q26)

const OCR_ACQUIRED = 'Rapport du commissaire spécial sur la réunion du 14 mars. '.repeat(28);
const SHORT_NOTE = 'Voir aussi carton 12';
// 500 caractères ou plus : une transcription faite à la main dans Tropy.
const LONG_NOTE = 'Transcription manuelle de la lettre, ligne à ligne. '.repeat(12).trim();

describe('TropySync — une note Tropy ne remplace pas une transcription', () => {
  it('une note ajoutée à une source OCRisée garde la transcription et va dans notesText', async () => {
    expect(OCR_ACQUIRED.length).toBeGreaterThan(1600);
    const h = harness({
      existing: storedSource({
        transcription: OCR_ACQUIRED,
        transcriptionSource: 'tesseract',
        ocrConfidence: 91,
      }),
      notes: SHORT_NOTE,
    });

    // Synchro automatique : pas d'OCR demandé.
    const result = await h.run({ performOCR: false });

    expect(h.saveSource).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcription).toBe(OCR_ACQUIRED);
    expect(h.saved()?.transcriptionSource).toBe('tesseract');
    expect(h.saved()?.ocrConfidence).toBe(91);
    expect(h.saved()?.notesText).toBe(SHORT_NOTE);
    // La note doit entrer dans les extraits : ceux d'avant ne la contiennent pas.
    expect(h.deleteChunks).toHaveBeenCalledWith('existing-uuid');
    expect(result.isUpdated).toBe(true);
  });

  it("une note de photo ne remplace pas une transcription faite par l'OCR de la fiche (manual)", async () => {
    const h = harness({
      existing: storedSource({ transcription: OCR_ACQUIRED, transcriptionSource: 'manual' }),
      notes: 'à revoir',
    });

    await h.run({ performOCR: false });

    expect(h.saved()?.transcription).toBe(OCR_ACQUIRED);
    expect(h.saved()?.transcriptionSource).toBe('manual');
    expect(h.saved()?.notesText).toBe('à revoir');
  });

  it("« Relancer l'OCR » passe outre une note de sélection sur une source OCRisée", async () => {
    const h = harness({
      existing: storedSource({
        transcription: OCR_ACQUIRED,
        transcriptionSource: 'tesseract',
        notesText: SHORT_NOTE,
        longestNoteLength: SHORT_NOTE.length,
      }),
      notes: SHORT_NOTE,
    });

    await h.run({ forceReindex: true });

    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcription).toContain('PROCES-VERBAL');
    expect(h.saved()?.transcriptionSource).toBe('tesseract');
    expect(h.saved()?.notesText).toBe(SHORT_NOTE);
  });

  it("« Relancer l'OCR » passe outre une note-transcription de 500 caractères ou plus", async () => {
    const h = harness({
      existing: storedSource({
        transcription: `Titre\n\n${LONG_NOTE}`,
        transcriptionSource: 'tropy-notes',
        notesText: LONG_NOTE,
        longestNoteLength: LONG_NOTE.length,
      }),
      notes: LONG_NOTE,
    });

    await h.run({ forceReindex: true });

    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcriptionSource).toBe('tesseract');
    // La note n'est pas perdue : elle reste à côté du corps.
    expect(h.saved()?.notesText).toBe(LONG_NOTE);
    expect(h.deleteChunks).toHaveBeenCalledWith('existing-uuid');
  });

  it("une note de moins de 500 caractères est un commentaire : l'OCR passe", async () => {
    const h = harness({ existing: null, notes: SHORT_NOTE });

    await h.run();

    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcriptionSource).toBe('tesseract');
    expect(h.saved()?.notesText).toBe(SHORT_NOTE);
  });

  it("une note de 500 caractères ou plus est une transcription : pas d'OCR sans « Relancer l'OCR »", async () => {
    const h = harness({ existing: null, notes: LONG_NOTE });

    await h.run();

    expect(h.ocrPipeline.performBatchOCR).not.toHaveBeenCalled();
    expect(h.saved()?.transcriptionSource).toBe('tropy-notes');
    expect(h.saved()?.transcription).toContain(LONG_NOTE);
  });

  it('une source tropy-notes dont la note courte attendait l’OCR y passe', async () => {
    // Synchronisée sans OCR, la note courte tenait lieu de texte ; la passe
    // avec OCR ne doit pas la prendre pour une transcription.
    const h = harness({
      existing: storedSource({
        transcription: `Titre\n\n${SHORT_NOTE}`,
        transcriptionSource: 'tropy-notes',
        notesText: SHORT_NOTE,
        longestNoteLength: SHORT_NOTE.length,
      }),
      notes: SHORT_NOTE,
    });

    await h.run();

    expect(h.ocrPipeline.performBatchOCR).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcriptionSource).toBe('tesseract');
  });

  it("une source tropy-notes dont les notes ont disparu de Tropy perd sa transcription", async () => {
    const h = harness({
      existing: storedSource({
        transcription: `Titre\n\n${LONG_NOTE}`,
        transcriptionSource: 'tropy-notes',
        notesText: LONG_NOTE,
        longestNoteLength: LONG_NOTE.length,
      }),
      notes: '',
    });

    await h.run({ performOCR: false });

    expect(h.saveSource).toHaveBeenCalledTimes(1);
    expect(h.saved()?.transcription).toBeUndefined();
    expect(h.saved()?.transcriptionSource).toBeUndefined();
    expect(h.saved()?.notesText).toBe('');
    expect(h.deleteChunks).toHaveBeenCalledWith('existing-uuid');
  });

  it('une base d’avant migration (notesText absent) s’initialise sans réembarquer', async () => {
    const h = harness({
      existing: storedSource({
        transcription: `1980_01_08_141st_CoG_meeting_Minutes_FR\n\n${LONG_NOTE}`,
        transcriptionSource: 'tropy-notes',
        notesText: undefined,
        longestNoteLength: undefined,
      }),
      notes: LONG_NOTE,
    });

    const result = await h.run({ performOCR: false });

    expect(h.saved()?.notesText).toBe(LONG_NOTE);
    expect(h.deleteChunks).not.toHaveBeenCalled();
    expect(result.isUpdated).toBe(false);
  });

  it('un titre modifié dans Tropy invalide les extraits, qui le portent en en-tête', async () => {
    const h = harness({
      existing: storedSource({
        title: 'Ancien titre',
        transcription: OCR_ACQUIRED,
        transcriptionSource: 'tesseract',
      }),
    });

    const result = await h.run({ performOCR: false });

    expect(h.saved()?.title).toBe('1980_01_08_141st_CoG_meeting_Minutes_FR');
    expect(h.deleteChunks).toHaveBeenCalledWith('existing-uuid');
    expect(result.isUpdated).toBe(true);
  });
});

// MARK: - Tout ou rien (L06-5, S02-1-10)

// Ici, un vrai magasin : la question est ce que la passe suivante relit après
// un échec, et une doublure ne garde rien. Lecteur et OCR restent simulés.
describe.skipIf(!sqliteAvailable)('TropySync — une source s’écrit tout ou rien (L06-5)', () => {
  const NEW_NOTE = `${LONG_NOTE} Pièces jointes par la fusion des deux items.`;
  const TITLE = '1980_01_08_141st_CoG_meeting_Minutes_FR';
  // L'item tel que Tropy le rend après la fusion : notes nouvelles, tag
  // nouveau, date `modified` avancée.
  const MERGED = { modified: '2026-06-01T08:00:00.000Z', tags: ['fusion'] };
  let tmp = '';
  let store: PrimarySourcesVectorStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  /** Source 'tropy-notes' déjà synchronisée, avec un extrait de son texte. */
  function openStore(): { store: PrimarySourcesVectorStore; db: Database.Database } {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-tout-ou-rien-'));
    store = new PrimarySourcesVectorStore(tmp);
    store.saveSource({
      id: 'existing-uuid',
      tropyId: 305,
      title: TITLE,
      tags: ['ancien'],
      photos: [{ id: 1, path: PHOTO, filename: 'x.pdf', hasTranscription: false, notes: [] }],
      transcription: `${TITLE}\n\n${LONG_NOTE}`,
      transcriptionSource: 'tropy-notes',
      notesText: LONG_NOTE,
      lastModified: new Date(ITEM_MODIFIED),
      metadata: {},
    });
    store.saveChunk(
      {
        id: 'chunk-ancien',
        sourceId: 'existing-uuid',
        content: LONG_NOTE,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: LONG_NOTE.length,
      },
      Float32Array.from(new Array(768).fill(0.01))
    );
    const db = (store as unknown as { db: Database.Database }).db;
    return { store, db };
  }

  function expectUntouched(s: PrimarySourcesVectorStore): void {
    const source = s.getSource('existing-uuid');
    expect(source?.transcription).toBe(`${TITLE}\n\n${LONG_NOTE}`);
    expect(source?.notesText).toBe(LONG_NOTE);
    expect(source?.lastModified).toBe(ITEM_MODIFIED);
    expect(s.getSourceTags('existing-uuid')).toEqual(['ancien']);
    expect(s.getChunks('existing-uuid').map((c) => c.id)).toEqual(['chunk-ancien']);
  }

  it('saveSource lève alors que la transcription a changé : rien d’écrit, la passe suivante voit encore le changement', async () => {
    const { store: s, db } = openStore();
    const deleteChunks = vi.spyOn(s, 'deleteChunks');
    db.exec(`
      CREATE TRIGGER refuse_tags BEFORE INSERT ON tropy_tags
      BEGIN SELECT RAISE(ABORT, 'écriture des tags refusée'); END;
    `);
    const h = harness({ store: s, item: MERGED, notes: NEW_NOTE });

    await expect(h.run({ performOCR: false })).rejects.toThrow(/tags refusée/);
    expect(deleteChunks).not.toHaveBeenCalled();
    expectUntouched(s);

    // L'erreur passée, la même synchro doit retrouver le travail à faire. La
    // ligne à moitié écrite le cachait : même texte, même date, rien à faire,
    // et le RAG répondait pour de bon sur les extraits d'avant.
    db.exec('DROP TRIGGER refuse_tags');
    const result = await h.run({ performOCR: false });

    expect(result.isUpdated).toBe(true);
    expect(deleteChunks).toHaveBeenCalledWith('existing-uuid');
    expect(s.getChunks('existing-uuid')).toEqual([]);
    expect(s.getSource('existing-uuid')?.transcription).toBe(`${TITLE}\n\n${NEW_NOTE}`);
    expect(s.getSourceTags('existing-uuid')).toEqual(['fusion']);
  });

  it('l’invalidation des extraits échoue : la nouvelle ligne n’est pas gardée sans elle', async () => {
    const { store: s, db } = openStore();
    db.exec(`
      CREATE TRIGGER refuse_suppression BEFORE DELETE ON tropy_chunks
      BEGIN SELECT RAISE(ABORT, 'suppression des extraits refusée'); END;
    `);
    const h = harness({ store: s, item: MERGED, notes: NEW_NOTE });

    await expect(h.run({ performOCR: false })).rejects.toThrow(/extraits refusée/);
    expectUntouched(s);

    db.exec('DROP TRIGGER refuse_suppression');
    await h.run({ performOCR: false });

    expect(s.getChunks('existing-uuid')).toEqual([]);
    expect(s.getSource('existing-uuid')?.transcription).toBe(`${TITLE}\n\n${NEW_NOTE}`);
  });
});
