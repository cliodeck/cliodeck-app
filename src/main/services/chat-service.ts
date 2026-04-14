import { LRUCache } from 'lru-cache';
import { pdfService } from './pdf-service.js';
import { configManager } from './config-manager.js';
import { BrowserWindow } from 'electron';
import { historyService } from './history-service.js';
import { ContextCompressor } from '../../../backend/core/rag/ContextCompressor.js';
import { getSystemPrompt } from '../../../backend/core/llm/SystemPrompts.js';
import type { PDFDocument, SearchResult } from '../../../backend/types/pdf-document.js';

// ---- Local types for RAG search results ----
// These represent the enriched search results returned by pdfService.search(),
// which may include both secondary (PDF) and primary (Tropy) sources with
// additional fields beyond the base SearchResult type.

/** Minimal document shape as it appears in RAG search results (may be partial after compression). */
interface RAGDocumentInfo {
  id: string | undefined;
  title: string | undefined;
  author?: string;
  year?: string | number;
  summary?: string;
  bibtexKey?: string | null;
}

/** Minimal chunk shape as it appears in RAG search results (may be partial after compression). */
interface RAGChunkInfo {
  id?: string;
  content: string;
  pageNumber?: number;
  documentId?: string;
  chunkIndex?: number;
}

/** A single search result from the RAG pipeline (pdfService.search + compression + graph enrichment). */
interface RAGSearchResult {
  document: RAGDocumentInfo;
  chunk: RAGChunkInfo;
  similarity: number;
  sourceType?: 'primary' | 'secondary' | 'vault';
  isRelatedDoc?: boolean;
  source?: unknown;
}

/** Shape of the document map entries used when building the RAG explanation. */
interface ExplanationDocumentEntry {
  title: string;
  similarity: number;
  sourceType: 'primary' | 'secondary' | 'vault';
  chunkCount: number;
}

// Options enrichies pour le RAG
interface EnrichedRAGOptions {
  context?: boolean;              // Activer le RAG
  useGraphContext?: boolean;      // Utiliser le graphe de connaissances
  includeSummaries?: boolean;     // Utiliser résumés au lieu de chunks
  topK?: number;                  // Nombre de résultats de recherche
  additionalGraphDocs?: number;   // Nombre de documents liés à inclure
  window?: BrowserWindow;         // Fenêtre pour streaming

  // Source type selection (primary = Tropy archives, secondary = PDFs, both = all)
  sourceType?: 'secondary' | 'primary' | 'both';

  // Document filtering (Issue #16: filter RAG search by specific document IDs)
  documentIds?: string[];         // Document IDs to search in (if empty, search all)

  // Collection filtering (filter RAG search by Zotero collections)
  collectionKeys?: string[];      // Zotero collection keys to filter by

  // Provider selection
  provider?: 'ollama' | 'embedded' | 'auto';  // LLM provider to use

  // Per-query parameters
  model?: string;                 // Override chat model
  timeout?: number;               // Timeout in milliseconds
  numCtx?: number;                // Context window size in tokens (Ollama num_ctx)
  temperature?: number;           // LLM temperature
  top_p?: number;                 // LLM top_p
  top_k?: number;                 // LLM top_k
  repeat_penalty?: number;        // LLM repeat penalty

  // System prompt configuration (Phase 2.3)
  systemPromptLanguage?: 'fr' | 'en';    // Language for default prompt
  useCustomSystemPrompt?: boolean;       // Use custom prompt
  customSystemPrompt?: string;           // Custom system prompt text

  // Context compression
  enableContextCompression?: boolean;    // Enable context compression (default: true)

  // Mode tracking
  modeId?: string;                      // Active mode ID for history logging
  noSystemPrompt?: boolean;             // Free mode: skip system prompt entirely
}

// Type pour l'explication du RAG (Explainable AI)
export interface RAGExplanationContext {
  // Recherche
  search: {
    query: string;
    totalResults: number;
    searchDurationMs: number;
    cacheHit: boolean;
    sourceType: 'primary' | 'secondary' | 'both';
    documents: Array<{
      title: string;
      similarity: number;
      sourceType: 'primary' | 'secondary' | 'vault';
      chunkCount: number;
    }>;
    boosting?: {
      exactMatchCount: number;
      keywords: string[];
    };
  };
  // Compression
  compression?: {
    enabled: boolean;
    originalChunks: number;
    finalChunks: number;
    originalSize: number;
    finalSize: number;
    reductionPercent: number;
    strategy?: string;
  };
  // Graphe de connaissances
  graph?: {
    enabled: boolean;
    relatedDocsFound: number;
    documentTitles: string[];
  };
  // Configuration LLM
  llm: {
    provider: string;
    model: string;
    contextWindow: number;
    temperature: number;
    promptSize: number;
  };
  // Timing
  timing: {
    searchMs: number;
    compressionMs?: number;
    generationMs: number;
    totalMs: number;
  };
}

