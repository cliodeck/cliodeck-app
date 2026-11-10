// @vitest-environment jsdom
/**
 * Une analyse des thèmes lancée dans un projet ne s'affiche pas dans le suivant (S03-1-21), et
 * s'affiche dans le sien tant qu'il est à l'écran.
 *
 * Le calcul dure des minutes. Ouvrir un autre projet entre-temps fait refuser l'analyse par le main
 * (`project-changed`), qui n'enregistre rien. Ce refus ouvrait pourtant une alerte « Erreur lors de
 * l'analyse des topics: project-changed » dans le projet suivant : l'alerte passe par un store
 * global, que le remontage de l'Explorer par projet ne vide pas.
 *
 * À l'inverse, une ouverture refusée au préflight, ou le dossier ouvert rechoisi, laissent au main le
 * magasin de A : l'analyse y est enregistrée, et l'écran de A doit la montrer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useCorpusData } from '../useCorpusData';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

const t = (key: string): string => key;

const A = '/projets/A';
const B = '/projets/B';

const project = (path: string) =>
  ({ id: path, name: path, path, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() }) as never;

type Answer = Record<string, unknown>;

/** Une réponse du main qu'on rend quand on veut. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installCorpus(analyzeTopics: () => Promise<Answer>): { getTopicTimeline: ReturnType<typeof vi.fn> } {
  const getTopicTimeline = vi.fn(async () => ({ success: true, timeline: [{ year: 2020, 0: 1 }] }));
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    config: { get: vi.fn(async () => ({})) },
    corpus: {
      // Le chargement du montage : aucune analyse enregistrée.
      getStatistics: vi.fn(async () => ({ success: false })),
      getGraph: vi.fn(async () => ({ success: true, graph: { nodes: [], edges: [] } })),
      loadTopics: vi.fn(async () => ({ success: false })),
      analyzeTopics: vi.fn(analyzeTopics),
      getTopicTimeline,
    },
  };
  return { getTopicTimeline };
}

// Ce que `projectStore.loadProject` fait de l'écran, dans son ordre.

/** La demande d'ouverture de `path` part au main. */
function startOpening(path: string): void {
  useProjectStore.setState({ loadState: { kind: 'loading', path } } as never);
  projectLifecycle.beginTransition();
}

/** Le main a rendu `path` (un autre projet, ou le même dossier rechoisi) : l'écran le montre. */
function opened(path: string): void {
  projectLifecycle.enter(path);
  useProjectStore.setState({ currentProject: project(path), loadState: { kind: 'ready', path, loadedAt: '' } } as never);
}

/** Le main a refusé `path` au préflight (projet récent déplacé, project.json illisible) : A reste. */
function refused(path: string): void {
  projectLifecycle.abortTransition();
  useProjectStore.setState({ loadState: { kind: 'failed', path, error: 'refusé', at: '' } } as never);
}

const analysisOfA = {
  success: true,
  topics: [{ id: 0, label: 'thème de A', keywords: ['thème-de-A'], documents: ['a1'], size: 1 }],
  topicAssignments: { a1: 0 },
  outliers: [],
  statistics: { totalDocuments: 1, numTopics: 1, numOutliers: 0, numDocumentsInTopics: 1 },
};

const keywordsOf = (data: ReturnType<typeof useCorpusData>) => data.topicAnalysis?.topics.map((topic) => topic.keywords);

