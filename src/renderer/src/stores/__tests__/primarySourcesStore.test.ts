// @vitest-environment jsdom
/**
 * Le store des sources primaires ne garde rien d'un projet ClioDeck à l'autre (S18-1-30).
 *
 * Pour un projet sans Tropy, le main répond `{ success: true, info: null }`, et
 * `getProjectInfo` n'écrivait que si `info` existait : le nom, le `tpyPath`, la
 * liste et les filtres du projet A restaient en place dans le projet B. L'œil
 * envoyait alors ce `tpyPath` au main, qui l'adoptait comme projet Tropy de B,
 * et « Synchroniser » importait l'archive de A dans le brain.db de B.
 *
 * Vrai store ; seul le pont `window.electron.tropy` est simulé.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrimarySourcesStore, type PrimarySource } from '../primarySourcesStore';

const SOURCE_A: PrimarySource = {
  id: 'src-a',
  tropyId: 10,
  title: 'Rapport du préfet',
  collection: 'Carton 12',
  archive: 'AD Loire-Atlantique',
  tags: ['grève'],
  photoCount: 1,
  lastModified: '2026-11-01T00:00:00.000Z',
  indexedAt: '2026-11-01T00:00:00.000Z',
};

/** Le store tel que le laisse le projet A, lié à « Archives Danzig ». */
function storeOfProjectA(): void {
  usePrimarySourcesStore.setState({
    sources: [SOURCE_A],
    filteredSources: [SOURCE_A],
    selectedSourceId: 'src-a',
    tpyPath: '/archives/Danzig.tpy',
    projectInfo: {
      name: 'Archives Danzig',
      itemCount: 1,
      lastModified: '2026-11-01T00:00:00.000Z',
      isWatching: false,
      tpyPath: '/archives/Danzig.tpy',
    },
    statistics: {
      sourceCount: 1,
      chunkCount: 3,
      photoCount: 1,
      withTranscription: 1,
      withoutTranscription: 0,
      byArchive: { 'AD Loire-Atlantique': 1 },
      byCollection: { 'Carton 12': 1 },
      tags: ['grève'],
    },
    searchQuery: 'préfet',
    selectedTags: ['grève'],
    selectedArchive: 'AD Loire-Atlantique',
    selectedCollection: 'Carton 12',
  });
}

let tropy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  tropy = {
    getProjectInfo: vi.fn(async () => ({ success: true, info: null })),
    startWatching: vi.fn(async () => ({ success: false, error: 'No Tropy project linked to this project' })),
    onFileChanged: vi.fn(() => () => undefined),
  };
  (window as unknown as { electron: Record<string, unknown> }).electron = { tropy };
  storeOfProjectA();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('primarySourcesStore — un projet sans Tropy après le projet A', () => {
  it('getProjectInfo répond info:null : projet Tropy, chemin, liste, filtres et sélection de A disparaissent', async () => {
    await usePrimarySourcesStore.getState().getProjectInfo();

    const state = usePrimarySourcesStore.getState();
    expect(state.projectInfo).toBeNull();
    expect(state.tpyPath).toBeNull();
    expect(state.sources).toEqual([]);
    expect(state.filteredSources).toEqual([]);
    expect(state.statistics).toBeNull();
    expect(state.selectedSourceId).toBeNull();
    expect(state.searchQuery).toBe('');
    expect(state.selectedTags).toEqual([]);
    expect(state.selectedArchive).toBeNull();
    expect(state.selectedCollection).toBeNull();
  });

  it('une réponse en échec ne vaut pas « pas de projet Tropy » : rien n’est effacé', async () => {
    tropy.getProjectInfo.mockResolvedValue({ success: false, error: 'IPC indisponible' });
    await usePrimarySourcesStore.getState().getProjectInfo();

    expect(usePrimarySourcesStore.getState().projectInfo?.name).toBe('Archives Danzig');
  });
});

describe('primarySourcesStore — la synchro automatique', () => {
  it('n’envoie aucun chemin au main : c’est lui qui sait quel projet Tropy est lié', async () => {
    await usePrimarySourcesStore.getState().startWatching();

    expect(tropy.startWatching).toHaveBeenCalledTimes(1);
    expect(tropy.startWatching.mock.calls[0]).toEqual([]);
  });

  it('le main refuse : le panneau n’annonce pas une surveillance qui n’a pas lieu', async () => {
    await usePrimarySourcesStore.getState().startWatching();

    expect(usePrimarySourcesStore.getState().projectInfo?.isWatching).toBe(false);
    expect(tropy.onFileChanged).not.toHaveBeenCalled();
  });

  it('le main accepte : la surveillance est affichée', async () => {
    tropy.startWatching.mockResolvedValue({ success: true });
    await usePrimarySourcesStore.getState().startWatching();

    expect(usePrimarySourcesStore.getState().projectInfo?.isWatching).toBe(true);
  });
});

