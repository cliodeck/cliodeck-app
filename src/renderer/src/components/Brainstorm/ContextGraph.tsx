/**
 * ContextGraph — lightweight knowledge-graph panel showing relationships
 * between documents retrieved in the current Brainstorm session.
 *
 * Updates whenever sources change (new chat turn). Shows document nodes
 * and citation/similarity edges between them.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore';

interface GraphNode {
  id: string;
  type: 'document' | 'author';
  label: string;
  metadata: Record<string, unknown>;
  x?: number;
  y?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: 'citation' | 'similarity' | 'co-citation';
  weight: number;
}

interface SubgraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const ContextGraph: React.FC = () => {
  const { t } = useTranslation();
  const messages = useChatStore((s) => s.messages);
  const [graph, setGraph] = useState<SubgraphData | null>(null);
  const [loading, setLoading] = useState(false);

  // Collect unique document IDs from all sources across the session
  useEffect(() => {
    const docIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.sources) {
        for (const src of msg.sources) {
          if (src.documentId) docIds.add(src.documentId);
        }
      }
    }

    if (docIds.size < 2) {
      setGraph(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    window.electron.corpus
      .getSubgraph(Array.from(docIds))
      .then((result: { success: boolean; graph?: SubgraphData }) => {
        if (!cancelled && result.success && result.graph) {
          setGraph(result.graph);
        }
      })
      .catch(() => { /* silent — graph is optional */ })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [messages]);

  if (!graph || graph.nodes.length < 2) return null;

  // Compute simple SVG layout from node positions
  const padding = 30;
  const width = 280;
  const height = 200;

  // Normalize positions into the SVG viewport
  const xs = graph.nodes.map((n) => n.x ?? 0);
  const ys = graph.nodes.map((n) => n.y ?? 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const nodePositions = graph.nodes.map((n) => ({
    ...n,
    cx: padding + ((n.x ?? 0) - minX) / rangeX * (width - 2 * padding),
    cy: padding + ((n.y ?? 0) - minY) / rangeY * (height - 2 * padding),
  }));

  const posMap = new Map(nodePositions.map((n) => [n.id, n]));

  const edgeTypeColor: Record<string, string> = {
    citation: 'var(--color-danger)',
    similarity: 'var(--color-success)',
    'co-citation': 'var(--color-accent)',
  };

  return (
    <details className="context-graph" open>
      <summary className="context-graph__summary">
        <Network size={12} />
        <span>
          {t('chat.brainstorm.contextGraph', { defaultValue: 'Source relations' })}
          {' '}({graph.nodes.length})
        </span>
        {loading && <span className="context-graph__loading" />}
      </summary>
      <svg
        className="context-graph__svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {/* Edges */}
        {graph.edges.map((e, i) => {
          const src = posMap.get(typeof e.source === 'string' ? e.source : '');
          const tgt = posMap.get(typeof e.target === 'string' ? e.target : '');
          if (!src || !tgt) return null;
          return (
            <line
              key={i}
              x1={src.cx}
              y1={src.cy}
              x2={tgt.cx}
              y2={tgt.cy}
              stroke={edgeTypeColor[e.type] ?? 'var(--border-color)'}
              strokeWidth={Math.max(1, e.weight * 2)}
              strokeOpacity={0.6}
            />
          );
        })}

        {/* Nodes */}
        {nodePositions.map((n) => (
          <g key={n.id}>
            <circle
              cx={n.cx}
              cy={n.cy}
              r={6}
              fill="var(--color-accent)"
              stroke="var(--bg-panel)"
              strokeWidth={1.5}
            />
            <title>{n.label}</title>
            <text
              x={n.cx}
              y={n.cy + 14}
              textAnchor="middle"
              className="context-graph__label"
            >
              {n.label.length > 20 ? n.label.slice(0, 18) + '…' : n.label}
            </text>
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div className="context-graph__legend">
        <span className="context-graph__legend-item">
          <span className="context-graph__legend-line" style={{ background: 'var(--color-danger)' }} />
          {t('chat.brainstorm.graphCitation', { defaultValue: 'Citation' })}
        </span>
        <span className="context-graph__legend-item">
          <span className="context-graph__legend-line" style={{ background: 'var(--color-success)' }} />
          {t('chat.brainstorm.graphSimilarity', { defaultValue: 'Similarity' })}
        </span>
      </div>
    </details>
  );
};
