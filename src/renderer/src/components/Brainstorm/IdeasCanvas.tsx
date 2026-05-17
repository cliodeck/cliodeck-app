/**
 * IdeasCanvas — free-form 2D board for spatial idea arrangement (A11.2).
 *
 * Cards can be dragged to any position. The canvas supports pan (shift+drag
 * or middle-mouse) and zoom (wheel). Positions are persisted in the idea store.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { useIdeaStore, type Idea } from '../../stores/ideaStore';
import { useProjectStore } from '../../stores/projectStore';
import './IdeasCanvas.css';

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const CARD_WIDTH = 200;
const CARD_HEIGHT = 120;

export const IdeasCanvas: React.FC = () => {
  const { t } = useTranslation('common');
  const ideas = useIdeaStore((s) => s.ideas);
  const selectedId = useIdeaStore((s) => s.selectedId);
  const setSelected = useIdeaStore((s) => s.setSelected);
  const updateIdea = useIdeaStore((s) => s.updateIdea);
  const addIdea = useIdeaStore((s) => s.addIdea);
  const saveIdeas = useIdeaStore((s) => s.saveIdeas);
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState<{
    type: 'card' | 'pan';
    ideaId?: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setView((v) => ({
      ...v,
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * delta)),
    }));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, ideaId?: string) => {
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        // Pan
        e.preventDefault();
        setDragging({
          type: 'pan',
          startX: e.clientX,
          startY: e.clientY,
          origX: view.x,
          origY: view.y,
        });
      } else if (e.button === 0 && ideaId) {
        // Drag card
        e.stopPropagation();
        const idea = ideas.find((i) => i.id === ideaId);
        if (!idea) return;
        setSelected(ideaId);
        setDragging({
          type: 'card',
          ideaId,
          startX: e.clientX,
          startY: e.clientY,
          origX: idea.position?.x ?? 0,
          origY: idea.position?.y ?? 0,
        });
      }
    },
    [view, ideas, setSelected]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;

      if (dragging.type === 'pan') {
        setView((v) => ({
          ...v,
          x: dragging.origX + dx,
          y: dragging.origY + dy,
        }));
      } else if (dragging.type === 'card' && dragging.ideaId) {
        const newX = dragging.origX + dx / view.scale;
        const newY = dragging.origY + dy / view.scale;
        updateIdea(dragging.ideaId, { position: { x: newX, y: newY } });
      }
    },
    [dragging, view.scale, updateIdea]
  );

  const handleMouseUp = useCallback(() => {
    if (dragging?.type === 'card' && projectPath) {
      saveIdeas(projectPath);
    }
    setDragging(null);
  }, [dragging, projectPath, saveIdeas]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === containerRef.current || (e.target as HTMLElement).classList.contains('ideas-canvas__surface')) {
        setSelected(null);
      }
    },
    [setSelected]
  );

  const handleCreateAtCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const cx = rect ? (rect.width / 2 - view.x) / view.scale : 100;
    const cy = rect ? (rect.height / 2 - view.y) / view.scale : 100;
    const id = addIdea({
      title: t('ideas.newIdeaTitle'),
      content: '',
      tags: [],
      links: [],
      origin: { type: 'manual' },
      position: { x: cx - CARD_WIDTH / 2, y: cy - CARD_HEIGHT / 2 },
    });
    setSelected(id);
    if (projectPath) saveIdeas(projectPath);
  }, [view, addIdea, setSelected, projectPath, saveIdeas, t]);

  const handleResetView = useCallback(() => {
    setView({ x: 0, y: 0, scale: 1 });
  }, []);

  const handleZoomIn = useCallback(() => {
    setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, v.scale * 1.2) }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setView((v) => ({ ...v, scale: Math.max(MIN_SCALE, v.scale * 0.8) }));
  }, []);

  // Auto-distribute ideas without positions on first render
  useEffect(() => {
    const unpositioned = ideas.filter((i) => !i.position);
    if (unpositioned.length === 0) return;
    const cols = Math.ceil(Math.sqrt(unpositioned.length));
    unpositioned.forEach((idea, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      updateIdea(idea.id, {
        position: { x: col * (CARD_WIDTH + 40) + 40, y: row * (CARD_HEIGHT + 40) + 40 },
      });
    });
    if (projectPath) saveIdeas(projectPath);
  }, []); // Only on mount

  return (
    <div
      ref={containerRef}
      className="ideas-canvas"
      onWheel={handleWheel}
      onMouseDown={(e) => handleMouseDown(e)}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleCanvasClick}
    >
      {/* Toolbar */}
      <div className="ideas-canvas__toolbar">
        <button onClick={handleCreateAtCenter} title={t('ideas.create')}>
          <Plus size={16} />
        </button>
        <button onClick={handleZoomIn} title="Zoom in">
          <ZoomIn size={16} />
        </button>
        <button onClick={handleZoomOut} title="Zoom out">
          <ZoomOut size={16} />
        </button>
        <button onClick={handleResetView} title="Reset view">
          <Maximize2 size={16} />
        </button>
        <span className="ideas-canvas__zoom-label">{Math.round(view.scale * 100)}%</span>
      </div>

      {/* Transformed surface */}
      <div
        className="ideas-canvas__surface"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {/* Links between ideas */}
        <svg className="ideas-canvas__links">
          {ideas.flatMap((idea) =>
            idea.links
              .filter((l) => l.targetType === 'idea')
              .map((link) => {
                const target = ideas.find((i) => i.id === link.targetId);
                if (!target || !idea.position || !target.position) return null;
                const x1 = idea.position.x + CARD_WIDTH / 2;
                const y1 = idea.position.y + CARD_HEIGHT / 2;
                const x2 = target.position.x + CARD_WIDTH / 2;
                const y2 = target.position.y + CARD_HEIGHT / 2;
                return (
                  <line
                    key={`${idea.id}-${link.targetId}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className="ideas-canvas__link-line"
                  />
                );
              })
          )}
        </svg>

        {/* Idea cards */}
        {ideas.map((idea) => (
          <IdeaCard
            key={idea.id}
            idea={idea}
            isSelected={idea.id === selectedId}
            onMouseDown={(e) => handleMouseDown(e, idea.id)}
          />
        ))}
      </div>

      {ideas.length === 0 && (
        <div className="ideas-canvas__empty">
          <p>{t('ideas.canvasEmpty')}</p>
        </div>
      )}
    </div>
  );
};

const IdeaCard: React.FC<{
  idea: Idea;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}> = ({ idea, isSelected, onMouseDown }) => {
  const x = idea.position?.x ?? 0;
  const y = idea.position?.y ?? 0;

  return (
    <div
      className={`ideas-canvas__card ${isSelected ? 'is-selected' : ''}`}
      style={{
        left: x,
        top: y,
        width: CARD_WIDTH,
        borderLeftColor: idea.color || undefined,
      }}
      onMouseDown={onMouseDown}
    >
      <div className="ideas-canvas__card-title">{idea.title}</div>
      {idea.content && (
        <div className="ideas-canvas__card-content">
          {idea.content.slice(0, 100)}
          {idea.content.length > 100 ? '...' : ''}
        </div>
      )}
      {idea.tags.length > 0 && (
        <div className="ideas-canvas__card-tags">
          {idea.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="ideas-canvas__card-tag">{tag}</span>
          ))}
          {idea.tags.length > 3 && <span>+{idea.tags.length - 3}</span>}
        </div>
      )}
    </div>
  );
};