// MARK: - Écrire une transcription (L06-7)

describe('primarySourcesStore — provenance d’une transcription écrite', () => {
  beforeEach(() => {
    tropy.performBatchOCR = vi.fn(async () => ({ success: true, text: 'Texte reconnu par Tesseract', confidence: 88.5 }));
    tropy.updateTranscription = vi.fn(async () => ({ success: true }));
    tropy.importTranscription = vi.fn(async () => ({ success: true, text: 'Texte importé', format: 'plain-text' }));
    tropy.getAllSources = vi.fn(async () => ({ success: true, sources: [] }));
    tropy.getStatistics = vi.fn(async () => ({ success: true, statistics: null }));
  });

  it('un OCR manuel s’enregistre « tesseract », avec sa confiance (S15-1-36)', async () => {
    await usePrimarySourcesStore.getState().performOCR('src-a', ['/archives/p1.jpg'], 'fra');

    expect(tropy.updateTranscription).toHaveBeenCalledWith('src-a', 'Texte reconnu par Tesseract', 'tesseract', 88.5);
  });

  it.each([
    ['plain-text', 'imported'],
    ['alto', 'imported'],
    ['page-xml', 'transkribus'],
    ['transkribus', 'transkribus'],
  ])('un import au format %s s’enregistre « %s »', async (format, expected) => {
    tropy.importTranscription.mockResolvedValue({ success: true, text: 'Texte importé', format });

    await usePrimarySourcesStore.getState().importTranscription('src-a', '/transcriptions/p1.txt');

    const [sourceId, text, source, confidence] = tropy.updateTranscription.mock.calls[0];
    expect([sourceId, text, source]).toEqual(['src-a', 'Texte importé', expected]);
    // Un fichier importé n'a pas de confiance OCR.
    expect(confidence).toBeUndefined();
  });
});

describe('primarySourcesStore — l’échec d’une écriture se dit (S15-1-8, S08-1-30)', () => {
  beforeEach(() => {
    tropy.performBatchOCR = vi.fn(async () => ({ success: true, text: 'Texte reconnu', confidence: 70 }));
    tropy.importTranscription = vi.fn(async () => ({ success: true, text: 'Texte importé', format: 'alto' }));
    tropy.getAllSources = vi.fn(async () => ({ success: true, sources: [] }));
    tropy.getStatistics = vi.fn(async () => ({ success: true, statistics: null }));
  });

  it('import : l’écriture refusée par le main est un échec, pas « importée »', async () => {
    tropy.updateTranscription = vi.fn(async () => ({
      success: false,
      error: 'Source not found: src-a',
      code: 'source-not-found',
    }));

    const result = await usePrimarySourcesStore.getState().importTranscription('src-a', '/transcriptions/p1.xml');

    expect(result).toMatchObject({ success: false, code: 'source-not-found' });
  });

  it('import : écrite mais pas indexée, le résultat le dit', async () => {
    tropy.updateTranscription = vi.fn(async () => ({
      success: true,
      reindexError: 'connect ECONNREFUSED 127.0.0.1:11434',
      reindexCode: 'embedding-failed',
    }));

    const result = await usePrimarySourcesStore.getState().importTranscription('src-a', '/transcriptions/p1.xml');

    expect(result).toMatchObject({ success: true, notIndexed: 'embedding-failed' });
  });

  it('OCR manuel : écrit mais pas indexé, la carte l’apprend', async () => {
    tropy.getSourcePhotos = vi.fn(async () => ({ success: true, paths: ['/archives/p1.jpg'] }));
    tropy.updateTranscription = vi.fn(async () => ({
      success: true,
      reindexError: 'aucun fournisseur',
      reindexCode: 'no-embedding-provider',
    }));

    const result = await usePrimarySourcesStore.getState().performManualOCR('src-a');

    expect(result).toEqual({ success: true, notIndexed: 'no-embedding-provider' });
  });

  it('OCR manuel : l’écriture échoue, ce n’est pas « l’OCR a échoué »', async () => {
    tropy.getSourcePhotos = vi.fn(async () => ({ success: true, paths: ['/archives/p1.jpg'] }));
    tropy.updateTranscription = vi.fn(async () => ({ success: false, error: 'SQLITE_BUSY' }));

    expect(await usePrimarySourcesStore.getState().performManualOCR('src-a')).toEqual({
      success: false,
      error: 'not-saved',
    });
  });

  // J6 : une lecture ratée du .tpy n'est pas « aucune image trouvée (fichiers
  // déplacés ou manquants) » : l'historien irait chercher des fichiers qui
  // sont à leur place.
  it('OCR manuel : les photos de la source n’ont pas pu être lues dans Tropy, ce n’est pas « aucune image »', async () => {
    tropy.getSourcePhotos = vi.fn(async () => ({
      success: false,
      error: 'Tropy read failed in getItemPhotos (subject 10): database disk image is malformed',
    }));

    expect(await usePrimarySourcesStore.getState().performManualOCR('src-a')).toEqual({
      success: false,
      error: 'failed',
    });
    expect(tropy.performBatchOCR).not.toHaveBeenCalled();
  });

  it('OCR manuel : une source sans photo dans Tropy reste « aucune image »', async () => {
    tropy.getSourcePhotos = vi.fn(async () => ({ success: true, paths: [] }));

    expect(await usePrimarySourcesStore.getState().performManualOCR('src-a')).toEqual({
      success: false,
      error: 'no-photos',
    });
  });
});

