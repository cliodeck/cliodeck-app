import { useState, useEffect, useMemo, useRef } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import { refusedAsProjectChanged, stillIn } from '../../services/still-in-project';
import { filterCorpusGraph } from './corpus-filters';
import type { CorpusFilters, GraphData, GraphNode, CorpusStatistics, TopicAnalysisResult } from './corpus-types';

export function useCorpusData() {
  const { currentProject } = useProjectStore();
  const [statistics, setStatistics] = useState<CorpusStatistics | null>(null);
  const [fullGraphData, setFullGraphData] = useState<GraphData | null>(null);
  const [topicAnalysis, setTopicAnalysis] = useState<TopicAnalysisResult | null>(null);
  const [topicTimeline, setTopicTimeline] = useState<Array<{ year: number; [key: string]: number }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expandedTopic, setExpandedTopic] = useState<number | null>(null);
  const [numTopics, setNumTopics] = useState<number>(10);
  const [graphSimilarityThreshold, setGraphSimilarityThreshold] = useState<number>(0.7);
  // #22 : le KnowledgeGraphBuilder sait produire des nœuds auteurs depuis
  // toujours, mais les deux appels passaient `false` en dur. Comme le seuil
  // de similarité, le réglage prend effet à la régénération du graphe.
  const [includeAuthorNodes, setIncludeAuthorNodes] = useState<boolean>(false);
  const [regeneratingGraph, setRegeneratingGraph] = useState(false);
  const [filters, setFilters] = useState<CorpusFilters>({
    year: null,
    author: null,
    language: null,
    topic: null,
  });

  // Le graphe affiché : le graphe complet réduit aux filtres, recalculé quand l'un d'eux, le graphe
  // ou l'analyse des thèmes change (S13-1-30). Mémorisé : son identité ne change qu'avec eux, et
  // force-graph ne relance sa simulation qu'à un nouvel objet.
  const graphData = useMemo(
    () => (fullGraphData ? filterCorpusGraph(fullGraphData, filters, topicAnalysis?.topicAssignments) : null),
    [fullGraphData, filters, topicAnalysis]
  );

  const graphRef = useRef<unknown>();

  useEffect(() => {
    if (currentProject) {
      loadCorpusData();
    } else {
      setLoading(false);
      setStatistics(null);
      setFullGraphData(null);
      setTopicAnalysis(null);
      setError(null);
    }
  }, [currentProject]);

  /**
   * Une analyse des thèmes arrive : celle que le main a enregistrée, au chargement comme après
   * « Réanalyser ». Elle renumérote ses thèmes : un thème filtré qu'elle n'a plus ne filtre plus
   * rien, et le menu revient à « Tous ».
   */
  const showAnalysis = (analysis: TopicAnalysisResult) => {
    setTopicAnalysis(analysis);
    setFilters((current) =>
      current.topic !== null && !(analysis.topics ?? []).some((topic) => topic.id === current.topic)
        ? { ...current, topic: null }
        : current
    );
  };

  const loadCorpusData = async () => {
    setLoading(true);
    setError(null);

    try {
      let configuredThreshold = 0.7;
      try {
        const ragConfig = await window.electron.config.get('rag');
        if (ragConfig?.explorationSimilarityThreshold) {
          configuredThreshold = ragConfig.explorationSimilarityThreshold;
          setGraphSimilarityThreshold(configuredThreshold);
        }
      } catch {
        // Use default threshold
      }

      const statsResult = await window.electron.corpus.getStatistics();
      if (statsResult.success) {
        setStatistics(statsResult.statistics);
      }

      const graphResult = await window.electron.corpus.getGraph({
        includeSimilarityEdges: true,
        similarityThreshold: configuredThreshold,
        includeAuthorNodes,
        computeLayout: true,
      });

      if (graphResult.success) {
        setFullGraphData(graphResult.graph);
      } else {
        throw new Error(graphResult.error || 'Failed to load graph');
      }

      try {
        const topicsResult = await window.electron.corpus.loadTopics();
        if (topicsResult.success) {
          showAnalysis(topicsResult);
          if (topicsResult.options?.nrTopics && topicsResult.options.nrTopics !== 'auto') {
            setNumTopics(topicsResult.options.nrTopics);
          }
          try {
            const timelineResult = await window.electron.corpus.getTopicTimeline();
            if (timelineResult.success) {
              setTopicTimeline(timelineResult.timeline);
            }
          } catch {
            // Timeline not available
          }
        }
      } catch {
        // No saved topics
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load corpus data';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const regenerateGraph = async (t: (key: string) => string) => {
    setRegeneratingGraph(true);
    try {
      const graphResult = await window.electron.corpus.getGraph({
        includeSimilarityEdges: true,
        similarityThreshold: graphSimilarityThreshold,
        includeAuthorNodes,
        computeLayout: true,
      });

      if (graphResult.success) {
        setFullGraphData(graphResult.graph);
      } else {
        throw new Error(graphResult.error || 'Failed to regenerate graph');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await useDialogStore.getState().showAlert(t('corpus.graphRegenerateError') + ': ' + message);
    } finally {
      setRegeneratingGraph(false);
    }
  };

  const loadTopics = async (t: (key: string) => string) => {
    // Le projet du clic. Le calcul dure des minutes : ni son résultat ni son échec ne s'affichent
    // dans un projet ouvert entre-temps (S03-1-21). Remonter l'Explorer par projet ne suffit pas :
    // l'alerte est globale.
    // - Le main refuse dès que son magasin a changé (`project-changed`) : rien n'est enregistré, ni
    //   montré, même si l'écran montre encore ce projet (fermé d'office, l'événement pas encore là).
    // - Sinon l'analyse est enregistrée dans le projet du clic. Elle se montre s'il est à l'écran une
    //   fois tranchée l'ouverture en cours (`stillIn`) : une ouverture refusée, ou le dossier ouvert
    //   rechoisi, laissent ce projet à l'écran et son magasin au main. Le handle du projet ne convient
    //   pas ici : il finit à toute demande au main, et le projet revenu en reçoit un neuf.
    const path = useProjectStore.getState().currentProject?.path ?? null;
    const stillHere = async (): Promise<boolean> => path !== null && (await stillIn(path));
    setLoadingTopics(true);
    try {
      const result = await window.electron.corpus.analyzeTopics({
        minTopicSize: 3,
        language: 'multilingual',
        nGramRange: [1, 3],
        nrTopics: numTopics,
      });
      if (refusedAsProjectChanged(result) || !(await stillHere())) return;

      if (result.success) {
        showAnalysis(result);
        try {
          const timelineResult = await window.electron.corpus.getTopicTimeline();
          if (timelineResult.success) {
            setTopicTimeline(timelineResult.timeline);
          }
        } catch {
          // Timeline not available
        }
      } else {
        const errorMsg = result.error || '';
        if (errorMsg.includes('not available') || errorMsg.includes('not start') || errorMsg.includes('timeout')) {
          await useDialogStore.getState().showAlert(t('corpus.topicServiceUnavailable'));
        } else {
          await useDialogStore.getState().showAlert(t('corpus.topicAnalysisErrorGeneric') + ': ' + errorMsg);
        }
      }
    } catch (err: unknown) {
      if (!(await stillHere())) return;
      const errorMsg = err instanceof Error ? err.message : '';
      if (errorMsg.includes('not available') || errorMsg.includes('not start') || errorMsg.includes('timeout')) {
        await useDialogStore.getState().showAlert(t('corpus.topicServiceUnavailable'));
      } else {
        await useDialogStore.getState().showAlert(t('corpus.topicAnalysisErrorGeneric') + ': ' + errorMsg);
      }
    } finally {
      setLoadingTopics(false);
    }
  };

  const clearFilters = () => {
    setFilters({ year: null, author: null, language: null, topic: null });
  };

  const getAvailableYears = (): number[] => {
    if (!fullGraphData) return [];
    const years = new Set<number>();
    fullGraphData.nodes.forEach((node) => {
      if (node.metadata?.year) years.add(parseInt(node.metadata.year));
    });
    return Array.from(years).sort((a, b) => a - b);
  };

  const getAvailableAuthors = (): string[] => {
    if (!fullGraphData) return [];
    const authors = new Set<string>();
    fullGraphData.nodes.forEach((node) => {
      if (node.metadata?.author) authors.add(node.metadata.author);
    });
    return Array.from(authors).sort();
  };

  const getDocumentsForTopic = (topicId: number): GraphNode[] => {
    if (!topicAnalysis?.topicAssignments || !fullGraphData) return [];
    const docIds = Object.entries(topicAnalysis.topicAssignments)
      .filter(([, assignedTopicId]) => assignedTopicId === topicId)
      .map(([docId]) => docId);
    return fullGraphData.nodes.filter((node) => docIds.includes(node.id));
  };

  return {
    currentProject,
    statistics,
    graphData,
    fullGraphData,
    topicAnalysis,
    topicTimeline,
    loading,
    loadingTopics,
    error,
    selectedNode,
    setSelectedNode,
    expandedTopic,
    setExpandedTopic,
    numTopics,
    setNumTopics,
    graphSimilarityThreshold,
    setGraphSimilarityThreshold,
    includeAuthorNodes,
    setIncludeAuthorNodes,
    regeneratingGraph,
    filters,
    setFilters,
    graphRef,
    loadCorpusData,
    regenerateGraph,
    loadTopics,
    clearFilters,
    getAvailableYears,
    getAvailableAuthors,
    getDocumentsForTopic,
  };
}
