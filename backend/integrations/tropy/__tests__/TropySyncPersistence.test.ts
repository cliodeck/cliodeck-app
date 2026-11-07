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
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TropySync } from '../TropySync';
import type { PrimarySourceItem } from '../TropyReader';

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
 * vaut '' : la passe a eu lieu après la migration et l'item n'avait pas de
 * note. Une base d'avant migration se simule par `notesText: undefined`.
 */
function storedSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'existing-uuid',
    tropyId: 305,
    title: '1980_01_08_141st_CoG_meeting_Minutes_FR',
    lastModified: ITEM_MODIFIED,
    indexedAt: '2026-07-27T11:49:11.170Z',
    notesText: '',
    ...overrides,
  };
}

function harness(options: {
  existing?: Record<string, unknown> | null;
  ocrText?: string;
  ocrConfidence?: number;
  /** Texte des notes Tropy de l'item (item, photos et sélections confondues). */
  notes?: string;
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
    })),
  };
  Object.assign(sync as unknown as Record<string, unknown>, { reader, ocrPipeline });

  const saveSource = vi.fn();
  const deleteChunks = vi.fn();
  const vectorStore = {
    getSourceByTropyId: () => options.existing ?? null,
    saveSource,
    deleteChunks,
  };

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
    ).processItem(makeItem(), vectorStore, {
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
