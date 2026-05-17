import { useState, useEffect, useRef } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import type { GraphData, GraphNode, CorpusStatistics, TopicAnalysisResult } from './corpus-types';

interface Filters {
  year: number | null;
  author: string | null;
  language: string | null;
  topic: number | null;
}

export function useCorpusData() {
  const { currentProject } = useProjectStore();
  const [statistics, setStatistics] = useState<CorpusStatistics | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
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
  const [regeneratingGraph, setRegeneratingGraph] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    year: null,
    author: null,
    language: null,
    topic: null,
  });

  const graphRef = useRef<unknown>();

  useEffect(() => {
    if (currentProject) {
      loadCorpusData();
    } else {
      setLoading(false);
      setStatistics(null);
      setGraphData(null);
      setFullGraphData(null);
      setTopicAnalysis(null);
      setError(null);
    }
  }, [currentProject]);

  useEffect(() => {
    applyFilters();
  }, [filters, fullGraphData]);

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
        includeAuthorNodes: false,
        computeLayout: true,
      });

      if (graphResult.success) {
        setFullGraphData(graphResult.graph);
        setGraphData(graphResult.graph);
      } else {
        throw new Error(graphResult.error || 'Failed to load graph');
      }

      try {
        const topicsResult = await window.electron.corpus.loadTopics();
        if (topicsResult.success) {
          setTopicAnalysis(topicsResult);
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
        includeAuthorNodes: false,
        computeLayout: true,
      });

      if (graphResult.success) {
        setFullGraphData(graphResult.graph);
        setGraphData(graphResult.graph);
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
    setLoadingTopics(true);
    try {
      const result = await window.electron.corpus.analyzeTopics({
        minTopicSize: 3,
        language: 'multilingual',
        nGramRange: [1, 3],
        nrTopics: numTopics,
      });

      if (result.success) {
        setTopicAnalysis(result);
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

  const applyFilters = () => {
    if (!fullGraphData) return;

    let filteredNodes = [...fullGraphData.nodes];

    if (filters.year !== null) {
      filteredNodes = filteredNodes.filter(
        (node) => node.metadata?.year === filters.year?.toString()
      );
    }
    if (filters.author !== null) {
      filteredNodes = filteredNodes.filter(
        (node) => node.metadata?.author === filters.author
      );
    }
    if (filters.topic !== null && topicAnalysis?.topicAssignments) {
      const docsInTopic = Object.entries(topicAnalysis.topicAssignments)
        .filter(([, topicId]) => topicId === filters.topic)
        .map(([docId]) => docId);
      filteredNodes = filteredNodes.filter((node) => docsInTopic.includes(node.id));
    }

    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = fullGraphData.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
    );

    setGraphData({ nodes: filteredNodes, edges: filteredEdges });
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
