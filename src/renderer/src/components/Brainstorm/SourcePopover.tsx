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

import React, { useCallback, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { BrainstormSource } from '../../stores/brainstormChatStore';

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
  const w = window as unknown as { electron?: { sources?: SourcesApi } };
  return w.electron?.sources ?? null;
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleOpen = useCallback(async () => {
    const api = getSourcesApi();
    if (!api) {
      setError('Ouverture de sources indisponible (preload manquant).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let res: { success: boolean; error?: string };
      if (source.sourceType === 'secondary') {
        if (!source.documentId) {
          setError('Document PDF non traçable (documentId manquant).');
          setBusy(false);
          return;
        }
        res = await api.openPdf(source.documentId, source.pageNumber);
      } else if (source.sourceType === 'primary') {
        if (!source.itemId) {
          setError('Source Tropy non traçable (itemId manquant).');
          setBusy(false);
          return;
        }
        res = await api.revealTropy(source.itemId);
      } else {
        const rel = source.notePath ?? source.relativePath;
        if (!rel) {
          setError('Note Obsidian non traçable (chemin manquant).');
          setBusy(false);
          return;
        }
        res = await api.openNote(rel, source.lineNumber);
      }
      if (!res.success) setError(res.error ?? 'Échec de l’ouverture.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [source]);

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
          aria-label="Fermer"
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

      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="chat-surface__inline-btn"
          onClick={() => void handleOpen()}
          disabled={!canOpen || busy}
          data-testid="source-popover-open"
        >
          <ExternalLink size={12} /> {busy ? 'Ouverture…' : 'Ouvrir la source'}
        </button>
      </div>
    </div>
  );
};
