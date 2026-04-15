/**
 * Unified chat source / message types (fusion step 1).
 *
 * Superset of the legacy `ChatSource` (PDF-centric, used by the RAG chat)
 * and the Brainstorm `BrainstormSource` (multi-origin: primary / secondary
 * / vault). The two per-surface types are NOT removed yet — each adapts
 * down from/to `UnifiedSource` at the boundary so stores and IPC shapes
 * are unchanged this step.
 *
 * Back-compat guarantees:
 *  - Nothing in here is used on the wire yet.
 *  - Every field except `kind`, `id`, `title` is optional.
 *  - Adapters are pure and importable from main or renderer.
 */

/**
 * RAG Explainable-AI payload. Mirrors the renderer `RAGExplanation`
 * interface from `src/renderer/src/stores/chatStore.ts` so both surfaces
 * can attach it to a unified message without crossing a renderer→main
 * import boundary. Keep in sync with that file until the legacy store is
 * retired (fusion step 5).
 */
export interface RAGExplanation {
  search: {
    query: string;
    totalResults: number;
    searchDurationMs: number;
    cacheHit: boolean;
    sourceType: 'primary' | 'secondary' | 'both';
    documents: Array<{
      title: string;
      similarity: number;
      sourceType: string;
      chunkCount: number;
    }>;
  };
  compression?: {
    enabled: boolean;
    originalChunks: number;
    finalChunks: number;
    originalSize: number;
    finalSize: number;
    reductionPercent: number;
    strategy?: string;
  };
  graph?: {
    enabled: boolean;
    relatedDocsFound: number;
    documentTitles: string[];
  };
  llm: {
    provider: string;
    model: string;
    contextWindow: number;
    temperature: number;
    promptSize: number;
  };
  timing: {
    searchMs: number;
    compressionMs?: number;
    generationMs: number;
    totalMs: number;
  };
}

/**
 * Discriminant for a unified retrieval hit. Legacy PDFs arrive as
 * `'pdf'` from the RAG chat; Brainstorm emits `'secondary'` for the same
 * underlying corpus. Both are preserved: `'pdf'` is treated as an alias
 * of `'secondary'` by consumers that only care about the bibliography /
 * archive / note split.
 */
export type UnifiedSourceKind = 'pdf' | 'primary' | 'secondary' | 'vault';

export interface UnifiedSource {
  kind: UnifiedSourceKind;
  id: string;
  title: string;
  snippet?: string;
  /** Similarity / score (0..1 cosine for most retrievers). */
  score?: number;

  // --- Bibliographic -----------------------------------------------------
  author?: string;
  year?: string;

  // --- Traceability (best-effort; every field optional) ------------------
  /** PDF document id (matches `pdfService.getDocument`). */
  documentId?: string;
  /** 1-based page number (PDFs only). */
  pageNumber?: number;
  /** Start character offset of the chunk within the page's text. */
  chunkOffset?: number;
  /** Tropy item id (primary sources only). */
  itemId?: string;
  /** First photo path associated with the Tropy item, if known. */
  imagePath?: string;
  /** Obsidian vault-relative note path. */
  notePath?: string;
  /** 1-based line anchor within the note, if computable. */
  lineNumber?: number;

  /** Explainable-AI payload, when the caller computed one. */
  explanation?: RAGExplanation;
}

// -----------------------------------------------------------------------------
// Adapters
// -----------------------------------------------------------------------------
//
// We duplicate the shapes of the per-surface source types here (structural
// typing) rather than importing them, to keep this module usable from both
// `src/main/` and `backend/` without pulling the renderer tree in.

interface BrainstormSourceLike {
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

interface ChatSourceLike {
  documentId: string;
  documentTitle: string;
  author?: string;
  year?: string;
  pageNumber: number;
  chunkContent: string;
  similarity: number;
}

/**
 * Lift a Brainstorm source into the unified shape. Preserves every known
 * traceability field; picks `id` from the most specific handle available
 * for each kind.
 */
export function brainstormSourceToUnified(src: BrainstormSourceLike): UnifiedSource {
  const id =
    src.sourceType === 'primary'
      ? (src.itemId ?? src.documentId ?? src.title)
      : src.sourceType === 'vault'
        ? (src.notePath ?? src.relativePath ?? src.title)
        : (src.documentId ?? src.title);

  return {
    kind: src.sourceType,
    id,
    title: src.title,
    snippet: src.snippet,
    score: src.similarity,
    documentId: src.documentId,
    pageNumber: src.pageNumber,
    chunkOffset: src.chunkOffset,
    itemId: src.itemId,
    imagePath: src.imagePath,
    notePath: src.notePath ?? src.relativePath,
    lineNumber: src.lineNumber,
  };
}

/**
 * Lift a legacy PDF-centric `ChatSource` into the unified shape. PDFs are
 * bibliography entries, hence `kind: 'pdf'` (alias of `'secondary'`).
 */
export function chatSourceToUnified(src: ChatSourceLike): UnifiedSource {
  return {
    kind: 'pdf',
    id: src.documentId,
    title: src.documentTitle,
    snippet: src.chunkContent,
    score: src.similarity,
    author: src.author,
    year: src.year,
    documentId: src.documentId,
    pageNumber: src.pageNumber,
  };
}