// Fonction utilitaire pour hasher une chaîne (identifier les questions identiques)
function hashString(str: string): string {
  let hash = 0;
  const normalized = str.toLowerCase().trim();
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// Fonction utilitaire pour calculer la similarité cosinus entre deux vecteurs
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/** Internal result from performRAGSearch */
interface RAGSearchOutput {
  searchResults: RAGSearchResult[];
  relatedDocuments: PDFDocument[];
  searchDurationMs: number;
  cacheHit: boolean;
}

/** Internal result from compressContext */
interface CompressionOutput {
  searchResults: RAGSearchResult[];
  compressionStats: RAGExplanationContext['compression'] | undefined;
  compressionDurationMs: number;
}

/** Internal result from generateResponse */
interface GenerationOutput {
  fullResponse: string;
  promptSize: number;
  generationDurationMs: number;
}

class ChatService {
  private currentStream: AsyncGenerator<string> | null = null;
  private compressor: ContextCompressor = new ContextCompressor();

  /**
   * Optional typed LLM provider (fusion 1.4h). When set, `generateResponse`
   * streams through `llm.chat()` using a plain system+user message shape
   * (sources formatted inside the user turn) instead of
   * `LLMProviderManager.generateWithSources`. Keeps all the legacy RAG
   * logging and citation extraction around it; only the token-producing
   * call changes. When unset, the legacy path runs exactly as before.
   *
   * Migration note: the main renderer chat UI still uses the legacy
   * path; the fusion Brainstorm mode has its own `fusion-chat-service`
   * wired to the registry. This setter exists so a future IPC handler
   * can route the main chat through the registry too, once the
   * workspace-level provider selection UI is in place.
   */
  private llm:
    | import('../../../backend/core/llm/providers/base').LLMProvider
    | null = null;

  setLLMProvider(
    llm:
      | import('../../../backend/core/llm/providers/base').LLMProvider
      | null
  ): void {
    this.llm = llm;
  }

  // LRU Cache for RAG search results (cache identical queries)
  // OPTIMIZED: Increased capacity (100->200) and TTL (10->30 minutes)
  private ragCache = new LRUCache<string, RAGSearchResult[]>({
    max: 200, // Store up to 200 different queries
    ttl: 1000 * 60 * 30, // 30 minutes TTL
    updateAgeOnGet: true, // Refresh TTL on access
  });

  /**
   * Convertit les résultats de recherche en utilisant les résumés au lieu des chunks
   * Si les résumés ne sont pas disponibles, retourne les chunks originaux
   */
  private convertChunksToSummaries(searchResults: RAGSearchResult[]): RAGSearchResult[] {
    const summaryResults: RAGSearchResult[] = [];
    const seenDocuments = new Set<string>();
    let summariesFound = 0;

    for (const result of searchResults) {
      const docId = result.document.id;

      // Éviter les doublons (un résumé par document)
      if (seenDocuments.has(docId)) {
        continue;
      }

      if (result.document.summary) {
        seenDocuments.add(docId);
        summariesFound++;
        summaryResults.push({
          document: result.document,
          chunk: {
            content: result.document.summary,
            pageNumber: 1
          },
          similarity: result.similarity
        });
      }
    }

    // Fallback: if no summaries available, return original chunks
    if (summaryResults.length === 0 && searchResults.length > 0) {
      console.warn('⚠️  No document summaries found. Falling back to original chunks.');
      console.warn('⚠️  To use summaries, re-index your documents with summary generation enabled.');
      return searchResults;
    }

    console.log(`📝 Using summaries: ${summariesFound} documents with summaries found`);
    return summaryResults;
  }

  /**
   * Récupère les documents liés via le graphe de connaissances
   */
  private async getRelatedDocumentsFromGraph(
    documentIds: string[],
    limit: number = 3
  ): Promise<Set<string>> {
    const relatedDocs = new Set<string>();
    const vectorStore = pdfService.getVectorStore();

    if (!vectorStore) {
      return relatedDocs;
    }

    for (const docId of documentIds) {
      // Récupérer documents cités par ce document
      const citedDocs = vectorStore.getDocumentsCitedBy(docId);
      citedDocs.slice(0, Math.ceil(limit / 2)).forEach(id => relatedDocs.add(id));

      // Récupérer documents qui citent ce document
      const citingDocs = vectorStore.getDocumentsCiting(docId);
      citingDocs.slice(0, Math.ceil(limit / 2)).forEach(id => relatedDocs.add(id));

      // Récupérer documents similaires
      const similarDocs = vectorStore.getSimilarDocuments(docId, 0.7, limit);
      similarDocs.forEach(({ documentId }) => relatedDocs.add(documentId));
    }

    // Retirer les documents originaux
    documentIds.forEach(id => relatedDocs.delete(id));

    return relatedDocs;
  }

  /**
   * Performs the RAG vector search: cache lookup, pdfService.search, filtering,
   * graph enrichment, and summary conversion.
   */
  private async performRAGSearch(
    message: string,
    queryHash: string,
    options: EnrichedRAGOptions
  ): Promise<RAGSearchOutput> {
    const searchStart = Date.now();
    let cacheHit = false;

    // Send status update - searching
    if (options.window) {
      options.window.webContents.send('chat:status', {
        stage: 'searching',
        message: '🔍 Recherche dans les documents...',
      });
    }

    console.log('🔍 [RAG DETAILED DEBUG] Starting RAG search:', {
      query: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
      queryLength: message.length,
      queryHash: queryHash,
      topK: options.topK,
      useGraphContext: options.useGraphContext,
      includeSummaries: options.includeSummaries,
      timestamp: new Date().toISOString(),
    });

    // Check cache first (identical queries = instant results)
    // Include collection filter, source type and document IDs in cache key to avoid mixing results
    const collectionSuffix = options.collectionKeys?.length ? `-coll:${options.collectionKeys.sort().join(',')}` : '';
    const sourceTypeSuffix = options.sourceType ? `-src:${options.sourceType}` : '-src:both';
    const documentIdsSuffix = options.documentIds?.length ? `-docs:${options.documentIds.sort().join(',')}` : '';
    const cacheKey = `${queryHash}-${options.topK || 5}${collectionSuffix}${sourceTypeSuffix}${documentIdsSuffix}`;
    const cachedResults = this.ragCache.get(cacheKey);

    let searchResults: RAGSearchResult[];

    if (cachedResults) {
      console.log(`💾 Cache HIT for query hash ${queryHash} (saved ${Date.now() - searchStart}ms)`);
      searchResults = cachedResults;
      cacheHit = true;
    } else {
      console.log(`🔍 Cache MISS for query hash ${queryHash}, performing search...`);
      const ragCfg = configManager.getRAGConfig();
      searchResults = await pdfService.search(message, {
        topK: options.topK,
        collectionKeys: options.collectionKeys,
        sourceType: options.sourceType,
        documentIds: options.documentIds, // Issue #16: filter by specific documents
        includeVault: ragCfg.includeObsidianVault === true,
      });

      // Store in cache for future identical queries
      this.ragCache.set(cacheKey, searchResults);
      console.log(`💾 Cached ${searchResults.length} results for query hash ${queryHash}`);
    }
    const searchDurationMs = Date.now() - searchStart;

    // Filter out results with null documents (orphaned chunks)
    searchResults = searchResults.filter(r => r.document !== null);

    console.log('🔍 [RAG DETAILED DEBUG] Search completed:', {
      queryHash: queryHash,
      resultsCount: searchResults.length,
      searchDuration: `${searchDurationMs}ms`,
      topSimilarities: searchResults.slice(0, 5).map(r => r.similarity.toFixed(4)),
      chunkIds: searchResults.slice(0, 3).map(r => r.chunk.id),
      documentTitles: searchResults.slice(0, 3).map(r => r.document?.title || 'Unknown'),
    });

    let relatedDocuments: PDFDocument[] = [];

    if (searchResults.length > 0) {
      console.log(`📚 Using ${searchResults.length} context chunks for RAG`);

      // Send status update - found sources
      if (options.window) {
        options.window.webContents.send('chat:status', {
          stage: 'found',
          message: `📚 ${searchResults.length} sources trouvées`,
        });
      }

      // Log first result for debugging
      console.log('🔍 [RAG DEBUG] First result:', {
        document: searchResults[0].document?.title || 'Unknown',
        similarity: searchResults[0].similarity,
        chunkLength: searchResults[0].chunk.content.length
      });

      // Enrich with graph context
      relatedDocuments = await this.enrichWithGraph(searchResults, options);

      // Si résumés activés, utiliser résumés au lieu de chunks
      if (options.includeSummaries) {
        console.log('📝 Using document summaries instead of chunks');
        // Remplacer chunks par résumés
        searchResults = this.convertChunksToSummaries(searchResults);
        if (relatedDocuments.length > 0) {
          searchResults = await this.addRelatedDocumentSummaries(
            searchResults, relatedDocuments, message
          );
        }
      }
    }

    return { searchResults, relatedDocuments, searchDurationMs, cacheHit };
  }

  /**
   * Enriches search results with related documents from the knowledge graph.
   * Returns the array of related PDFDocuments found.
   */
  private async enrichWithGraph(
    searchResults: RAGSearchResult[],
    options: EnrichedRAGOptions
  ): Promise<PDFDocument[]> {
    if (!options.useGraphContext) {
      return [];
    }

    const uniqueDocIds = [...new Set(searchResults.map(r => r.document.id))];
    const relatedDocIds = await this.getRelatedDocumentsFromGraph(
      uniqueDocIds,
      options.additionalGraphDocs || 3
    );

    console.log(`🔗 Found ${relatedDocIds.size} related documents via graph`);

    // Récupérer les documents complets
    const vectorStore = pdfService.getVectorStore();
    if (vectorStore && relatedDocIds.size > 0) {
      return Array.from(relatedDocIds)
        .map((id: string) => vectorStore.getDocument(id))
        .filter((doc): doc is PDFDocument => doc !== null);
    }

    return [];
  }

  /**
   * Adds summaries from graph-related documents to searchResults,
   * computing real similarity when embedding is available.
   */
  private async addRelatedDocumentSummaries(
    searchResults: RAGSearchResult[],
    relatedDocuments: PDFDocument[],
    message: string
  ): Promise<RAGSearchResult[]> {
    const embeddingProvider = pdfService.getLLMProviderManager();
    if (embeddingProvider && await embeddingProvider.isEmbeddingAvailable()) {
      try {
        // Générer l'embedding de la requête (avec préfixe query pour modèle embarqué)
        const queryEmbedding = await embeddingProvider.generateQueryEmbedding(message);
        console.log(`🔗 Computing real similarity for ${relatedDocuments.length} graph-related documents`);

        for (const doc of relatedDocuments) {
          if (doc.summary) {
            try {
              // Générer l'embedding du résumé et calculer la vraie similarité
              const summaryEmbedding = await embeddingProvider.generateEmbedding(doc.summary);
              const realSimilarity = cosineSimilarity(queryEmbedding, summaryEmbedding);
              console.log(`   📄 ${doc.title}: similarity = ${(realSimilarity * 100).toFixed(1)}%`);

              searchResults.push({
                document: doc,
                chunk: { content: doc.summary, pageNumber: 1 },
                similarity: realSimilarity,
                isRelatedDoc: true
              });
            } catch (embError) {
              console.warn(`⚠️ Failed to compute similarity for ${doc.title}:`, embError);
              searchResults.push({
                document: doc,
                chunk: { content: doc.summary, pageNumber: 1 },
                similarity: 0.5,
                isRelatedDoc: true
              });
            }
          }
        }
      } catch (queryEmbError) {
        console.warn('⚠️ Failed to generate query embedding for graph docs:', queryEmbError);
        relatedDocuments.forEach(doc => {
          if (doc.summary) {
            searchResults.push({
              document: doc,
              chunk: { content: doc.summary, pageNumber: 1 },
              similarity: 0.5,
              isRelatedDoc: true
            });
          }
        });
      }
    } else {
      console.warn('⚠️ No embedding provider available for similarity computation');
      relatedDocuments.forEach(doc => {
        if (doc.summary) {
          searchResults.push({
            document: doc,
            chunk: { content: doc.summary, pageNumber: 1 },
            similarity: 0.5,
            isRelatedDoc: true
          });
        }
      });
    }

    return searchResults;
  }

  /**
   * Applies intelligent compression to context chunks (if enabled).
   * Returns updated search results and compression statistics.
   */
  private compressContext(
    searchResults: RAGSearchResult[],
    message: string,
    options: EnrichedRAGOptions
  ): CompressionOutput {
    const compressionEnabled = options.enableContextCompression !== false; // Default: true
    let compressionStats: RAGExplanationContext['compression'] | undefined;
    let compressionDurationMs = 0;

    if (searchResults.length > 0 && compressionEnabled) {
      const compressionStart = Date.now();
      const preCompressionSize = searchResults.reduce((sum, r) => sum + r.chunk.content.length, 0);
      const _preCompressionChunks = searchResults.length;
      console.log(`🗜️  [COMPRESSION] Pre-compression context size: ${preCompressionSize} chars (${searchResults.length} chunks)`);

      // Convert search results to compressor format
      const chunksForCompression = searchResults.map(r => ({
        content: r.chunk.content,
        documentId: r.document.id,
        documentTitle: r.document.title,
        pageNumber: r.chunk.pageNumber,
        similarity: r.similarity,
      }));

      // Compress with 20k char target
      const compressionResult = this.compressor.compress(chunksForCompression, message, 20000);

      // Convert back to search result format
      searchResults = compressionResult.chunks.map(chunk => ({
        document: {
          id: chunk.documentId,
          title: chunk.documentTitle,
        },
        chunk: {
          content: chunk.content,
          pageNumber: chunk.pageNumber,
        },
        similarity: chunk.similarity,
      }));

      compressionDurationMs = Date.now() - compressionStart;

      // Capturer les stats de compression pour l'explication
      compressionStats = {
        enabled: true,
        originalChunks: compressionResult.stats.originalChunks,
        finalChunks: compressionResult.stats.compressedChunks,
        originalSize: compressionResult.stats.originalSize,
        finalSize: compressionResult.stats.compressedSize,
        reductionPercent: compressionResult.stats.reductionPercent,
        strategy: compressionResult.stats.strategy,
      };

      console.log(`✅ [COMPRESSION] Final stats:`, {
        strategy: compressionResult.stats.strategy,
        originalChunks: compressionResult.stats.originalChunks,
        compressedChunks: compressionResult.stats.compressedChunks,
        originalSize: compressionResult.stats.originalSize,
        compressedSize: compressionResult.stats.compressedSize,
        reduction: `${compressionResult.stats.reductionPercent.toFixed(1)}%`,
      });
    } else if (searchResults.length > 0 && !compressionEnabled) {
      const contextSize = searchResults.reduce((sum, r) => sum + r.chunk.content.length, 0);
      compressionStats = {
        enabled: false,
        originalChunks: searchResults.length,
        finalChunks: searchResults.length,
        originalSize: contextSize,
        finalSize: contextSize,
        reductionPercent: 0,
      };
      console.log(`⏭️  [COMPRESSION] Skipped (disabled in settings). Context size: ${contextSize} chars (${searchResults.length} chunks)`);
    }

    return { searchResults, compressionStats, compressionDurationMs };
  }

  /**
   * Builds the system prompt based on configuration (Phase 2.3 + Modes).
   */
  private buildSystemPrompt(options: EnrichedRAGOptions): string {
    const systemPromptLanguage = options.systemPromptLanguage || 'fr';
    const useCustomPrompt = options.useCustomSystemPrompt || false;
    const customPrompt = options.customSystemPrompt;

    let systemPrompt: string;
    if (options.noSystemPrompt) {
      // Free mode: no system prompt
      systemPrompt = '';
    } else {
      systemPrompt = getSystemPrompt(systemPromptLanguage, useCustomPrompt, customPrompt);
    }

    console.log('🤖 [SYSTEM PROMPT] Configuration:', {
      language: systemPromptLanguage,
      noSystemPrompt: options.noSystemPrompt || false,
      useCustom: useCustomPrompt,
      hasCustom: !!customPrompt,
      promptPreview: systemPrompt.substring(0, 100) + '...',
    });

    return systemPrompt;
  }

  /**
   * Performs the actual LLM call (with or without RAG sources), streaming
   * chunks to the renderer window.
   */
  private async generateResponse(
    message: string,
    searchResults: RAGSearchResult[],
    options: EnrichedRAGOptions,
    systemPrompt: string,
    queryHash: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmProviderManager: any
  ): Promise<GenerationOutput> {
    // Récupérer le contexte du projet (convert null to undefined for optional param compatibility)
    const projectContext = pdfService.getProjectContext() ?? undefined;

    // Build generation options (commun aux deux cas)
    const generationOptions = {
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      repeat_penalty: options.repeat_penalty,
      num_ctx: options.numCtx,  // Context window size for Ollama
    };

    // Send status update - generating
    if (options.window) {
      options.window.webContents.send('chat:status', {
        stage: 'generating',
        message: '✨ Génération de la réponse...',
      });
    }

    // Track generation timing and prompt size for explanation
    const generationStart = Date.now();
    let promptSize = 0;
    let fullResponse = '';

    // Fusion 1.4h: route through the typed provider when wired. Preserves
    // all surrounding RAG plumbing (search, compression, citation
    // extraction, history); only replaces the token-producing call.
    if (this.llm) {
      const sourcesBlock =
        searchResults.length > 0
          ? '\n\n[SOURCES]\n' +
            searchResults
              .map((r, i) => {
                const title = r.document?.title ?? 'untitled';
                const page = r.chunk?.pageNumber;
                const pageSuffix = typeof page === 'number' ? ` (p.${page})` : '';
                return `[${i + 1}] ${title}${pageSuffix}\n${r.chunk.content}`;
              })
              .join('\n\n')
          : '';

      const userContent =
        (projectContext ? `[PROJECT CONTEXT]\n${projectContext}\n\n` : '') +
        message +
        sourcesBlock;

      promptSize = systemPrompt.length + userContent.length;

      const iter = this.llm.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        {
          model: options.model,
          temperature: options.temperature,
          topP: options.top_p,
          topK: options.top_k,
        }
      );

      for await (const chunk of iter) {
        if (chunk.delta) {
          fullResponse += chunk.delta;
          if (options.window) {
            options.window.webContents.send('chat:stream', chunk.delta);
          }
        }
        if (chunk.done) break;
      }

      const generationDurationMs = Date.now() - generationStart;
      return { fullResponse, promptSize, generationDurationMs };
    }

    // Stream la réponse avec contexte RAG si disponible
    if (searchResults.length > 0) {
      // Calculate approximate prompt size (for explanation)
      const contextSize = searchResults.reduce((sum, r) => sum + r.chunk.content.length, 0);
      promptSize = message.length + contextSize + systemPrompt.length + (projectContext?.length || 0);

      console.log('✅ [RAG DETAILED DEBUG] Generating response WITH context:', {
        queryHash: queryHash,
        contextsUsed: searchResults.length,
        avgSimilarity: (searchResults.reduce((sum, r) => sum + r.similarity, 0) / searchResults.length).toFixed(4),
        mode: 'RAG_WITH_SOURCES',
        projectContextLoaded: !!projectContext,
        provider: llmProviderManager.getActiveProviderName(),
        timeout: options.timeout || 600000,
      });

      // Utiliser LLMProviderManager pour la génération (Ollama ou embarqué)
      // Cast RAGSearchResult[] to SearchResult[] — the LLM prompt builder only accesses
      // .document.title, .document.author, .document.year, .chunk.content, .chunk.pageNumber, .similarity
      const generator = llmProviderManager.generateWithSources(
        message,
        searchResults as unknown as SearchResult[],
        projectContext,
        {
          model: options.model,
          timeout: options.timeout,
          generationOptions,
          systemPrompt,
        }
      );
      this.currentStream = generator;

      for await (const chunk of generator) {
        fullResponse += chunk;
        // Envoyer le chunk au renderer si une fenêtre est fournie
        if (options.window) {
          options.window.webContents.send('chat:stream', chunk);
        }
      }
    } else {
      console.warn('⚠️  [RAG DETAILED DEBUG] No search results - generating response WITHOUT context');
      console.warn('⚠️  [RAG DETAILED DEBUG] Fallback mode details:', {
        queryHash: queryHash,
        query: message.substring(0, 100),
        contextRequested: options.context,
        topK: options.topK,
        mode: 'FALLBACK_NO_CONTEXT',
        warning: 'This response will be GENERIC and NOT based on your documents!',
      });

      // Utiliser LLMProviderManager pour la génération sans sources
      const generator = llmProviderManager.generateWithoutSources(
        message,
        [],
        {
          model: options.model,
          timeout: options.timeout,
          generationOptions,
          systemPrompt,
        }
      );
      this.currentStream = generator;

      for await (const chunk of generator) {
        fullResponse += chunk;
        // Envoyer le chunk au renderer si une fenêtre est fournie
        if (options.window) {
          options.window.webContents.send('chat:stream', chunk);
        }
      }
    }

    const generationDurationMs = Date.now() - generationStart;
    return { fullResponse, promptSize, generationDurationMs };
  }

  /**
   * Logs the user message, assistant response, and RAG operation to the
   * history service.
   */
  private logToHistory(
    message: string,
    fullResponse: string,
    searchResults: RAGSearchResult[],
    relatedDocuments: PDFDocument[],
    totalDuration: number,
    options: EnrichedRAGOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmProviderManager: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activeProvider: any
  ): void {
    const hm = historyService.getHistoryManager();
    if (!hm) return;

    // Build query params for history
    const queryParams = {
      model: options.model || llmProviderManager.getActiveProviderName(),
      topK: options.topK,
      timeout: options.timeout || 600000,
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      repeat_penalty: options.repeat_penalty,
      useGraphContext: options.useGraphContext || false,
      includeSummaries: options.includeSummaries || false,
      modeId: options.modeId || 'default-assistant',
    };

    // Log user message with query params
    hm.logChatMessage({
      role: 'user',
      content: message,
      queryParams,
    });

    // Log assistant response with sources
    const sources =
      searchResults.length > 0
        ? searchResults.map((r) => ({
            documentId: r.document?.id || '',
            documentTitle: r.document?.title || 'Unknown',
            author: r.document?.author || '',
            year: r.document?.year || 0,
            pageNumber: r.chunk.pageNumber,
            similarity: r.similarity,
            isRelatedDoc: r.isRelatedDoc || false,
          }))
        : undefined;

    hm.logChatMessage({
      role: 'assistant',
      content: fullResponse,
      sources,
      queryParams,
    });

    // Log RAG operation if context was used
    if (options.context && searchResults.length > 0) {
      hm.logAIOperation({
        operationType: 'rag_query',
        durationMs: totalDuration,
        inputText: message,
        inputMetadata: {
          topK: options.topK,
          useGraphContext: options.useGraphContext || false,
          includeSummaries: options.includeSummaries || false,
          sourcesFound: searchResults.length,
          relatedDocumentsFound: relatedDocuments.length,
        },
        modelName: llmProviderManager.getActiveProviderName(),
        modelParameters: {
          temperature: options.temperature || 0.1,
          provider: activeProvider,
        },
        outputText: fullResponse,
        outputMetadata: {
          sources: sources || [],
          responseLength: fullResponse.length,
        },
        success: true,
      });

      console.log(
        `📝 Logged RAG query: ${searchResults.length} sources, ${totalDuration}ms`
      );
    }
  }

  /**
   * Builds the RAG explanation context object (Explainable AI) from the
   * collected search, compression, graph, and generation metadata.
   */
  private buildExplanation(
    message: string,
    searchResults: RAGSearchResult[],
    relatedDocuments: PDFDocument[],
    options: EnrichedRAGOptions,
    searchDurationMs: number,
    cacheHit: boolean,
    compressionStats: RAGExplanationContext['compression'] | undefined,
    compressionDurationMs: number,
    promptSize: number,
    generationDurationMs: number,
    totalDuration: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmProviderManager: any
  ): RAGExplanationContext | undefined {
    if (!options.context || searchResults.length === 0) {
      return undefined;
    }

    // Group results by document
    const documentMap = new Map<string, ExplanationDocumentEntry>();
    searchResults.forEach((r: RAGSearchResult) => {
      const docId = r.document?.id || 'unknown';
      const existing = documentMap.get(docId);
      if (existing) {
        existing.chunkCount++;
        existing.similarity = Math.max(existing.similarity, r.similarity);
      } else {
        documentMap.set(docId, {
          title: r.document?.title || 'Unknown',
          similarity: r.similarity,
          sourceType: r.sourceType || 'secondary',
          chunkCount: 1,
        });
      }
    });

    return {
      search: {
        query: message,
        totalResults: searchResults.length,
        searchDurationMs,
        cacheHit,
        sourceType: options.sourceType || 'both',
        documents: Array.from(documentMap.values()).slice(0, 10),
      },
      compression: compressionStats,
      graph: options.useGraphContext ? {
        enabled: true,
        relatedDocsFound: relatedDocuments.length,
        documentTitles: relatedDocuments.map(d => d.title || 'Unknown'),
      } : undefined,
      llm: {
        provider: llmProviderManager.getActiveProviderName(),
        model: llmProviderManager.getActiveModelName(),
        contextWindow: options.numCtx || 4096,
        temperature: options.temperature || 0.1,
        promptSize,
      },
      timing: {
        searchMs: searchDurationMs,
        compressionMs: compressionDurationMs > 0 ? compressionDurationMs : undefined,
        generationMs: generationDurationMs,
        totalMs: totalDuration,
      },
    };
  }

  async sendMessage(
    message: string,
    options: EnrichedRAGOptions = {}
  ): Promise<{ response: string; ragUsed: boolean; sourcesCount: number; explanation?: RAGExplanationContext }> {
    const startTime = Date.now();
    const queryHash = hashString(message);

    try {
      // Obtenir le LLM Provider Manager (gère Ollama + modèle embarqué)
      const llmProviderManager = pdfService.getLLMProviderManager();
      if (!llmProviderManager) {
        throw new Error('LLM Provider Manager not initialized. Load a project first.');
      }

      // Appliquer le provider sélectionné par l'utilisateur (from RAG settings)
      if (options.provider) {
        console.log(`🔧 [CHAT] Setting provider preference: ${options.provider}`);
        llmProviderManager.setProvider(options.provider);
      }

      // Vérifier qu'au moins un provider est disponible
      const activeProvider = await llmProviderManager.getActiveProvider();
      if (!activeProvider) {
        throw new Error(
          'Aucun LLM disponible.\n\n' +
          'Options:\n' +
          '1. Installez et démarrez Ollama (https://ollama.ai)\n' +
          '2. Téléchargez le modèle embarqué dans Paramètres → LLM'
        );
      }

      console.log(`🤖 [CHAT] Using LLM provider: ${llmProviderManager.getActiveProviderName()}`);

      // Step 1: RAG search (if context enabled)
      let searchResults: RAGSearchResult[] = [];
      let relatedDocuments: PDFDocument[] = [];
      let searchDurationMs = 0;
      let cacheHit = false;

      if (options.context) {
        const ragOutput = await this.performRAGSearch(message, queryHash, options);
        searchResults = ragOutput.searchResults;
        relatedDocuments = ragOutput.relatedDocuments;
        searchDurationMs = ragOutput.searchDurationMs;
        cacheHit = ragOutput.cacheHit;
      }

      // Step 2: Context compression
      let compressionStats: RAGExplanationContext['compression'] | undefined;
      let compressionDurationMs = 0;

      if (searchResults.length > 0) {
        const compressionOutput = this.compressContext(searchResults, message, options);
        searchResults = compressionOutput.searchResults;
        compressionStats = compressionOutput.compressionStats;
        compressionDurationMs = compressionOutput.compressionDurationMs;
      }

      // Step 3: Build system prompt
      const systemPrompt = this.buildSystemPrompt(options);

      // Step 4: Generate LLM response
      const generationOutput = await this.generateResponse(
        message, searchResults, options, systemPrompt, queryHash, llmProviderManager
      );

      const totalDuration = Date.now() - startTime;

      console.log('✅ [RAG DETAILED DEBUG] Chat response completed:', {
        queryHash: queryHash,
        responseLength: generationOutput.fullResponse.length,
        totalDuration: `${totalDuration}ms`,
        ragUsed: searchResults.length > 0,
        timestamp: new Date().toISOString(),
      });

      // Step 5: Log to history
      this.logToHistory(
        message, generationOutput.fullResponse, searchResults, relatedDocuments,
        totalDuration, options, llmProviderManager, activeProvider
      );

      // Step 6: Build explanation context (Explainable AI)
      const explanationContext = this.buildExplanation(
        message, searchResults, relatedDocuments, options,
        searchDurationMs, cacheHit, compressionStats, compressionDurationMs,
        generationOutput.promptSize, generationOutput.generationDurationMs,
        totalDuration, llmProviderManager
      );

      return {
        response: generationOutput.fullResponse,
        ragUsed: searchResults.length > 0,
        sourcesCount: searchResults.length,
        explanation: explanationContext,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      const errorClassified = error instanceof Error ? (error as Error & { classified?: boolean }).classified : undefined;

      console.error('❌ [RAG DETAILED DEBUG] Chat error:', {
        queryHash: queryHash,
        error: errorMessage,
        stack: errorStack,
        classified: errorClassified, // If error was classified by OllamaClient
      });

      // Send error status to renderer
      if (options.window) {
        options.window.webContents.send('chat:status', {
          stage: 'error',
          message: errorMessage || 'Une erreur est survenue',
        });
      }

      throw error;
    }
  }

  cancelCurrentStream() {
    if (this.currentStream) {
      // TODO: Implémenter cancel dans OllamaClient si nécessaire
      this.currentStream = null;
      console.log('⚠️  Chat stream cancelled');
    }
  }
}

export const chatService = new ChatService();
