/**
 * IdeasGraph — force-directed graph of ideas and their links.
 *
 * Displays ideas as nodes, links between ideas as edges, and optionally
 * shows connected citations. Clicking a node selects the idea in the store.
 */

import React, { useMemo, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { useIdeaStore } from '../../stores/ideaStore';

interface GraphNode {
  id: string;
  label: string;
  type: 'idea' | 'citation';
  color: string;
  tags: string[];
}

interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export const IdeasGraph: React.FC<{ width?: number; height?: number }> = ({
  width = 600,
  height = 400,
}) => {
  const ideas = useIdeaStore((s) => s.ideas);
  const setSelected = useIdeaStore((s) => s.setSelected);

  const graphData = useMemo((): GraphData => {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const citationNodes = new Set<string>();

    for (const idea of ideas) {
      nodes.push({
        id: idea.id,
        label: idea.title,
        type: 'idea',
        color: idea.color || 'var(--color-accent)',
        tags: idea.tags,
      });

      for (const link of idea.links) {
        links.push({
          source: idea.id,
          target: link.targetId,
          label: link.label,
        });

        // Add citation nodes if not already an idea
        if (link.targetType === 'citation' && !citationNodes.has(link.targetId)) {
          citationNodes.add(link.targetId);
          nodes.push({
            id: link.targetId,
            label: link.targetId,
            type: 'citation',
            color: 'var(--text-tertiary)',
            tags: [],
          });
        }
      }
    }

    return { nodes, links };
  }, [ideas]);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.type === 'idea') {
        setSelected(node.id);
      }
    },
    [setSelected]
  );

  const nodeCanvasObject = useCallback(
    (node: GraphNode & { x?: number; y?: number }, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const size = node.type === 'idea' ? 6 : 4;

      // Draw circle
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      ctx.fillStyle = node.type === 'idea' ? '#6366f1' : '#9ca3af';
      ctx.fill();

      // Draw label
      ctx.font = '3px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#e2e8f0';
      const label = node.label.length > 20 ? node.label.slice(0, 20) + '…' : node.label;
      ctx.fillText(label, x, y + size + 2);
    },
    []
  );

  if (ideas.length === 0) {
    return null;
  }

  return (
    <div className="ideas-graph">
      <ForceGraph2D
        graphData={graphData}
        width={width}
        height={height}
        nodeCanvasObject={nodeCanvasObject}
        onNodeClick={handleNodeClick}
        linkColor={() => 'rgba(148, 163, 184, 0.4)'}
        linkWidth={1}
        cooldownTicks={60}
        enableZoomInteraction={true}
        enablePanInteraction={true}
      />
    </div>
  );
};
