import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSource } from '../../stores/chatStore';
import {
  type UnifiedSource,
  chatSourceToUnified,
  brainstormSourceToUnified,
} from '../../../../../backend/types/chat-source';
import './SourceCard.css';

/**
 * Structural shape of a Brainstorm source. Kept local to avoid importing
 * from the main-process `fusion-chat-service` (renderer must not cross
 * that boundary). Matches the `BrainstormSourceLike` interface used by
 * the adapter in `backend/types/chat-source.ts`.
 */
interface BrainstormSourceShape {
  kind: 'archive' | 'bibliographie' | 'note';
  sourceType: 'primary' | 'secondary' | 'vault';
  title: string;
  snippet: string;
  similarity: number;
  relativePath?: string;
  documentId?: string;
  pageNumber?: number;
  chunkOffset?: number;
  itemId?: string;
  imagePath?: string;
  notePath?: string;
  lineNumber?: number;
}

export type AnySource = ChatSource | BrainstormSourceShape | UnifiedSource;

interface SourceCardProps {
  source: AnySource;
  index: number;
}

/**
 * Normalise any supported source shape into a `UnifiedSource`. Pure and
 * render-safe: falls back to best-effort field mapping rather than ever
 * throwing so a malformed source never crashes the RAG extras panel.
 */
function normalise(src: AnySource): UnifiedSource {
  // Already unified (has `kind` in the UnifiedSourceKind set and an `id`).
  if (
    'id' in src &&
    typeof (src as UnifiedSource).id === 'string' &&
    ('kind' in src) &&
    ((src as UnifiedSource).kind === 'pdf' ||
      (src as UnifiedSource).kind === 'primary' ||
      (src as UnifiedSource).kind === 'secondary' ||
      (src as UnifiedSource).kind === 'vault')
  ) {
    return src as UnifiedSource;
  }
  // BrainstormSource: discriminated by the `sourceType` field (primary /
  // secondary / vault) combined with the absence of `documentTitle`.
  if ('sourceType' in src && 'snippet' in src) {
    return brainstormSourceToUnified(src as BrainstormSourceShape);
  }
  // Legacy ChatSource.
  return chatSourceToUnified(src as ChatSource);
}

export const SourceCard: React.FC<SourceCardProps> = React.memo(({ source, index }) => {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);

  const unified = normalise(source);

  const handleOpenPDF = async () => {
    const documentId = unified.documentId ?? unified.id;
    if (!documentId) return;
    try {
      const result = await window.electron.pdf.getDocument(documentId);
      if (result.success && result.document?.fileURL) {
        const openResult = await window.electron.shell.openPath(result.document.fileURL);
        if (!openResult.success) {
          console.error('Failed to open PDF:', openResult.error);
        }
      } else {
        console.error('Document not found:', documentId);
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
    }
  };

  const formatReference = (): string => {
    if (unified.author && unified.year) {
      return `${unified.author} (${unified.year})`;
    }
    return unified.title;
  };

  const formatSimilarity = (): string => {
    const score = unified.score ?? 0;
    return `${Math.round(score * 100)}%`;
  };

  const excerpt = unified.snippet ?? '';

  return (
    <div className="source-card">
      <div className="source-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="source-index">{t('chat.source')} {index}</div>
        <div className="source-info">
          <div className="source-title">{formatReference()}</div>
          <div className="source-meta">
            {unified.pageNumber !== undefined && (
              <>{t('chat.page')} {unified.pageNumber} • </>
            )}
            {t('chat.similarity')} {formatSimilarity()}
          </div>
        </div>
        <button className="source-expand-btn">
          {isExpanded ? '▼' : '▶'}
        </button>
      </div>

      {isExpanded && (
        <div className="source-content">
          <div className="source-excerpt">
            <div className="excerpt-label">{t('chat.excerpt')}</div>
            <p className="excerpt-text">{excerpt}</p>
          </div>
          <div className="source-actions">
            <button className="source-action-btn" onClick={handleOpenPDF}>
              📄 {t('chat.openPDF')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
