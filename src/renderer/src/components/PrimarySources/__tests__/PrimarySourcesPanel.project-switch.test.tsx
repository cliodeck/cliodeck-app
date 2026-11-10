// @vitest-environment jsdom
/**
 * Panneau Sources primaires : changer de projet ClioDeck repart de zéro (S18-1-30).
 *
 * Le panneau rechargeait l'état Tropy au changement de projet sans jamais le
 * vider : pour un projet sans Tropy, rien ne remplaçait le nom, la liste ni
 * les filtres du précédent. Deux exigences de plus, que ces tests fixent :
 * la remise à zéro précède le chargement (rien de A ne s'affiche pendant que B
 * se lit), et une lecture lancée pour A qui répond après le passage à B ne
 * réécrit rien.
 *
 * Vrais panneau, store et registre du projet (qui vide le store depuis L03-4) ;
 * le main est simulé par projet : chaque appel répond ce que le main servait au
 * moment où il l'a reçu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PrimarySourcesPanel } from '../PrimarySourcesPanel';
import { usePrimarySourcesStore } from '../../../stores/primarySourcesStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

type MainProject = 'A' | 'B';
type Channel = 'getProjectInfo' | 'getAllSources' | 'getStatistics';

const STATS_A = {
  sourceCount: 1,
  chunkCount: 3,
  photoCount: 1,
  withTranscription: 1,
  withoutTranscription: 0,
  byArchive: {},
  byCollection: { 'Carton 12': 1 },
  tags: [],
};
const STATS_EMPTY = { ...STATS_A, sourceCount: 0, chunkCount: 0, photoCount: 0, withTranscription: 0, byCollection: {} };

const MAIN: Record<MainProject, { info: unknown; sources: unknown[]; statistics: unknown }> = {
  A: {
    info: {
      name: 'Archives Danzig',
      itemCount: 1,
      lastModified: '2026-11-01T00:00:00.000Z',
      isWatching: false,
      tpyPath: '/archives/Danzig.tpy',
    },
    sources: [
      {
        id: 'src-a',
        tropyId: 10,
        title: 'Rapport du préfet',
        collection: 'Carton 12',
        lastModified: '2026-11-01T00:00:00.000Z',
        indexedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    statistics: STATS_A,
  },
  B: { info: null, sources: [], statistics: STATS_EMPTY },
};

/** Ce que sert le main pour chaque projet ; un test peut lier B à Tropy en cours de route. */
let main: typeof MAIN;

const project = (id: MainProject) => ({
  id,
  name: `Projet ${id}`,
  path: `/projets/${id}`,
  type: 'article' as const,
  createdAt: new Date(),
  lastOpenedAt: new Date(),
});

let served: MainProject;
let hold: { channel: Channel; project: MainProject } | null;
const held = new Map<Channel, () => void>();
const calls: Array<{ channel: Channel; project: MainProject }> = [];

/** La réponse du main pour le projet qu'il sert à cet instant ; retenue si le test le demande. */
function answer(channel: Channel, value: () => unknown): Promise<unknown> {
  const response = value();
  calls.push({ channel, project: served });
  if (hold && hold.channel === channel && hold.project === served) {
    hold = null;
    return new Promise((resolve) => held.set(channel, () => resolve(response)));
  }
  return Promise.resolve(response);
}

const answered = (channel: Channel, p: MainProject, since = 0) =>
  calls.slice(since).some((call) => call.channel === channel && call.project === p);

const INITIAL_STORE = usePrimarySourcesStore.getState();

/** Le projet à l'écran, comme le pose `projectStore` : le registre d'abord, puis le store. */
function show(p: MainProject | null): void {
  projectLifecycle.enter(p ? project(p).path : null);
  useProjectStore.setState({ currentProject: p ? project(p) : null });
}

/** Le main bascule sur B, puis le renderer, comme `project:load` puis `projectStore`. */
async function switchTo(p: MainProject): Promise<void> {
  projectLifecycle.beginTransition();
  served = p;
  await act(async () => show(p));
}

beforeEach(() => {
  served = 'A';
  main = { ...MAIN };
  hold = null;
  held.clear();
  calls.length = 0;
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.tropy = {
    getProjectInfo: vi.fn(() => answer('getProjectInfo', () => ({ success: true, info: main[served].info }))),
    getAllSources: vi.fn(() => answer('getAllSources', () => ({ success: true, sources: main[served].sources }))),
    getStatistics: vi.fn(() => answer('getStatistics', () => ({ success: true, statistics: main[served].statistics }))),
    getOCRLanguages: vi.fn(async () => ({ success: true, languages: [] })),
    onSyncProgress: vi.fn(() => () => undefined),
  };
  show('A');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  show(null);
  usePrimarySourcesStore.setState(INITIAL_STORE, true);
});

