import React from 'react';
import { useTranslation } from 'react-i18next';
import ForceGraph2DImpl from 'react-force-graph-2d';
import type { GraphData, GraphNode, GraphEdge } from './corpus-types';

// react-force-graph-2d's generic types are unwieldy; cast to a plain FC.
// Our own GraphNode/GraphEdge handlers are already annotated.
const ForceGraph2D = ForceGraph2DImpl as unknown as React.FC<Record<string, unknown>>;

interface Props {
  graphData: GraphData;
  graphRef: React.MutableRefObject<unknown>;
  selectedNode: GraphNode | null;
  setSelectedNode: (n: GraphNode | null) => void;
  graphSimilarityThreshold: number;
  setGraphSimilarityThreshold: (v: number) => void;
  regeneratingGraph: boolean;
  onRegenerateGraph: () => void;
  onExportGEXF: () => void;
}

function getNodeColor(node: GraphNode): string {
  if (node.type === 'author') return 'var(--color-warning, #FFB84D)';
  if (node.community !== undefined) {
    const colors = ['#4A90E2', '#50C878', '#FF6B6B', '#9B59B6', '#F4A460'];
    return colors[node.community % colors.length];
  }
  return 'var(--color-accent, #4A90E2)';
}

function getNodeSize(node: GraphNode): number {
  if (node.centrality !== undefined) {
    return Math.max(4, Math.min(12, 4 + node.centrality * 2));
  }
  return 6;
}

function getEdgeColor(edge: GraphEdge): string {
  switch (edge.type) {
    case 'citation':
      return '#FF6B6B';
    case 'similarity':
      return '#50C878';
    case 'co-citation':
      return '#9B59B6';
    default:
      return '#CCCCCC';
  }
}

export const CorpusGraphSection: React.FC<Props> = ({
  graphData,
  graphRef,
  selectedNode,
  setSelectedNode,
  graphSimilarityThreshold,
  setGraphSimilarityThreshold,
  regeneratingGraph,
  onRegenerateGraph,
  onExportGEXF,
}) => {
  const { t } = useTranslation();

  return (
    <div className="graph-container">
      <div
        className="graph-controls"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          marginBottom: '10px',
          padding: '8px',
          backgroundColor: 'var(--bg-panel)',
          borderRadius: '4px',
        }}
      >
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
          onClick={onRegenerateGraph}
          disabled={regeneratingGraph}
          className="reload-topics-btn"
          title={t('corpus.regenerateGraph')}
        >
          {regeneratingGraph ? t('corpus.regenerating') : t('corpus.regenerateGraph')}
        </button>
      </div>

      <div
        className="graph-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}
      >
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
        <button onClick={onExportGEXF} className="export-btn" title={t('corpus.exportGEXF')}>
          {t('corpus.exportGEXF')}
        </button>
      </div>

      <div className="graph-visualization">
        <ForceGraph2D
          ref={graphRef}
          graphData={{
            nodes: graphData.nodes,
            links: graphData.edges,
          }}
          nodeLabel={(node: Record<string, unknown>) => {
            const n = node as unknown as GraphNode;
            return n.metadata?.title || n.label;
          }}
          nodeColor={(node: Record<string, unknown>) => getNodeColor(node as unknown as GraphNode)}
          nodeVal={(node: Record<string, unknown>) => getNodeSize(node as unknown as GraphNode)}
          linkColor={(link: Record<string, unknown>) => getEdgeColor(link as unknown as GraphEdge)}
          linkWidth={(link: Record<string, unknown>) => {
            const edge = link as unknown as GraphEdge;
            return edge.weight || 1;
          }}
          linkDirectionalArrowLength={(link: Record<string, unknown>) => {
            const edge = link as unknown as GraphEdge;
            return edge.type === 'citation' ? 4 : 0;
          }}
          linkDirectionalArrowRelPos={1}
          onNodeClick={(node: Record<string, unknown>) => setSelectedNode(node as unknown as GraphNode)}
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
                <span className="node-info-value">{selectedNode.centrality.toFixed(2)}</span>
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
  );
};
