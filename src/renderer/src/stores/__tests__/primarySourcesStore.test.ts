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