describe('useCorpusData.loadTopics : le projet du clic, et celui qui est à l’écran au retour', () => {
  let showAlert: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    opened(A);
    showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    projectLifecycle.enter(null);
    useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } } as never);
  });

  /** L'Explorer de A, monté et chargé. */
  async function mount() {
    const hook = renderHook(() => useCorpusData());
    await act(async () => undefined);
    return hook;
  }

  async function analyze(): Promise<ReturnType<typeof useCorpusData>> {
    const { result } = await mount();
    await act(async () => {
      await result.current.loadTopics(t);
    });
    return result.current;
  }

  describe('B ouvert pendant le calcul', () => {
    it('le main refuse (project-changed) : aucune alerte, rien n’est posé', async () => {
      installCorpus(async () => {
        startOpening(B);
        opened(B);
        return { success: false, error: 'project-changed' };
      });

      const data = await analyze();

      expect(showAlert).not.toHaveBeenCalled();
      expect(data.topicAnalysis).toBeNull();
      expect(data.loadingTopics).toBe(false);
    });

    it('l’analyse de A répond après l’ouverture de B : ni ses thèmes ni sa frise ne sont posés', async () => {
      const { getTopicTimeline } = installCorpus(async () => {
        startOpening(B);
        opened(B);
        return analysisOfA;
      });

      const data = await analyze();

      expect(data.topicAnalysis).toBeNull();
      expect(data.topicTimeline).toBeNull();
      expect(getTopicTimeline).not.toHaveBeenCalled();
      expect(showAlert).not.toHaveBeenCalled();
    });

    it('l’échec de l’analyse de A arrive après l’ouverture de B : pas d’alerte dans B', async () => {
      installCorpus(async () => {
        startOpening(B);
        opened(B);
        throw new Error("Error invoking remote method 'corpus:analyze-topics': Error: Topic modeling service not available");
      });

      await analyze();

      expect(showAlert).not.toHaveBeenCalled();
    });

    it('la réponse de A arrive pendant l’ouverture de B, qui aboutit : rien ne s’affiche, ni avant ni après', async () => {
      const answer = deferred<Answer>();
      const { getTopicTimeline } = installCorpus(() => answer.promise);
      const { result } = await mount();
      let done: Promise<void> = Promise.resolve();
      await act(async () => {
        done = result.current.loadTopics(t);
      });

      await act(async () => {
        startOpening(B);
        answer.resolve(analysisOfA);
      });
      await act(async () => {
        opened(B);
        await done;
      });

      expect(result.current.topicAnalysis).toBeNull();
      expect(getTopicTimeline).not.toHaveBeenCalled();
      expect(showAlert).not.toHaveBeenCalled();
    });
  });

  /**
   * Le main a gardé le magasin de A, et y a enregistré l'analyse : l'écran de A la montre. Le handle
   * capturé au clic a pourtant fini (`beginTransition`), et le projet revenu en a reçu un neuf.
   */
  describe('A reste à l’écran', () => {
    it('le main refuse (project-changed) alors que l’écran n’a pas changé : aucune alerte, rien n’est posé', async () => {
      // Le main a fermé le projet de lui-même, et sa réponse arrive avant l'événement `project:closed`.
      installCorpus(async () => ({ success: false, error: 'project-changed' }));

      const data = await analyze();

      expect(showAlert).not.toHaveBeenCalled();
      expect(data.topicAnalysis).toBeNull();
      expect(data.loadingTopics).toBe(false);
    });

    it('l’ouverture de B est refusée pendant le calcul : l’analyse de A s’affiche', async () => {
      installCorpus(async () => {
        startOpening(B);
        refused(B);
        return analysisOfA;
      });

      const data = await analyze();

      expect(keywordsOf(data)).toEqual([['thème-de-A']]);
      expect(data.topicTimeline).toEqual([{ year: 2020, 0: 1 }]);
    });

    it('A rechoisi dans les projets récents pendant le calcul : l’analyse s’affiche', async () => {
      installCorpus(async () => {
        startOpening(A);
        opened(A);
        return analysisOfA;
      });

      const data = await analyze();

      expect(keywordsOf(data)).toEqual([['thème-de-A']]);
    });

    it('la réponse arrive pendant l’ouverture de B, refusée ensuite : l’analyse s’affiche une fois A revenu', async () => {
      const answer = deferred<Answer>();
      const { getTopicTimeline } = installCorpus(() => answer.promise);
      const { result } = await mount();
      let done: Promise<void> = Promise.resolve();
      await act(async () => {
        done = result.current.loadTopics(t);
      });

      await act(async () => {
        startOpening(B);
        answer.resolve(analysisOfA);
      });
      // L'issue n'est pas encore connue : rien ne s'affiche.
      expect(result.current.topicAnalysis).toBeNull();
      expect(getTopicTimeline).not.toHaveBeenCalled();

      await act(async () => {
        refused(B);
        await done;
      });

      expect(keywordsOf(result.current)).toEqual([['thème-de-A']]);
      expect(result.current.loadingTopics).toBe(false);
    });

    it('l’ouverture de B est refusée pendant le calcul, qui échoue : l’alerte s’affiche dans A', async () => {
      installCorpus(async () => {
        startOpening(B);
        refused(B);
        return { success: false, error: 'Topic modeling requires at least 5 documents' };
      });

      await analyze();

      expect(showAlert).toHaveBeenCalledExactlyOnceWith(
        'corpus.topicAnalysisErrorGeneric: Topic modeling requires at least 5 documents'
      );
    });
  });

  describe('témoins, sans bascule', () => {
    it('un échec s’affiche toujours', async () => {
      installCorpus(async () => ({ success: false, error: 'Topic modeling requires at least 5 documents' }));

      await analyze();

      expect(showAlert).toHaveBeenCalledExactlyOnceWith(
        'corpus.topicAnalysisErrorGeneric: Topic modeling requires at least 5 documents'
      );
    });

    it('l’analyse et sa frise s’affichent', async () => {
      installCorpus(async () => analysisOfA);

      const data = await analyze();

      expect(keywordsOf(data)).toEqual([['thème-de-A']]);
      expect(data.topicTimeline).toEqual([{ year: 2020, 0: 1 }]);
    });
  });
});
