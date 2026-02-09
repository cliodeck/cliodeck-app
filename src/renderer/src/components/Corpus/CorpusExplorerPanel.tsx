import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ForceGraph2D from 'react-force-graph-2d';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { TopicTimeline } from './TopicTimeline';
import { TextometricsPanel } from './TextometricsPanel';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { useProjectStore } from '../../stores/projectStore';
import './CorpusExplorerPanel.css';

interface GraphNode {
  id: string;
  type: 'document' | 'author';
  label: string;
  metadata?: {
    title?: string;
    author?: string;
    year?: string;
    pageCount?: number;
  };
  centrality?: number;
  community?: number;
  x?: number;
  y?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: 'citation' | 'similarity' | 'co-citation';
  weight: number;
  metadata?: {
    context?: string;
    pageNumber?: number;
  };
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface CorpusStatistics {
  documentCount: number;
  chunkCount: number;
  citationCount: number; // Citations internes (matchées dans le corpus)
  totalCitationsExtracted: number; // Total des citations extraites
  languageCount: number;
  languages: string[];
  yearRange: {
    min: number;
    max: number;
  } | null;
  authorCount: number;
}

interface Topic {
  id: number;
  keywords: string[];
  size: number;
  representative_docs?: string[];
}

interface TopicAnalysisResult {
  topics: Topic[];
  topicAssignments?: Record<string, number>;
  outliers?: string[];
  statistics?: {
    totalDocuments: number;
    numTopics: number;
    numOutliers: number;
    numDocumentsInTopics: number;
  };
  options?: {
    minTopicSize?: number;
    nrTopics?: number | 'auto';
    language?: string;
    nGramRange?: [number, number];
  };
}

export const CorpusExplorerPanel: React.FC = () => {
  const { t } = useTranslation();
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
  const [numTopics, setNumTopics] = useState<number>(10); // Nombre de topics souhaités
  const [graphSimilarityThreshold, setGraphSimilarityThreshold] = useState<number>(0.7);
  const [regeneratingGraph, setRegeneratingGraph] = useState(false);

  // Filters
  const [filters, setFilters] = useState({
    year: null as number | null,
    author: null as string | null,
    language: null as string | null,
    topic: null as number | null,
  });

  const graphRef = useRef<any>();

  // Charger les données seulement quand un projet est chargé
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
      // Charger la configuration pour récupérer le seuil de similarité
      let configuredThreshold = 0.7;
      try {
        const ragConfig = await window.electron.config.get('rag');
        if (ragConfig?.explorationSimilarityThreshold) {
          configuredThreshold = ragConfig.explorationSimilarityThreshold;
          setGraphSimilarityThreshold(configuredThreshold);
        }
      } catch (configErr) {
        console.warn('Could not load RAG config, using default threshold:', configErr);
      }

      // Charger les statistiques
      const statsResult = await window.electron.corpus.getStatistics();
      if (statsResult.success) {
        setStatistics(statsResult.statistics);
      } else {
        console.warn('Failed to load statistics:', statsResult.error);
      }

      // Charger le graphe avec le seuil configuré
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

      // Charger les topics sauvegardés (si disponibles)
      try {
        const topicsResult = await window.electron.corpus.loadTopics();
        if (topicsResult.success) {
          setTopicAnalysis(topicsResult);
          console.log('✅ Loaded saved topics:', topicsResult.topics.length);

          // Restaurer le nombre de topics depuis les options sauvegardées
          if (topicsResult.options?.nrTopics && topicsResult.options.nrTopics !== 'auto') {
            setNumTopics(topicsResult.options.nrTopics);
            console.log('✅ Restored numTopics:', topicsResult.options.nrTopics);
          }

          // Charger la timeline des topics
          try {
            const timelineResult = await window.electron.corpus.getTopicTimeline();
            if (timelineResult.success) {
              setTopicTimeline(timelineResult.timeline);
              console.log('✅ Loaded topic timeline:', timelineResult.timeline.length, 'years');
            }
          } catch (timelineErr) {
            console.log('ℹ️ Could not load topic timeline:', timelineErr);
          }
        } else {
          console.log('ℹ️ No saved topics found');
        }
      } catch (err) {
        console.log('ℹ️ Could not load saved topics:', err);
      }
    } catch (err: any) {
      console.error('Error loading corpus data:', err);
      setError(err.message || 'Failed to load corpus data');
    } finally {
      setLoading(false);
    }
  };

  const regenerateGraph = async () => {
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
        console.log(`✅ Graph regenerated with threshold ${graphSimilarityThreshold}`);
      } else {
        throw new Error(graphResult.error || 'Failed to regenerate graph');
      }
    } catch (err: any) {
      console.error('Error regenerating graph:', err);
      alert(t('corpus.graphRegenerateError') + ': ' + err.message);
    } finally {
      setRegeneratingGraph(false);
    }
  };

  const loadTopics = async () => {
    setLoadingTopics(true);
    try {
      const result = await window.electron.corpus.analyzeTopics({
        minTopicSize: 3,
        language: 'multilingual',
        nGramRange: [1, 3],
        nrTopics: numTopics, // Nombre de topics souhaités
      });

      if (result.success) {
        setTopicAnalysis(result);

        // Charger la timeline des topics après l'analyse
        try {
          const timelineResult = await window.electron.corpus.getTopicTimeline();
          if (timelineResult.success) {
            setTopicTimeline(timelineResult.timeline);
            console.log('✅ Loaded topic timeline:', timelineResult.timeline.length, 'years');
          }
        } catch (timelineErr) {
          console.log('ℹ️ Could not load topic timeline:', timelineErr);
        }
      } else {
        console.error('Failed to load topics:', result.error);
        const errorMsg = result.error || '';
        if (errorMsg.includes('not available') || errorMsg.includes('not start') || errorMsg.includes('timeout')) {
          alert(t('corpus.topicServiceUnavailable'));
        } else {
          alert(t('corpus.topicAnalysisErrorGeneric') + ': ' + errorMsg);
        }
      }
    } catch (err: any) {
      console.error('Error loading topics:', err);
      const errorMsg = err.message || '';
      if (errorMsg.includes('not available') || errorMsg.includes('not start') || errorMsg.includes('timeout')) {
        alert(t('corpus.topicServiceUnavailable'));
      } else {
        alert(t('corpus.topicAnalysisErrorGeneric') + ': ' + errorMsg);
      }
    } finally {
      setLoadingTopics(false);
    }
  };

  const exportTopicsAsJSON = () => {
    if (!topicAnalysis) return;

    const exportData = {
      exportDate: new Date().toISOString(),
      analysisDate: (topicAnalysis as any).analysisDate || new Date().toISOString(),
      statistics: (topicAnalysis as any).statistics || {},
      topics: topicAnalysis.topics.map(topic => ({
        id: topic.id,
        keywords: topic.keywords,
        size: topic.size,
        documents: (fullGraphData?.nodes || [])
          .filter(node => topicAnalysis.topicAssignments?.[node.id] === topic.id)
          .map(node => ({
            id: node.id,
            title: node.metadata?.title || node.label,
            author: node.metadata?.author,
            year: node.metadata?.year,
          }))
      })),
      outliers: (topicAnalysis.outliers || []).map(docId => {
        const node = fullGraphData?.nodes.find(n => n.id === docId);
        return {
          id: docId,
          title: node?.metadata?.title || node?.label,
          author: node?.metadata?.author,
        };
      })
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topics-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTopicsAsCSV = () => {
    if (!topicAnalysis) return;

    let csv = 'Document_ID,Document_Title,Author,Year,Topic_ID,Topic_Keywords\n';

    // Get all document nodes
    const documentNodes = (fullGraphData?.nodes || []).filter(node => node.type === 'document');

    documentNodes.forEach(node => {
      const documentId = node.id;
      const title = (node.metadata?.title || node.label).replace(/"/g, '""'); // Escape quotes
      const author = (node.metadata?.author || '').replace(/"/g, '""');
      const year = node.metadata?.year || '';
      const topicId = topicAnalysis.topicAssignments?.[documentId] ?? -1; // -1 = outlier

      // Find topic keywords
      let topicKeywords = '';
      if (topicId >= 0) {
        const topic = topicAnalysis.topics.find(t => t.id === topicId);
        if (topic) {
          topicKeywords = topic.keywords.join(';');
        }
      } else {
        topicKeywords = 'OUTLIER';
      }

      csv += `"${documentId}","${title}","${author}","${year}",${topicId},"${topicKeywords}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topics-by-document-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTopicsAsMarkdown = () => {
    if (!topicAnalysis) return;

    let md = `# Analyse Thématique - Export\n\n`;
    md += `**Date d'export:** ${new Date().toLocaleDateString()}\n`;
    md += `**Nombre de topics:** ${topicAnalysis.topics.length}\n\n`;
    md += `---\n\n`;

    topicAnalysis.topics.forEach(topic => {
      md += `## Topic ${topic.id}\n\n`;
      md += `**Mots-clés:** ${topic.keywords.join(', ')}\n\n`;
      md += `**Taille:** ${topic.size} documents\n\n`;

      const topicDocs = (fullGraphData?.nodes || [])
        .filter(node => topicAnalysis.topicAssignments?.[node.id] === topic.id);

      if (topicDocs.length > 0) {
        md += `**Documents:**\n\n`;
        topicDocs.forEach(node => {
          const title = node.metadata?.title || node.label;
          const author = node.metadata?.author || '';
          const year = node.metadata?.year || '';
          md += `- ${title}${author ? ` (${author}` : ''}${year ? `, ${year})` : author ? ')' : ''}\n`;
        });
        md += `\n`;
      }
    });

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topics-export-${new Date().toISOString().split('T')[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportGraphAsGEXF = () => {
    if (!fullGraphData) return;

    console.log(`📊 Exporting GEXF: ${fullGraphData.nodes.length} nodes, ${fullGraphData.edges.length} edges`);

    // Générer le fichier GEXF (format XML pour Gephi)
    let gexf = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gexf += `<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2">\n`;
    gexf += `  <meta lastmodifieddate="${new Date().toISOString().split('T')[0]}">\n`;
    gexf += `    <creator>ClioDesk</creator>\n`;
    gexf += `    <description>Knowledge Graph Export</description>\n`;
    gexf += `  </meta>\n`;
    gexf += `  <graph mode="static" defaultedgetype="directed">\n`;

    // Attributs des nœuds
    gexf += `    <attributes class="node">\n`;
    gexf += `      <attribute id="0" title="type" type="string"/>\n`;
    gexf += `      <attribute id="1" title="title" type="string"/>\n`;
    gexf += `      <attribute id="2" title="author" type="string"/>\n`;
    gexf += `      <attribute id="3" title="year" type="string"/>\n`;
    gexf += `      <attribute id="4" title="pageCount" type="integer"/>\n`;
    gexf += `      <attribute id="5" title="centrality" type="float"/>\n`;
    gexf += `    </attributes>\n`;

    // Attributs des arêtes
    gexf += `    <attributes class="edge">\n`;
    gexf += `      <attribute id="0" title="type" type="string"/>\n`;
    gexf += `      <attribute id="1" title="weight" type="float"/>\n`;
    gexf += `    </attributes>\n`;

    // Nœuds
    gexf += `    <nodes>\n`;
    fullGraphData.nodes.forEach((node) => {
      const escapedLabel = (node.label || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const escapedTitle = (node.metadata?.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const escapedAuthor = (node.metadata?.author || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      gexf += `      <node id="${node.id}" label="${escapedLabel}">\n`;
      gexf += `        <attvalues>\n`;
      gexf += `          <attvalue for="0" value="${node.type}"/>\n`;
      gexf += `          <attvalue for="1" value="${escapedTitle}"/>\n`;
      gexf += `          <attvalue for="2" value="${escapedAuthor}"/>\n`;
      gexf += `          <attvalue for="3" value="${node.metadata?.year || ''}"/>\n`;
      gexf += `          <attvalue for="4" value="${node.metadata?.pageCount || 0}"/>\n`;
      gexf += `          <attvalue for="5" value="${node.centrality || 0}"/>\n`;
      gexf += `        </attvalues>\n`;
      gexf += `      </node>\n`;
    });
    gexf += `    </nodes>\n`;

    // Arêtes
    gexf += `    <edges>\n`;
    fullGraphData.edges.forEach((edge, index) => {
      // Handle case where source/target might be objects (after ForceGraph processing) or strings
      const sourceId = typeof edge.source === 'object' ? (edge.source as any).id : edge.source;
      const targetId = typeof edge.target === 'object' ? (edge.target as any).id : edge.target;

      gexf += `      <edge id="${index}" source="${sourceId}" target="${targetId}">\n`;
      gexf += `        <attvalues>\n`;
      gexf += `          <attvalue for="0" value="${edge.type}"/>\n`;
      gexf += `          <attvalue for="1" value="${edge.weight}"/>\n`;
      gexf += `        </attvalues>\n`;
      gexf += `      </edge>\n`;
    });
    gexf += `    </edges>\n`;

    gexf += `  </graph>\n`;
    gexf += `</gexf>`;

    const blob = new Blob([gexf], { type: 'application/gexf+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowledge-graph-${new Date().toISOString().split('T')[0]}.gexf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Obtenir les documents d'un topic
  const getDocumentsForTopic = (topicId: number): GraphNode[] => {
    if (!topicAnalysis?.topicAssignments || !fullGraphData) return [];

    const docIds = Object.entries(topicAnalysis.topicAssignments)
      .filter(([_, assignedTopicId]) => assignedTopicId === topicId)
      .map(([docId, _]) => docId);

    return fullGraphData.nodes.filter(node => docIds.includes(node.id));
  };

  const applyFilters = () => {
    if (!fullGraphData) return;

    let filteredNodes = [...fullGraphData.nodes];

    // Filter by year
    if (filters.year !== null) {
      filteredNodes = filteredNodes.filter(
        (node) => node.metadata?.year === filters.year?.toString()
      );
    }

    // Filter by author
    if (filters.author !== null) {
      filteredNodes = filteredNodes.filter(
        (node) => node.metadata?.author === filters.author
      );
    }

    // Filter by language
    if (filters.language !== null) {
      filteredNodes = filteredNodes.filter(
        (_node) => {
          // Language is stored in the full document data, we'll need to check if it matches
          // For now, we'll skip this filter as it requires additional metadata
          return true;
        }
      );
    }

    // Filter by topic
    if (filters.topic !== null && topicAnalysis?.topicAssignments) {
      const docsInTopic = Object.entries(topicAnalysis.topicAssignments)
        .filter(([_, topicId]) => topicId === filters.topic)
        .map(([docId, _]) => docId);

      filteredNodes = filteredNodes.filter((node) =>
        docsInTopic.includes(node.id)
      );
    }

    // Filter edges to only include those between filtered nodes
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = fullGraphData.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
    );

    setGraphData({
      nodes: filteredNodes,
      edges: filteredEdges,
    });
  };

  const clearFilters = () => {
    setFilters({
      year: null,
      author: null,
      language: null,
      topic: null,
    });
  };

  const getAvailableYears = (): number[] => {
    if (!fullGraphData) return [];
    const years = new Set<number>();
    fullGraphData.nodes.forEach((node) => {
      if (node.metadata?.year) {
        years.add(parseInt(node.metadata.year));
      }
    });
    return Array.from(years).sort((a, b) => a - b);
  };

  const getAvailableAuthors = (): string[] => {
    if (!fullGraphData) return [];
    const authors = new Set<string>();
    fullGraphData.nodes.forEach((node) => {
      if (node.metadata?.author) {
        authors.add(node.metadata.author);
      }
    });
    return Array.from(authors).sort();
  };

  const handleNodeClick = (node: any) => {
    setSelectedNode(node as GraphNode);
  };

  const getNodeColor = (node: GraphNode) => {
    if (node.type === 'author') {
      return '#FFB84D'; // Orange pour auteurs
    }

    // Couleur basée sur la communauté
    if (node.community !== undefined) {
      const colors = ['#4A90E2', '#50C878', '#FF6B6B', '#9B59B6', '#F4A460'];
      return colors[node.community % colors.length];
    }

    return '#4A90E2'; // Bleu par défaut
  };

  const getNodeSize = (node: GraphNode) => {
    // Taille basée sur la centralité
    if (node.centrality !== undefined) {
      return Math.max(4, Math.min(12, 4 + node.centrality * 2));
    }
    return 6;
  };

  const getEdgeColor = (edge: GraphEdge) => {
    switch (edge.type) {
      case 'citation':
        return '#FF6B6B'; // Rouge pour citations
      case 'similarity':
        return '#50C878'; // Vert pour similarité
      case 'co-citation':
        return '#9B59B6'; // Violet pour co-citations
      default:
        return '#CCCCCC';
    }
  };

  // Aucun projet chargé
  if (!currentProject) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-empty">
          <div className="empty-icon">📁</div>
          <h3>{t('corpus.noProject')}</h3>
          <p>{t('corpus.openOrCreateProject')}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-loading">
          <div className="loading-spinner"></div>
          <p>{t('corpus.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-error">
          <h3>{t('corpus.error')}</h3>
          <p>{error}</p>
          <button onClick={loadCorpusData}>{t('corpus.retry')}</button>
        </div>
      </div>
    );
  }

  if (!statistics || !graphData || graphData.nodes.length === 0) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-empty">
          <div className="empty-icon">📊</div>
          <h3>{t('corpus.emptyCorpus')}</h3>
          <p>
            {t('corpus.indexDocuments')}
          </p>
        </div>
      </div>
    );
  }

  const handleLearnMore = () => {
    window.dispatchEvent(new CustomEvent('show-methodology-modal', { detail: { feature: 'corpus' } }));
  };

  return (
    <div className="corpus-explorer-panel">
      {/* Header */}
      <div className="corpus-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h3>{t('corpus.exploration')}</h3>
          <HelperTooltip
            content={t('corpus.tooltipHelp')}
            onLearnMore={handleLearnMore}
          />
        </div>
      </div>

      {/* Filtres */}
      <CollapsibleSection title={t('corpus.filters')} defaultExpanded={false}>
        <div className="filters-container">
          <div className="filter-group">
            <label>{t('corpus.year')}</label>
            <select
              value={filters.year || ''}
              onChange={(e) => setFilters({ ...filters, year: e.target.value ? parseInt(e.target.value) : null })}
            >
              <option value="">{t('corpus.allYears')}</option>
              {getAvailableYears().map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>{t('corpus.author')}</label>
            <select
              value={filters.author || ''}
              onChange={(e) => setFilters({ ...filters, author: e.target.value || null })}
            >
              <option value="">{t('corpus.allAuthors')}</option>
              {getAvailableAuthors().map((author) => (
                <option key={author} value={author}>
                  {author}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>{t('corpus.language')}</label>
            <select
              value={filters.language || ''}
              onChange={(e) => setFilters({ ...filters, language: e.target.value || null })}
            >
              <option value="">{t('corpus.allLanguages')}</option>
              {(statistics?.languages || []).map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>{t('corpus.topic')}</label>
            <select
              value={filters.topic !== null ? filters.topic : ''}
              onChange={(e) => setFilters({ ...filters, topic: e.target.value ? parseInt(e.target.value) : null })}
              disabled={!topicAnalysis}
            >
              <option value="">{t('corpus.allTopics')}</option>
              {(topicAnalysis?.topics || []).map((topic) => (
                <option key={topic.id} value={topic.id}>
                  Topic {topic.id}: {topic.keywords.slice(0, 3).join(', ')}
                </option>
              ))}
            </select>
          </div>

          <button onClick={clearFilters} className="clear-filters-btn">
            {t('corpus.resetFilters')}
          </button>
        </div>
      </CollapsibleSection>

      {/* Statistiques globales */}
      <CollapsibleSection title={t('corpus.statistics')} defaultExpanded={true}>
        <div className="corpus-stats">
          <div className="stat-card">
            <div className="stat-value">{statistics.documentCount}</div>
            <div className="stat-label">{t('corpus.documents')}</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{statistics.totalCitationsExtracted}</div>
            <div className="stat-label">{t('corpus.extractedCitations')}</div>
            <div className="stat-detail">
              {statistics.citationCount} {t('corpus.internalCitations')} ({Math.round((statistics.citationCount / Math.max(statistics.totalCitationsExtracted, 1)) * 100)}%)
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{statistics.authorCount}</div>
            <div className="stat-label">{t('corpus.authors')}</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{statistics.languageCount}</div>
            <div className="stat-label">{t('corpus.languages')}</div>
          </div>
        </div>

        {statistics.yearRange && (
          <div className="stat-info">
            <span className="stat-info-label">{t('corpus.period')}</span>
            <span className="stat-info-value">
              {statistics.yearRange.min} - {statistics.yearRange.max}
            </span>
          </div>
        )}

        {statistics.languages && statistics.languages.length > 0 && (
          <div className="stat-info">
            <span className="stat-info-label">{t('corpus.languages')}:</span>
            <span className="stat-info-value">
              {statistics.languages.join(', ')}
            </span>
          </div>
        )}
      </CollapsibleSection>

      {/* Textométrie */}
      <CollapsibleSection title={t('corpus.textometrics')} defaultExpanded={false}>
        <TextometricsPanel />
      </CollapsibleSection>

      {/* Topics */}
      <CollapsibleSection title={t('corpus.topicAnalysis')} defaultExpanded={false}>
        {!topicAnalysis ? (
          <div className="topics-empty">
            <p>{t('corpus.noTopicAnalysis')}</p>
            <div className="topics-config">
              <label>
                {t('corpus.numTopics')}
                <input
                  type="number"
                  min="2"
                  max="50"
                  value={numTopics}
                  onChange={(e) => setNumTopics(parseInt(e.target.value) || 10)}
                  className="topics-number-input"
                />
              </label>
            </div>
            <button onClick={loadTopics} disabled={loadingTopics} className="load-topics-btn">
              {loadingTopics ? t('corpus.analyzing') : t('corpus.analyzeTopics')}
            </button>
            <p className="topics-help">
              {t('corpus.topicHelp')}
            </p>
          </div>
        ) : (
          <div className="topics-list">
            <div className="topics-header">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span>{t('corpus.topicsIdentified', { count: topicAnalysis.topics?.length || 0 })}</span>
                {topicAnalysis.statistics && (
                  <span style={{ fontSize: '0.85em', color: '#666' }}>
                    {t('corpus.documentsAnalyzed', { analyzed: topicAnalysis.statistics.numDocumentsInTopics, total: topicAnalysis.statistics.totalDocuments })}
                    {topicAnalysis.statistics.numOutliers > 0 && (
                      <span style={{ marginLeft: '0.5rem' }}>
                        ({topicAnalysis.statistics.numOutliers} {t('corpus.outliers')})
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="topics-actions">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9em' }}>
                  {t('corpus.nbTopics')}
                  <input
                    type="number"
                    min="2"
                    max="50"
                    value={numTopics}
                    onChange={(e) => setNumTopics(parseInt(e.target.value) || 10)}
                    className="topics-number-input"
                    style={{ width: '60px' }}
                  />
                </label>
                <button onClick={loadTopics} disabled={loadingTopics} className="reload-topics-btn">
                  {loadingTopics ? t('corpus.analyzing') : t('corpus.reanalyze')}
                </button>
                <button onClick={exportTopicsAsJSON} className="export-btn" title="JSON">
                  📥 JSON
                </button>
                <button onClick={exportTopicsAsCSV} className="export-btn" title="CSV">
                  📥 CSV
                </button>
                <button onClick={exportTopicsAsMarkdown} className="export-btn" title="Markdown">
                  📥 MD
                </button>
              </div>
            </div>

            {/* Stream graph temporel des topics */}
            {topicTimeline && topicTimeline.length > 0 && (
              <div className="topic-timeline-section">
                <h4 style={{ margin: '10px 0', fontSize: '14px', fontWeight: 500 }}>
                  {t('corpus.topicTimeline')}
                </h4>
                <TopicTimeline timelineData={topicTimeline} topics={topicAnalysis.topics} />
              </div>
            )}

            {(topicAnalysis.topics || []).map((topic) => {
              const topicDocs = getDocumentsForTopic(topic.id);
              const isExpanded = expandedTopic === topic.id;

              return (
                <div
                  key={topic.id}
                  className={`topic-card ${filters.topic === topic.id ? 'topic-selected' : ''} ${isExpanded ? 'topic-expanded' : ''}`}
                >
                  <div
                    className="topic-header"
                    onClick={() => setFilters({ ...filters, topic: filters.topic === topic.id ? null : topic.id })}
                  >
                    <span className="topic-id">Topic {topic.id}</span>
                    <span className="topic-size">{topic.size} {t('corpus.topicDocuments')}</span>
                  </div>
                  <div className="topic-keywords">
                    {topic.keywords.slice(0, 5).map((keyword, idx) => (
                      <span key={idx} className="topic-keyword">
                        {keyword}
                      </span>
                    ))}
                  </div>
                  <button
                    className="topic-expand-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedTopic(isExpanded ? null : topic.id);
                    }}
                  >
                    {isExpanded ? `▼ ${t('corpus.hideDocuments')}` : `▶ ${t('corpus.showDocuments', { count: topicDocs.length })}`}
                  </button>

                  {isExpanded && (
                    <div className="topic-documents">
                      {topicDocs.map((doc) => (
                        <div key={doc.id} className="topic-document-item">
                          <span className="doc-title">{doc.metadata?.title || doc.label}</span>
                          {doc.metadata?.author && (
                            <span className="doc-author"> - {doc.metadata.author}</span>
                          )}
                          {doc.metadata?.year && (
                            <span className="doc-year"> ({doc.metadata.year})</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>

      {/* Graphe de connaissances */}
      <CollapsibleSection title={t('corpus.knowledgeGraph')} defaultExpanded={true}>
        <div className="graph-container">
          {/* Contrôles de regénération */}
          <div className="graph-controls" style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '10px', padding: '8px', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9em' }}>
              {t('corpus.similarityThreshold')}
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.05"
                value={graphSimilarityThreshold}
                onChange={(e) => setGraphSimilarityThreshold(parseFloat(e.target.value))}
                style={{ width: '100px' }}
              />
              <span style={{ minWidth: '40px' }}>{graphSimilarityThreshold.toFixed(2)}</span>
            </label>
            <button
              onClick={regenerateGraph}
              disabled={regeneratingGraph}
              className="reload-topics-btn"
              title={t('corpus.regenerateGraph')}
            >
              {regeneratingGraph ? t('corpus.regenerating') : t('corpus.regenerateGraph')}
            </button>
          </div>

          <div className="graph-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div className="graph-legend">
              <div className="legend-item">
                <span className="legend-color" style={{ backgroundColor: '#FF6B6B' }}></span>
                <span>{t('corpus.citations')}</span>
              </div>
              <div className="legend-item">
                <span className="legend-color" style={{ backgroundColor: '#50C878' }}></span>
                <span>{t('corpus.similarity')}</span>
              </div>
              <div className="legend-item">
                <span className="legend-color" style={{ backgroundColor: '#9B59B6' }}></span>
                <span>{t('corpus.coCitations')}</span>
              </div>
            </div>
            <button onClick={exportGraphAsGEXF} className="export-btn" title={t('corpus.exportGEXF')}>
              📥 {t('corpus.exportGEXF')}
            </button>
          </div>

          <div className="graph-visualization">
            <ForceGraph2D
              ref={graphRef}
              graphData={{
                nodes: graphData.nodes,
                links: graphData.edges, // ForceGraph2D expects 'links' not 'edges'
              }}
              nodeLabel={(node: any) => {
                const n = node as GraphNode;
                return n.metadata?.title || n.label;
              }}
              nodeColor={(node: any) => getNodeColor(node as GraphNode)}
              nodeVal={(node: any) => getNodeSize(node as GraphNode)}
              linkColor={(link: any) => getEdgeColor(link as GraphEdge)}
              linkWidth={(link: any) => {
                const edge = link as GraphEdge;
                return edge.weight || 1;
              }}
              linkDirectionalArrowLength={(link: any) => {
                const edge = link as GraphEdge;
                return edge.type === 'citation' ? 4 : 0; // Flèches uniquement pour citations
              }}
              linkDirectionalArrowRelPos={1}
              onNodeClick={handleNodeClick}
              enableNodeDrag={true}
              enableZoomPanInteraction={true}
              d3AlphaDecay={0.02}
              d3VelocityDecay={0.3}
            />
          </div>

          {selectedNode && (
            <div className="node-details">
              <h4>{t('corpus.nodeDetails')}</h4>
              <div className="node-info">
                <div className="node-info-row">
                  <span className="node-info-label">{t('corpus.nodeTitle')}</span>
                  <span className="node-info-value">
                    {selectedNode.metadata?.title || selectedNode.label}
                  </span>
                </div>
                {selectedNode.metadata?.author && (
                  <div className="node-info-row">
                    <span className="node-info-label">{t('corpus.nodeAuthor')}</span>
                    <span className="node-info-value">{selectedNode.metadata.author}</span>
                  </div>
                )}
                {selectedNode.metadata?.year && (
                  <div className="node-info-row">
                    <span className="node-info-label">{t('corpus.nodeYear')}</span>
                    <span className="node-info-value">{selectedNode.metadata.year}</span>
                  </div>
                )}
                {selectedNode.centrality !== undefined && (
                  <div className="node-info-row">
                    <span className="node-info-label">{t('corpus.nodeCentrality')}</span>
                    <span className="node-info-value">
                      {selectedNode.centrality.toFixed(2)}
                    </span>
                  </div>
                )}
                {selectedNode.community !== undefined && (
                  <div className="node-info-row">
                    <span className="node-info-label">{t('corpus.nodeCommunity')}</span>
                    <span className="node-info-value">{selectedNode.community}</span>
                  </div>
                )}
              </div>
              <button onClick={() => setSelectedNode(null)}>{t('corpus.close')}</button>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Info sur le graphe */}
      <div className="graph-info">
        <div className="graph-info-item">
          <span className="graph-info-label">{t('corpus.nodes')}</span>
          <span className="graph-info-value">{graphData.nodes.length}</span>
        </div>
        <div className="graph-info-item">
          <span className="graph-info-label">{t('corpus.links')}</span>
          <span className="graph-info-value">{graphData.edges.length}</span>
        </div>
      </div>
    </div>
  );
};
