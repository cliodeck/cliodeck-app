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

/** Source telle qu'elle a été enregistrée par une passe précédente. */
function storedSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'existing-uuid',
    tropyId: 305,
    title: '1980_01_08_141st_CoG_meeting_Minutes_FR',
    lastModified: ITEM_MODIFIED,
    indexedAt: '2026-07-27T11:49:11.170Z',
    ...overrides,
  };
}

function harness(options: {
  existing?: Record<string, unknown> | null;
  ocrText?: string;
  ocrConfidence?: number;
}) {
  const sync = new TropySync();

  const reader = {
    extractItemNotesOnly: () => '',
    countItemNotes: () => ({ total: 0, itemNotes: 0, photoNotes: 0, selectionNotes: 0 }),
    extractItemText: () => '',
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
