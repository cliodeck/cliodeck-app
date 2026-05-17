/**
 * Unified source-document types (fusion step 2.4a — Path A preparation).
 *
 * The ClioDeck vector store is historically PDF-centric: `PDFDocument`
 * carries `pageCount`, `DocumentChunk.pageNumber` is required, the SQLite
 * schema mirrors that. Path A of ADR 0001 calls for generalising this
 * surface so Obsidian notes / Zotero items / Tropy photos can share the
 * same VectorStore table without a parallel store.
 *
 * This module is the **type scaffold** for that rename, deliberately
 * additive: existing `PDFDocument` / `DocumentChunk` imports keep
 * compiling. A follow-up PR (guarded by the benchmark harness also
 * shipped this commit) swaps the vector-store schema and rewires
 * call sites.
 *
 * Widening rule: every new field is optional, every existing field is
 * preserved. A `PDFDocument` can be assigned to a `SourceDocument`
 * without change; a `SourceDocument` narrows to `PDFDocument` when
 * `sourceType` is `'pdf'` and `pageCount` is defined.
 */

import type { SourceType } from './source.js';
import type {
  DocumentChunk,
  PDFDocument,
  SearchResult,
} from './pdf-document.js';

/**
 * Discriminator for documents backed by different source types.
 *
 * `'pdf'` — the legacy variant, equivalent to `PDFDocument`.
 * Other variants cover the new sources introduced by the fusion:
 *   `'obsidian-note'` — a Markdown note from an Obsidian vault.
 *   `'zotero'` — a Zotero attachment or metadata record.
 *   `'tropy'` — a Tropy primary-source item.
 *   `'file'` / `'folder'` — generic filesystem sources.
 */
export type DocumentSourceType = SourceType | 'pdf';

/**
 * Generalised document record stored in the vector store. A `PDFDocument`
 * is structurally a `SourceDocument` with `sourceType: 'pdf'`. Fields
 * specific to PDFs (pageCount, citationsExtracted) remain optional so
 * other sources don't need to synthesise them.
 */
export interface SourceDocument {
  id: string;
  fileURL: string;
  title: string;
  author?: string;
  year?: string;
  bibtexKey?: string;
  /** Discriminator. When absent the vector store treats it as `'pdf'`. */
  sourceType?: DocumentSourceType;
  /** Optional source-specific ref (Zotero itemKey, Tropy itemId, vault relpath). */
  sourceRef?: string;
  /** Extension / format hint (pdf / md / jpg / tif …). */
  fileFormat?: string;
  pageCount?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date | string;
  indexedAt: Date | string;
  lastAccessedAt?: Date | string;

  // Nouveaux champs enrichis (preserved from PDFDocument).
  summary?: string;
  summaryEmbedding?: Float32Array;
  language?: string;
}

/**
 * Generalised chunk record. `pageNumber` is now optional — Obsidian notes
 * and generic files don't have pages. `sectionTitle` / `sectionType` cover
 * the structural equivalent for Markdown.
 */
export interface SourceChunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  /** Optional — absent for non-paginated sources. */
  pageNumber?: number;
  startPosition: number;
  endPosition: number;
  sectionTitle?: string;
  sectionType?: string;
  metadata?: Record<string, unknown>;
}

/** Narrowing helper: true if the document is a legitimate PDF. */
export function isPDFSource(doc: SourceDocument): boolean {
  return (doc.sourceType ?? 'pdf') === 'pdf';
}

/** Widening helper: lift an existing `PDFDocument` into a `SourceDocument`. */
export function fromPDFDocument(p: PDFDocument): SourceDocument {
  return {
    id: p.id,
    fileURL: p.fileURL,
    title: p.title,
    author: p.author,
    year: p.year,
    bibtexKey: p.bibtexKey,
    sourceType: 'pdf',
    sourceRef: undefined,
    fileFormat: 'pdf',
    pageCount: p.pageCount,
    metadata: p.metadata as unknown as Record<string, unknown>,
    createdAt: p.createdAt,
    indexedAt: p.indexedAt,
    lastAccessedAt: p.lastAccessedAt,
    summary: p.summary,
    summaryEmbedding: p.summaryEmbedding,
    language: p.language,
  };
}

/**
 * Narrowing helper: project a `SourceDocument` back to a `PDFDocument`
 * shape. Throws when the document isn't actually a PDF — callers on the
 * legacy code path should check `isPDFSource` first.
 */
export function toPDFDocument(doc: SourceDocument): PDFDocument {
  if (!isPDFSource(doc)) {
    throw new Error(
      `toPDFDocument: document ${doc.id} is not a PDF (sourceType=${doc.sourceType ?? 'pdf'})`
    );
  }
  const out = {
    id: doc.id,
    fileURL: doc.fileURL,
    title: doc.title,
    author: doc.author,
    year: doc.year,
    bibtexKey: doc.bibtexKey,
    pageCount: doc.pageCount ?? 0,
    metadata: doc.metadata ?? {},
    createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt),
    indexedAt: doc.indexedAt instanceof Date ? doc.indexedAt : new Date(doc.indexedAt),
    lastAccessedAt:
      doc.lastAccessedAt instanceof Date
        ? doc.lastAccessedAt
        : doc.lastAccessedAt
          ? new Date(doc.lastAccessedAt)
          : new Date(),
    summary: doc.summary,
    summaryEmbedding: doc.summaryEmbedding,
    language: doc.language,
    get displayString() {
      return `${this.author ?? ''} ${this.year ?? ''} ${this.title}`.trim();
    },
  } as PDFDocument;
  return out;
}

/** Widen a `DocumentChunk` (page-centric) into a `SourceChunk`. */
export function fromDocumentChunk(c: DocumentChunk): SourceChunk {
  return {
    id: c.id,
    documentId: c.documentId,
    content: c.content,
    chunkIndex: c.chunkIndex,
    pageNumber: c.pageNumber,
    startPosition: c.startPosition,
    endPosition: c.endPosition,
    sectionTitle: c.metadata?.sectionTitle,
    sectionType: c.metadata?.sectionType,
    metadata: c.metadata as unknown as Record<string, unknown>,
  };
}

/**
 * Generalised search result for the RAG benchmark and future unified
 * pipeline. `SearchResult` (pdf-document.ts) narrows this when the chunk
 * carries a page number and the document is a PDF.
 */
export interface UnifiedSearchResult {
  chunk: SourceChunk;
  document: SourceDocument;
  similarity: number;
}

export function fromSearchResult(r: SearchResult): UnifiedSearchResult {
  return {
    chunk: fromDocumentChunk(r.chunk),
    document: fromPDFDocument(r.document),
    similarity: r.similarity,
  };
}