describe('PrimarySourcesPanel — changement de projet ClioDeck', () => {
  it('le projet B, sans Tropy, n’affiche rien de A, et sans attendre sa lecture', async () => {
    render(<PrimarySourcesPanel />);
    expect(await screen.findByText('Archives Danzig')).toBeInTheDocument();

    // La lecture de B reste en vol : ce qui s'affiche vient de la remise à zéro seule.
    hold = { channel: 'getProjectInfo', project: 'B' };
    await switchTo('B');
    await waitFor(() => expect(held.has('getProjectInfo')).toBe(true));

    expect(screen.queryByText('Archives Danzig')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Synchronize')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Enable auto-sync')).not.toBeInTheDocument();
    expect(usePrimarySourcesStore.getState().tpyPath).toBeNull();

    await act(async () => held.get('getProjectInfo')?.());
    expect(screen.getByText('No Tropy Project')).toBeInTheDocument();
  });

  it.each<Channel>(['getProjectInfo', 'getAllSources', 'getStatistics'])(
    'une lecture %s lancée pour A, qui répond après le passage à B, ne réécrit rien',
    async (channel) => {
      hold = { channel, project: 'A' };
      render(<PrimarySourcesPanel />);
      await waitFor(() => expect(held.has(channel)).toBe(true));

      await switchTo('B');
      await waitFor(() => expect(answered('getStatistics', 'B')).toBe(true));
      await act(async () => undefined);

      // La réponse de A arrive en dernier.
      await act(async () => held.get(channel)?.());

      const state = usePrimarySourcesStore.getState();
      expect(state.projectInfo).toBeNull();
      expect(state.tpyPath).toBeNull();
      expect(state.sources).toEqual([]);
      expect(state.statistics?.withTranscription ?? 0).toBe(0);
      expect(screen.queryByText('Archives Danzig')).not.toBeInTheDocument();
      // Le filtre de collection se nourrit de la liste : celle de A n'y est pas.
      expect(screen.queryByRole('option', { name: 'Carton 12' })).not.toBeInTheDocument();
      expect(screen.queryByTitle('Synchronize')).not.toBeInTheDocument();
    }
  );

  it('revenir au projet A : son projet Tropy et ses sources réapparaissent', async () => {
    render(<PrimarySourcesPanel />);
    expect(await screen.findByText('Archives Danzig')).toBeInTheDocument();
    await switchTo('B');
    await waitFor(() => expect(screen.getByText('No Tropy Project')).toBeInTheDocument());

    await switchTo('A');
    expect(await screen.findByText('Archives Danzig')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Carton 12' })).toBeInTheDocument();
    expect(screen.getByTitle('Synchronize')).toBeInTheDocument();
  });

  it('quitter l’onglet et y revenir dans le même projet garde la recherche et le filtre', async () => {
    const first = render(<PrimarySourcesPanel />);
    expect(await screen.findByRole('option', { name: 'Carton 12' })).toBeInTheDocument();
    act(() => {
      usePrimarySourcesStore.getState().searchSources('préfet');
      usePrimarySourcesStore.getState().setCollectionFilter('Carton 12');
    });
    first.unmount();

    const since = calls.length;
    render(<PrimarySourcesPanel />);
    await waitFor(() => expect(answered('getStatistics', 'A', since)).toBe(true));
    expect(await screen.findByText('Archives Danzig')).toBeInTheDocument();
    expect(usePrimarySourcesStore.getState().searchQuery).toBe('préfet');
    expect(usePrimarySourcesStore.getState().selectedCollection).toBe('Carton 12');
  });

  it('un projet lié à Tropy en cours de session : quitter l’onglet et y revenir garde aussi la recherche et le filtre', async () => {
    // B s'ouvre sans Tropy : la lecture de son projet Tropy répond info:null.
    served = 'B';
    show('B');
    const first = render(<PrimarySourcesPanel />);
    expect(await screen.findByText('No Tropy Project')).toBeInTheDocument();

    // L'historien y ouvre un projet Tropy, par le bouton du panneau.
    const electron = (window as unknown as { electron: Record<string, Record<string, unknown>> }).electron;
    electron.dialog = { openFile: vi.fn(async () => ({ canceled: false, filePaths: ['/archives/Greve.tpy'] })) };
    electron.tropy.openProject = vi.fn(async () => {
      main.B = {
        ...MAIN.A,
        info: { ...(MAIN.A.info as object), name: 'Comité de grève', tpyPath: '/archives/Greve.tpy' },
      };
      return { success: true, projectName: 'Comité de grève', itemCount: 1 };
    });
    electron.tropy.sync = vi.fn(async () => ({ success: true, newItems: 1, errors: [] }));
    fireEvent.click(screen.getByTitle('Open Tropy Project'));
    expect(await screen.findByRole('option', { name: 'Carton 12' })).toBeInTheDocument();
    await waitFor(() => expect(usePrimarySourcesStore.getState().isSyncing).toBe(false));

    fireEvent.change(screen.getByPlaceholderText('Search sources...'), { target: { value: 'préfet' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by collection' }), {
      target: { value: 'Carton 12' },
    });
    first.unmount();

    const since = calls.length;
    render(<PrimarySourcesPanel />);
    await waitFor(() => expect(answered('getStatistics', 'B', since)).toBe(true));
    expect(await screen.findByText('Comité de grève')).toBeInTheDocument();
    expect(usePrimarySourcesStore.getState().searchQuery).toBe('préfet');
    expect(usePrimarySourcesStore.getState().selectedCollection).toBe('Carton 12');
  });
});
