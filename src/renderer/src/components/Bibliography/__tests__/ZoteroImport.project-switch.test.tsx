// @vitest-environment jsdom
/**
 * « Synchroniser avec Zotero » lancé dans A, et l'historien ouvre B avant la fin (S07-1-7, S07-1-0).
 *
 * Ouvrir un projet passe par l'onglet Projets : le panneau est démonté, mais la suite de
 * `handleSynchronize` continue. Elle ouvrait la boîte de A dans B, envoyait l'accord au main sans
 * dire pour quel projet, puis rechargeait la bibliographie de A dans le panneau de B et y
 * affichait son bilan. Rien de tout cela ne doit atteindre B.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ZoteroImport } from '../ZoteroImport';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const A = '/projets/A';
const B = '/projets/B';

const project = (path: string) =>
  ({ id: path, name: path, path, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() }) as never;

const confirmation = (deletedKeys: string[]) => ({ collectionKey: 'CA', collectionChange: null, deletedKeys });

const report = (deleted: Array<{ id: string; title: string; zoteroKey: string }>) => ({
  collectionKey: 'CA',
  collectionChange: null,
  added: [],
  modified: [],
  deleted,
  unchangedCount: 1,
  localOnlyCount: 0,
  renamedKeys: [],
  duplicates: [],
  warnings: [],
  confirmation: confirmation(deleted.map((d) => d.zoteroKey)),
});

const A2 = { id: 'Bravo_2022', title: 'Article A2', zoteroKey: 'A2' };
const A1 = { id: 'Alpha_2022', title: 'Article A1', zoteroKey: 'A1' };
const needsConfirmation = (deleted = [A2]) => ({ success: true, status: 'needs-confirmation', report: report(deleted) });
const appliedResult = () => ({
  success: true,
  status: 'applied',
  report: report([A2]),
  written: true,
  bibtexPath: `${A}/bibliography.bib`,
});

/** Une réponse du main qu'on rend quand on veut. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let synchronize: ReturnType<typeof vi.fn>;
let getConfig: ReturnType<typeof vi.fn>;
let loadWithMetadata: ReturnType<typeof vi.fn>;

async function mountIn(path: string) {
  useProjectStore.setState({ currentProject: project(path) } as never);
  const view = render(<ZoteroImport />);
  // La configuration du projet se lit au montage : la collection mémorisée revient.
  await act(async () => undefined);
  return view;
}

const clickSynchronize = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /zotero\.sync\.button/ }));
  });

/** Le démontage par l'onglet Projets, puis l'ouverture de B. */
const switchToB = () =>
  act(async () => {
    cleanup();
    useProjectStore.setState({ currentProject: project(B) } as never);
  });

const dialogs = () => useDialogStore.getState();

beforeEach(() => {
  useProjectStore.setState({ loadState: { kind: 'idle' } } as never);
  synchronize = vi.fn();
  getConfig = vi.fn(async () => ({ zotero: { collectionKey: 'CA' } }));
  loadWithMetadata = vi.fn(async () => undefined);
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero' })) },
    project: { getConfig },
    zotero: {
      listLibraries: vi.fn(async () => ({ success: true, libraries: [] })),
      listCollections: vi.fn(async () => ({ success: true, collections: [{ key: 'CA', name: 'Collection de A' }] })),
      synchronize,
    },
  };
  useBibliographyStore.setState({ loadBibliographyWithMetadata: loadWithMetadata } as never);
});

afterEach(() => {
  cleanup();
  while (dialogs().queue.length > 0) {
    if (dialogs().confirmOpen) dialogs().resolveConfirm(false);
    else dialogs().closeAlert();
  }
});

describe('la synchronisation de A ne finit pas dans B', () => {
  it('B ouvert pendant la phase 1 : ni boîte, ni second appel, ni rechargement, ni alerte', async () => {
    const first = deferred<unknown>();
    synchronize.mockReturnValueOnce(first.promise);
    await mountIn(A);
    await clickSynchronize();

    expect(synchronize).toHaveBeenCalledWith(
      expect.objectContaining({ collectionKey: 'CA', expectedProjectPath: A })
    );

    await switchToB();
    await act(async () => {
      first.resolve(needsConfirmation());
    });

    expect(dialogs().queue).toEqual([]);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('B ouvert pendant l’écriture confirmée : ni rechargement, ni bilan dans B', async () => {
    const second = deferred<unknown>();
    synchronize.mockResolvedValueOnce(needsConfirmation()).mockReturnValueOnce(second.promise);
    await mountIn(A);
    await clickSynchronize();
    expect(dialogs().confirmOpen).toBe(true);

    await act(async () => {
      dialogs().resolveConfirm(true);
    });
    // L'accord porte le projet et le rapport lus, pas un « oui » valable pour tout.
    expect(synchronize).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectionKey: 'CA', expectedProjectPath: A, confirmation: confirmation(['A2']) })
    );
    expect(synchronize.mock.calls[1]?.[0]).not.toHaveProperty('confirmed');

    await switchToB();
    await act(async () => {
      second.resolve(appliedResult());
    });

    expect(loadWithMetadata).not.toHaveBeenCalled();
    expect(dialogs().queue).toEqual([]);
  });

  it('encore dans A, le main refuse parce que le projet a changé : l’historien le lit', async () => {
    synchronize
      .mockResolvedValueOnce(needsConfirmation())
      .mockResolvedValueOnce({ success: false, error: 'project-changed' });
    await mountIn(A);
    await clickSynchronize();

    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(dialogs().alertMessage).toBe('zotero.sync.projectChanged');
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('un nouveau rapport après l’accord : nouvelle boîte, et l’accord suivant porte sur lui', async () => {
    synchronize
      .mockResolvedValueOnce(needsConfirmation([A2]))
      .mockResolvedValueOnce(needsConfirmation([A2, A1]))
      .mockResolvedValueOnce(appliedResult());
    await mountIn(A);
    await clickSynchronize();
    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(dialogs().confirmOpen).toBe(true);
    expect(dialogs().confirmMessage).toContain('Article A1');

    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(synchronize).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmation: confirmation(['A2', 'A1']) })
    );
    expect(loadWithMetadata).toHaveBeenCalledWith(`${A}/bibliography.bib`, A);
  });

  it('témoin : rien ne change de projet, la bibliographie est rechargée et le bilan s’affiche', async () => {
    synchronize.mockResolvedValueOnce(needsConfirmation()).mockResolvedValueOnce(appliedResult());
    await mountIn(A);
    await clickSynchronize();

    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(loadWithMetadata).toHaveBeenCalledWith(`${A}/bibliography.bib`, A);
    expect(dialogs().alertOpen).toBe(true);
  });

  it('témoin : remonté dans B, la liste des collections chargée pour A n’est pas proposée', async () => {
    await mountIn(A);
    await act(async () => {
      fireEvent.click(screen.getByTitle('zotero.import.loadCollectionsButton'));
    });
    expect(screen.getByRole('option', { name: 'Collection de A' })).toBeInTheDocument();

    await switchToB();
    getConfig.mockResolvedValue({ name: 'B' });
    await mountIn(B);

    expect(screen.queryByRole('option', { name: 'Collection de A' })).toBeNull();
  });
});

