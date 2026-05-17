/**
 * SourcePopover — click-through for a single Brainstorm RAG source.
 *
 * Academic trust requires every citation to be *reachable*: the user
 * must be able to jump from a chunk shown in Brainstorm back to the
 * primary/secondary/vault document it came from. This popover is the
 * minimal UI surface that turns an opaque similarity hit into an
 * openable reference.
 *
 * The component is purely presentational — it reads a `BrainstormSource`
 * and dispatches one of three `window.electron.sources.*` IPCs. Errors
 * surface as a small inline banner (no global toast system yet).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Lightbulb, X } from 'lucide-react';
import type { BrainstormSource } from '../../stores/chatStore';
import { useIdeaStore } from '../../stores/ideaStore';

interface Props {
  source: BrainstormSource;
  onClose: () => void;
}

interface SourcesApi {
  openPdf: (documentId: string, pageNumber?: number) => Promise<{ success: boolean; error?: string }>;
  revealTropy: (itemId: string) => Promise<{ success: boolean; error?: string }>;
  openNote: (relativePath: string, lineNumber?: number) => Promise<{ success: boolean; error?: string }>;
}

function getSourcesApi(): SourcesApi | null {
  return (window.electron?.sources as SourcesApi | undefined) ?? null;
}

export function positionLabel(s: BrainstormSource): string | null {
  if (s.sourceType === 'secondary') {
    if (s.pageNumber != null) {
      return s.chunkOffset != null
        ? `page ${s.pageNumber} · offset ${s.chunkOffset}`
        : `page ${s.pageNumber}`;
    }
    return null;
  }
  if (s.sourceType === 'vault') {
    const rel = s.notePath ?? s.relativePath;
    if (!rel) return null;
    return s.lineNumber != null ? `${rel} · L${s.lineNumber}` : rel;
  }
  if (s.sourceType === 'primary') {
    return s.itemId ? `item #${s.itemId}` : null;
  }
  return null;
}

export const SourcePopover: React.FC<Props> = ({ source, onClose }) => {
  const { t } = useTranslation('common');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleOpen = useCallback(async () => {
    const api = getSourcesApi();
    if (!api) {
      setError(t('chat.sources.openUnavailable'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let res: { success: boolean; error?: string };
      if (source.sourceType === 'secondary') {
        if (!source.documentId) {
          setError(t('chat.sources.untrackablePdf'));
          setBusy(false);
          return;
        }
        res = await api.openPdf(source.documentId, source.pageNumber);
      } else if (source.sourceType === 'primary') {
        if (!source.itemId) {
          setError(t('chat.sources.untrackableTropy'));
          setBusy(false);
          return;
        }
        res = await api.revealTropy(source.itemId);
      } else {
        const rel = source.notePath ?? source.relativePath;
        if (!rel) {
          setError(t('chat.sources.untrackableNote'));
          setBusy(false);
          return;
        }
        res = await api.openNote(rel, source.lineNumber);
      }
      if (!res.success) setError(res.error ?? t('chat.sources.openFailed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [source, t]);

  const position = positionLabel(source);
  const canOpen =
    (source.sourceType === 'secondary' && !!source.documentId) ||
    (source.sourceType === 'primary' && !!source.itemId) ||
    (source.sourceType === 'vault' && !!(source.notePath ?? source.relativePath));

  return (
    <div
      className="source-popover"
      role="dialog"
      aria-label={`Source: ${source.title}`}
      data-testid="source-popover"
      style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        padding: 12,
        color: 'var(--text-primary)',
        maxWidth: 480,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{source.kind}</div>
          <strong>{source.title}</strong>
          {position && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {position}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('chat.sources.close')}
          style={{ background: 'transparent', border: 0, color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          <X size={14} />
        </button>
      </div>

      <p
        style={{
          marginTop: 10,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-primary)',
          background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
          padding: 8,
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
        }}
      >
        {source.snippet}
      </p>

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--color-danger)',
            background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
            padding: 6,
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}

      <RelatedIdeas source={source} />

      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="chat-surface__inline-btn"
          onClick={() => void handleOpen()}
          disabled={!canOpen || busy}
          data-testid="source-popover-open"
        >
          <ExternalLink size={12} /> {busy ? t('chat.sources.opening') : t('chat.sources.open')}
        </button>
      </div>
    </div>
  );
};

/**
 * Shows ideas that share tags with or link to the given source (A11.4).
 */
const RelatedIdeas: React.FC<{ source: BrainstormSource }> = ({ source }) => {
  const { t } = useTranslation('common');
  const ideas = useIdeaStore((s) => s.ideas);
  const setSelected = useIdeaStore((s) => s.setSelected);

  const relatedIdeas = useMemo(() => {
    if (ideas.length === 0) return [];
    const titleWords = source.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const docId = source.documentId ?? source.itemId ?? '';

    return ideas.filter((idea) => {
      // Check if idea links to this source document
      if (docId && idea.links.some((l) => l.targetId === docId)) return true;
      // Check if idea tags overlap with source title words
      if (idea.tags.some((tag) => titleWords.includes(tag.toLowerCase()))) return true;
      return false;
    }).slice(0, 5);
  }, [ideas, source]);

  if (relatedIdeas.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 10,
        fontSize: 12,
        borderTop: '1px solid var(--border-color)',
        paddingTop: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-tertiary)', marginBottom: 4 }}>
        <Lightbulb size={12} />
        <span>{t('ideas.relatedIdeas')}</span>
      </div>
      {relatedIdeas.map((idea) => (
        <button
          key={idea.id}
          type="button"
          onClick={() => setSelected(idea.id)}
          style={{
            display: 'block',
            background: 'transparent',
            border: 0,
            color: 'var(--color-accent)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '2px 0',
            textAlign: 'left',
          }}
        >
          {idea.title}
          {idea.tags.length > 0 && (
            <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>
              {idea.tags.slice(0, 2).map((t) => `#${t}`).join(' ')}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};
