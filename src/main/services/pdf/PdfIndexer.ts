/**
 * PdfIndexer — extracted from pdf-service.ts as part of the fusion
 * split (see CLAUDE.md §2). Builds and owns the lower-level
 * `backend/core/pdf/PDFIndexer`, wiring the embedding function to a
 * typed `EmbeddingProvider` (fusion 1.2e: the legacy
 * `LLMProviderManager.generateEmbedding` fallback was retired).
 * Kept intentionally thin; the PDF parsing / chunking itself still
 * lives in the backend indexer.
 */
import { PDFIndexer as BackendPDFIndexer, type IndexingProgress, type ExtractDocumentFn } from '../../../../backend/core/pdf/PDFIndexer.js';
import type { EmbeddingProvider } from '../../../../backend/core/llm/providers/base.js';
import type { PDFDocument } from '../../../../backend/types/pdf-document.js';
import type { RAGConfig } from '../../../../backend/types/config.js';
import type { VectorStore } from '../../../../backend/core/vector-store/VectorStore.js';
import type { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import { extractPdfIsolated } from '../pdf-extract-isolated.js';

export type { IndexingProgress };

type AnyVectorStore = VectorStore | EnhancedVectorStore;

// Matches the legacy summarizer object built in pdf-service.ts. Kept as
// a structural type to avoid exporting an internal shape from the
// backend indexer.
interface SummarizerConfigLike {
  enabled: boolean;
  method: 'abstractive' | 'extractive';
  maxLength: number;
  llmModel?: string;
}

export interface PdfIndexerDeps {
  vectorStore: AnyVectorStore;
  embeddingProvider: EmbeddingProvider;
  ragConfig: RAGConfig;
  summarizerConfig: SummarizerConfigLike;
}

export class PdfIndexer {
  private readonly backend: BackendPDFIndexer;
  private readonly vectorStore: AnyVectorStore;

  constructor(deps: PdfIndexerDeps) {
    this.vectorStore = deps.vectorStore;

    const embeddingFn = async (text: string): Promise<Float32Array> => {
      const [vec] = await deps.embeddingProvider.embed([text]);
      return Float32Array.from(vec);
    };

    // Wrap extractPdfIsolated as an ExtractDocumentFn that throws on failure
    // so BackendPDFIndexer's existing error handling catches it cleanly.
    const isolatedExtract: ExtractDocumentFn = async (filePath: string) => {
      const result = await extractPdfIsolated(filePath);
      if (result.ok === false) {
        throw new Error(result.error);
      }
      return { pages: result.pages, metadata: result.metadata, title: result.title };
    };

    this.backend = new BackendPDFIndexer(
      deps.vectorStore,
      embeddingFn,
      deps.ragConfig.chunkingConfig,
      deps.summarizerConfig,
      deps.ragConfig.useAdaptiveChunking !== false,
      deps.ragConfig,
      isolatedExtract
    );
  }

  async indexPDF(
    filePath: string,
    bibtexKey?: string,
    onProgress?: (progress: IndexingProgress) => void,
    bibliographyMetadata?: { title?: string; author?: string; year?: string },
    collectionKeys?: string[]
  ): Promise<PDFDocument> {
    const document = await this.backend.indexPDF(filePath, bibtexKey, onProgress, bibliographyMetadata);
    if (collectionKeys && collectionKeys.length > 0) {
      this.vectorStore.setDocumentCollections(document.id, collectionKeys);
      console.log(`📁 Linked document ${document.id.substring(0, 8)} to ${collectionKeys.length} collection(s)`);
    }
    return document;
  }
}