/**
 * Pendant l'ouverture de B, le main prend B avant que l'écran ne la montre : il initialise
 * encore ses services alors que `currentProject` est toujours A. Une lecture de A qui finit dans
 * cette fenêtre ouvrait sa boîte, qui restait ensuite par-dessus B.
 */
describe('B en cours d’ouverture quand la lecture de A finit', () => {
  /** L'onglet Projets démonte le panneau, puis l'ouverture de B commence. */
  const startOpeningB = () =>
    act(async () => {
      cleanup();
      useProjectStore.setState({ loadState: { kind: 'loading', path: B } } as never);
    });

  it('l’ouverture aboutit : aucune boîte, ni avant ni après, et aucun second appel', async () => {
    const first = deferred<unknown>();
    synchronize.mockReturnValueOnce(first.promise);
    await mountIn(A);
    await clickSynchronize();

    await startOpeningB();
    await act(async () => {
      first.resolve(needsConfirmation());
    });
    expect(dialogs().queue).toEqual([]);

    await act(async () => {
      useProjectStore.setState({
        currentProject: project(B),
        loadState: { kind: 'ready', path: B, loadedAt: '' },
      } as never);
    });

    expect(dialogs().queue).toEqual([]);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(loadWithMetadata).not.toHaveBeenCalled();
  });

  it('l’ouverture est refusée : la boîte de A s’ouvre alors dans A, et la synchronisation va au bout', async () => {
    const first = deferred<unknown>();
    synchronize.mockReturnValueOnce(first.promise).mockResolvedValueOnce(appliedResult());
    await mountIn(A);
    await clickSynchronize();

    await startOpeningB();
    await act(async () => {
      first.resolve(needsConfirmation());
    });
    expect(dialogs().queue).toEqual([]);

    // Un refus (document à garder, B illisible) rend l'état d'avant : A reste ouvert.
    await act(async () => {
      useProjectStore.setState({ loadState: { kind: 'ready', path: A, loadedAt: '' } } as never);
    });
    expect(dialogs().confirmOpen).toBe(true);

    await act(async () => {
      dialogs().resolveConfirm(true);
    });
    expect(synchronize).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedProjectPath: A, confirmation: confirmation(['A2']) })
    );
    expect(loadWithMetadata).toHaveBeenCalledWith(`${A}/bibliography.bib`, A);
  });
});

/**
 * Le panneau n'est pas toujours remonté à chaque projet : ce qu'il a chargé pour A ne doit pas
 * servir à B (S18-2-9). Une clé de collection de A, choisie ou relue en retard, partirait avec
 * la bibliothèque de B.
 */
describe('B sans remontage du panneau', () => {
  const openBInPlace = () =>
    act(async () => {
      useProjectStore.setState({ currentProject: project(B) } as never);
    });

  it('la liste des collections chargée pour A est vidée', async () => {
    await mountIn(A);
    await act(async () => {
      fireEvent.click(screen.getByTitle('zotero.import.loadCollectionsButton'));
    });
    expect(screen.getByRole('option', { name: 'Collection de A' })).toBeInTheDocument();

    getConfig.mockResolvedValue({ name: 'B' });
    await openBInPlace();

    expect(screen.queryByRole('option', { name: 'Collection de A' })).toBeNull();
  });

  it('la configuration de A répond après le passage à B : B ne reçoit pas la collection de A', async () => {
    const configA = deferred<unknown>();
    getConfig.mockReturnValueOnce(configA.promise).mockResolvedValue({ name: 'B' });
    await mountIn(A);

    await openBInPlace();
    await act(async () => {
      configA.resolve({ zotero: { collectionKey: 'CA' } });
    });

    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByRole('button', { name: /zotero\.sync\.button/ })).toBeDisabled();
  });

  it('témoin : un nouvel objet pour le même projet ne vide pas la liste', async () => {
    await mountIn(A);
    await act(async () => {
      fireEvent.click(screen.getByTitle('zotero.import.loadCollectionsButton'));
    });

    await act(async () => {
      useProjectStore.setState({ currentProject: project(A) } as never);
    });

    expect(screen.getByRole('option', { name: 'Collection de A' })).toBeInTheDocument();
  });
});
