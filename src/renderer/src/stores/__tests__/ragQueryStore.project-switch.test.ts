// @vitest-environment jsdom
/**
 * La sélection de documents et de collections du chat appartient au projet (S15-1-10).
 *
 * Elle n'était vidée qu'au lancement : dans le projet B, la recherche filtrait sur des identifiants
 * du brain.db de A, ne trouvait rien, et le manuscrit était écarté pour motif « portée ». Les listes
 * proposées par le panneau étaient aussi celles de A, et une liste demandée dans A, arrivée après la
 * bascule, s'inscrivait dans B.
 *
 * Vrais store et registre ; seul le pont `window.electron` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRAGQueryStore, type AvailableDocument } from '../ragQueryStore';
import { projectLifecycle } from '../../lifecycle/projectLifecycle';

const DOC_A: AvailableDocument = { id: 'doc-a', ids: ['doc-a'], title: 'Le préfet et la grève' };

let getAll: ReturnType<typeof vi.fn>;
let getCollections: ReturnType<typeof vi.fn>;
let originalElectron: unknown;

/** Une réponse retenue jusqu'à ce que le test la relâche. */
function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function switchTo(path: string | null): void {
  projectLifecycle.beginTransition();
  projectLifecycle.enter(path);
}

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  getAll = vi.fn(async () => ({ success: true, documents: [] }));
  getCollections = vi.fn(async () => ({ success: true, collections: [] }));
  (window as unknown as { electron: unknown }).electron = {
    pdf: { getAll },
    corpus: { getCollections },
    project: { getConfig: vi.fn(async () => ({})) },
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  projectLifecycle.enter('/projets/A');
  useRAGQueryStore.setState({
    availableDocuments: [DOC_A],
    availableCollections: [{ key: 'GUERRE', name: 'Guerre froide' }],
    isLoadingDocuments: false,
    isLoadingCollections: false,
  });
  useRAGQueryStore.getState().setParams({
    selectedDocumentIds: ['doc-a', 'doc-a2'],
    selectedCollectionKeys: ['GUERRE'],
    topK: 13,
    includeBibliography: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('ragQueryStore — changement de projet', () => {
  it('sélections et listes de A disparaissent ; les autres réglages restent', () => {
    switchTo('/projets/B');

    const state = useRAGQueryStore.getState();
    expect(state.params.selectedDocumentIds).toEqual([]);
    expect(state.params.selectedCollectionKeys).toEqual([]);
    expect(state.availableDocuments).toEqual([]);
    expect(state.availableCollections).toEqual([]);
    // Ce que l'auteur a réglé pour le chat ne dépend pas du projet.
    expect(state.params.topK).toBe(13);
    expect(state.params.includeBibliography).toBe(false);
  });

  it('fermer le projet les vide aussi', () => {
    switchTo(null);

    expect(useRAGQueryStore.getState().params.selectedDocumentIds).toEqual([]);
    expect(useRAGQueryStore.getState().availableDocuments).toEqual([]);
  });

  it('le même projet rouvert garde sa sélection', () => {
    switchTo('/projets/A');

    expect(useRAGQueryStore.getState().params.selectedDocumentIds).toEqual(['doc-a', 'doc-a2']);
  });

  it('une liste de documents demandée dans A, arrivée après le passage à B, est ignorée', async () => {
    const response = held<unknown>();
    getAll.mockReturnValueOnce(response.promise);
    const loading = useRAGQueryStore.getState().loadAvailableDocuments();

    switchTo('/projets/B');
    response.release({ success: true, documents: [{ id: 'doc-a', title: 'Le préfet et la grève' }] });
    await loading;

    expect(useRAGQueryStore.getState().availableDocuments).toEqual([]);
    expect(useRAGQueryStore.getState().isLoadingDocuments).toBe(false);
  });

  it('une liste de collections demandée dans A, arrivée après le passage à B, est ignorée', async () => {
    const response = held<unknown>();
    getCollections.mockReturnValueOnce(response.promise);
    const loading = useRAGQueryStore.getState().loadAvailableCollections();

    switchTo('/projets/B');
    response.release({ success: true, collections: [{ key: 'GUERRE', name: 'Guerre froide' }] });
    await loading;

    expect(useRAGQueryStore.getState().availableCollections).toEqual([]);
    expect(useRAGQueryStore.getState().isLoadingCollections).toBe(false);
  });

  it('A revient après l’échec de B : la réponse ignorée pendant la tentative ne laisse pas de chargement en cours', async () => {
    const response = held<unknown>();
    getAll.mockReturnValueOnce(response.promise);
    const loading = useRAGQueryStore.getState().loadAvailableDocuments();

    projectLifecycle.beginTransition();
    projectLifecycle.abortTransition();
    response.release({ success: true, documents: [{ id: 'doc-b', title: 'Servi par B' }] });
    await loading;

    // Rien de ce que le main a pu servir pendant la tentative : la liste de A reste celle d'avant.
    expect(useRAGQueryStore.getState().availableDocuments).toEqual([DOC_A]);
    expect(useRAGQueryStore.getState().isLoadingDocuments).toBe(false);
  });

  it('témoin : une liste demandée et reçue dans le même projet s’inscrit', async () => {
    getAll.mockResolvedValueOnce({ success: true, documents: [{ id: 'doc-a3', title: 'Rapport' }] });

    await useRAGQueryStore.getState().loadAvailableDocuments();

    expect(useRAGQueryStore.getState().availableDocuments.map((d) => d.id)).toEqual(['doc-a3']);
  });
});
