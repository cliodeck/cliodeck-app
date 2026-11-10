// @vitest-environment jsdom
/**
 * Une analyse des thèmes lancée dans un projet ne s'affiche pas dans le suivant (S03-1-21).
 *
 * Le calcul dure des minutes. Ouvrir un autre projet entre-temps fait refuser l'analyse par le main
 * (`project-changed`), qui n'enregistre rien. Ce refus ouvrait pourtant une alerte « Erreur lors de
 * l'analyse des topics: project-changed » dans le projet suivant : l'alerte passe par un store
 * global, que le remontage de l'Explorer par projet ne vide pas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useCorpusData } from '../useCorpusData';
import { useDialogStore } from '../../../stores/dialogStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

const t = (key: string): string => key;

type AnalyzeTopics = () => Promise<Record<string, unknown>>;

function installCorpus(analyzeTopics: AnalyzeTopics): { getTopicTimeline: ReturnType<typeof vi.fn> } {
  const getTopicTimeline = vi.fn(async () => ({ success: true, timeline: [{ year: 2020, 0: 1 }] }));
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = { ...w.electron, corpus: { analyzeTopics: vi.fn(analyzeTopics), getTopicTimeline } };
  return { getTopicTimeline };
}

/** L'écran passe de A à B, comme `projectStore` le fait pendant l'attente. */
function openB(): void {
  projectLifecycle.beginTransition();
  projectLifecycle.enter('/projets/B');
}

const analysisOfA = {
  success: true,
  topics: [{ id: 0, label: 'thème de A', keywords: ['thème-de-A'], documents: ['a1'], size: 1 }],
  topicAssignments: { a1: 0 },
  outliers: [],
  statistics: { totalDocuments: 1, numTopics: 1, numOutliers: 0, numDocumentsInTopics: 1 },
};

describe('useCorpusData.loadTopics : un autre projet ouvert pendant le calcul', () => {
  let showAlert: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectLifecycle.enter('/projets/A');
    showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    projectLifecycle.enter(null);
  });

  async function analyze(): Promise<ReturnType<typeof useCorpusData>> {
    const { result } = renderHook(() => useCorpusData());
    await act(async () => {
      await result.current.loadTopics(t);
    });
    return result.current;
  }

  it('le main refuse (project-changed) : aucune alerte, rien n’est posé', async () => {
    installCorpus(async () => {
      openB();
      return { success: false, error: 'project-changed' };
    });

    const data = await analyze();

    expect(showAlert).not.toHaveBeenCalled();
    expect(data.topicAnalysis).toBeNull();
    expect(data.loadingTopics).toBe(false);
  });

  it('l’analyse de A répond après l’ouverture de B : ni ses thèmes ni sa frise ne sont posés', async () => {
    const { getTopicTimeline } = installCorpus(async () => {
      openB();
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
      openB();
      throw new Error("Error invoking remote method 'corpus:analyze-topics': Error: Topic modeling service not available");
    });

    await analyze();

    expect(showAlert).not.toHaveBeenCalled();
  });

  it('témoin : un échec dans le projet resté ouvert s’affiche toujours', async () => {
    installCorpus(async () => ({ success: false, error: 'Topic modeling requires at least 5 documents' }));

    await analyze();

    expect(showAlert).toHaveBeenCalledExactlyOnceWith(
      'corpus.topicAnalysisErrorGeneric: Topic modeling requires at least 5 documents'
    );
  });

  it('témoin : sans bascule, l’analyse et sa frise s’affichent', async () => {
    installCorpus(async () => analysisOfA);

    const data = await analyze();

    expect(data.topicAnalysis?.topics.map((topic) => topic.keywords)).toEqual([['thème-de-A']]);
    expect(data.topicTimeline).toEqual([{ year: 2020, 0: 1 }]);
  });
});