describe('primarySourcesStore — après une écriture, compteurs et rapport relus (S18-2-6)', () => {
  beforeEach(() => {
    tropy.updateTranscription = vi.fn(async () => ({ success: true }));
    tropy.getAllSources = vi.fn(async () => ({ success: true, sources: [] }));
    tropy.getStatistics = vi.fn(async () => ({
      success: true,
      statistics: {
        sourceCount: 1,
        chunkCount: 4,
        photoCount: 1,
        withTranscription: 1,
        withoutTranscription: 0,
        byArchive: {},
        byCollection: {},
        tags: [],
      },
    }));
  });

  it('les compteurs « avec / sans transcription » sont relus, et la révision avance', async () => {
    usePrimarySourcesStore.setState({
      statistics: { ...usePrimarySourcesStore.getState().statistics!, withTranscription: 0, withoutTranscription: 1 },
    });
    const revision = usePrimarySourcesStore.getState().transcriptionRevision;

    await usePrimarySourcesStore.getState().updateTranscription('src-a', 'texte', 'manual');

    expect(usePrimarySourcesStore.getState().statistics).toMatchObject({ withTranscription: 1, withoutTranscription: 0 });
    expect(usePrimarySourcesStore.getState().transcriptionRevision).toBe(revision + 1);
  });

  it('une écriture refusée ne fait pas avancer la révision', async () => {
    tropy.updateTranscription.mockResolvedValue({ success: false, error: 'SQLITE_BUSY' });
    const revision = usePrimarySourcesStore.getState().transcriptionRevision;

    await usePrimarySourcesStore.getState().updateTranscription('src-a', 'texte', 'manual');

    expect(usePrimarySourcesStore.getState().transcriptionRevision).toBe(revision);
  });
});

describe('primarySourcesStore — ce que la synchro n’a pas pu indexer', () => {
  const NOT_INDEXED = { code: 'embedding-failed', sources: 3 };

  beforeEach(() => {
    tropy.onSyncProgress = vi.fn(() => () => undefined);
    tropy.getAllSources = vi.fn(async () => ({ success: true, sources: [] }));
    tropy.getStatistics = vi.fn(async () => ({ success: true, statistics: null }));
    tropy.getProjectInfo = vi.fn(async () => ({
      success: true,
      info: { name: 'Archives Danzig', itemCount: 1, lastModified: '', isWatching: false, tpyPath: '/a.tpy' },
    }));
    tropy.sync = vi.fn(async () => ({
      success: true,
      newItems: 0,
      updatedItems: 0,
      ocrPerformed: 0,
      transcriptionsWritten: 0,
      errors: [],
      issues: [NOT_INDEXED],
    }));
  });

  it('une synchro réussie rend aussi ses problèmes, et le panneau les garde jusqu’à la suivante', async () => {
    const outcome = await usePrimarySourcesStore.getState().syncTPY({ performOCR: false, ocrLanguage: 'fra' });

    expect(outcome.issues).toEqual([NOT_INDEXED]);
    expect(usePrimarySourcesStore.getState().syncIssues).toEqual([NOT_INDEXED]);

    tropy.sync.mockResolvedValue({ success: true, errors: [], issues: [] });
    await usePrimarySourcesStore.getState().syncTPY({ performOCR: false, ocrLanguage: 'fra' });
    expect(usePrimarySourcesStore.getState().syncIssues).toEqual([]);
  });

  it('un changement de projet pendant la synchro : son bilan ne s’affiche pas dans l’autre projet', async () => {
    let finish: (value: unknown) => void = () => undefined;
    tropy.sync.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const syncing = usePrimarySourcesStore.getState().syncTPY({ performOCR: false, ocrLanguage: 'fra' });
    // Attend que la synchro soit partie, pas un délai.
    await vi.waitFor(() => expect(tropy.sync).toHaveBeenCalled());

    usePrimarySourcesStore.getState().reset();
    finish({ success: true, errors: [], issues: [NOT_INDEXED] });
    await syncing;

    expect(usePrimarySourcesStore.getState().syncIssues).toEqual([]);
  });
});
