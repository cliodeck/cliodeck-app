// @ts-nocheck
import { LRUCache } from 'lru-cache';
import { pdfService } from './pdf-service.js';
import { BrowserWindow } from 'electron';
import { historyService } from './history-service.js';
import { ContextCompressor } from '../../../backend/core/rag/ContextCompressor.js';
import { getSystemPrompt } from '../../../backend/core/llm/SystemPrompts.js';

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
      sourceType: 'primary' | 'secondary';
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

class ChatService {
  private currentStream: any = null;
  private compressor: ContextCompressor = new ContextCompressor();

  // LRU Cache for RAG search results (cache identical queries)
  // 🚀 OPTIMIZED: Increased capacity (100→200) and TTL (10→30 minutes)
  private ragCache = new LRUCache<string, any[]>({
    max: 200, // Store up to 200 different queries
    ttl: 1000 * 60 * 30, // 30 minutes TTL
    updateAgeOnGet: true, // Refresh TTL on access
  });

  /**
   * Convertit les résultats de recherche en utilisant les résumés au lieu des chunks
   * Si les résumés ne sont pas disponibles, retourne les chunks originaux
   */
  private convertChunksToSummaries(searchResults: any[]): any[] {
    const summaryResults: any[] = [];
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

  async sendMessage(
    message: string,
    options: EnrichedRAGOptions = {}
  ): Promise<{ response: string; ragUsed: boolean; sourcesCount: number; explanation?: RAGExplanationContext }> {
    const startTime = Date.now();
    const queryHash = hashString(message);

    // Métadonnées pour l'explication (Explainable AI)
    let explanationContext: RAGExplanationContext | undefined;
    let searchDurationMs = 0;
    let compressionDurationMs = 0;
    let cacheHit = false;

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

      let fullResponse = '';
      let searchResults: any[] = [];
      let relatedDocuments: any[] = [];

      // Si contexte activé, rechercher dans les documents
      if (options.context) {
        const searchStart = Date.now();

        // 🚀 FEEDBACK: Send status update - searching
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

        if (cachedResults) {
          console.log(`💾 Cache HIT for query hash ${queryHash} (saved ${Date.now() - searchStart}ms)`);
          searchResults = cachedResults;
          cacheHit = true;
        } else {
          console.log(`🔍 Cache MISS for query hash ${queryHash}, performing search...`);
          searchResults = await pdfService.search(message, {
            topK: options.topK,
            collectionKeys: options.collectionKeys,
            sourceType: options.sourceType,
            documentIds: options.documentIds, // Issue #16: filter by specific documents
          });

          // Store in cache for future identical queries
          this.ragCache.set(cacheKey, searchResults);
          console.log(`💾 Cached ${searchResults.length} results for query hash ${queryHash}`);
        }
        searchDurationMs = Date.now() - searchStart;

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

        if (searchResults.length > 0) {
          console.log(`📚 Using ${searchResults.length} context chunks for RAG`);

          // 🚀 FEEDBACK: Send status update - found sources
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

          // Si graphe activé, récupérer documents liés
          if (options.useGraphContext) {
            const uniqueDocIds = [...new Set(searchResults.map(r => r.document.id))];
            const relatedDocIds = await this.getRelatedDocumentsFromGraph(
              uniqueDocIds,
              options.additionalGraphDocs || 3
            );

            console.log(`🔗 Found ${relatedDocIds.size} related documents via graph`);

            // Récupérer les documents complets
            const vectorStore = pdfService.getVectorStore();
            if (vectorStore && relatedDocIds.size > 0) {
              relatedDocuments = Array.from(relatedDocIds)
                .map(id => vectorStore.getDocument(id))
                .filter(doc => doc !== null);
            }
          }

          // Si résumés activés, utiliser résumés au lieu de chunks
          if (options.includeSummaries) {
            console.log('📝 Using document summaries instead of chunks');
            // Remplacer chunks par résumés
            searchResults = this.convertChunksToSummaries(searchResults);
            if (relatedDocuments.length > 0) {
              // Ajouter résumés des documents liés avec vraie similarité
              const ollamaClient = pdfService.getOllamaClient();
              if (ollamaClient) {
                try {
                  // Générer l'embedding de la requête
                  const queryEmbedding = await ollamaClient.generateEmbedding(message);
                  console.log(`🔗 Computing real similarity for ${relatedDocuments.length} graph-related documents`);

                  for (const doc of relatedDocuments) {
                    if (doc.summary) {
                      try {
                        // Générer l'embedding du résumé et calculer la vraie similarité
                        const summaryEmbedding = await ollamaClient.generateEmbedding(doc.summary);
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
                        // Fallback: utiliser 0.5 au lieu de 0.7 (indique incertitude)
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
                  // Fallback: ajouter sans similarité calculée
                  relatedDocuments.forEach(doc => {
                    if (doc.summary) {
                      searchResults.push({
                        document: doc,
                        chunk: { content: doc.summary, pageNumber: 1 },
                        similarity: 0.5, // Score indiquant incertitude
                        isRelatedDoc: true
                      });
                    }
                  });
                }
              } else {
                // Pas d'OllamaClient, utiliser le fallback
                console.warn('⚠️ No OllamaClient available for similarity computation');
                relatedDocuments.forEach(doc => {
                  if (doc.summary) {
                    searchResults.push({
                      document: doc,
                      chunk: { content: doc.summary, pageNumber: 1 },
                      similarity: 0.5, // Score indiquant incertitude
                      isRelatedDoc: true
                    });
                  }
                });
              }
            }
          }
        }
      }

      // Apply intelligent compression to context chunks (if enabled)
      const compressionEnabled = options.enableContextCompression !== false; // Default: true
      let compressionStats: RAGExplanationContext['compression'] | undefined;

      if (searchResults.length > 0 && compressionEnabled) {
        const compressionStart = Date.now();
        const preCompressionSize = searchResults.reduce((sum, r) => sum + r.chunk.content.length, 0);
        const preCompressionChunks = searchResults.length;
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

      // Récupérer le contexte du projet
      const projectContext = pdfService.getProjectContext();

      // Build system prompt based on configuration (Phase 2.3 + Modes)
      let systemPrompt: string;
      const systemPromptLanguage = options.systemPromptLanguage || 'fr';
      const useCustomPrompt = options.useCustomSystemPrompt || false;
      const customPrompt = options.customSystemPrompt;
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

      // Build generation options (commun aux deux cas)
      const generationOptions = {
        temperature: options.temperature,
        top_p: options.top_p,
        top_k: options.top_k,
        repeat_penalty: options.repeat_penalty,
        num_ctx: options.numCtx,  // Context window size for Ollama
      };

      // 🚀 FEEDBACK: Send status update - generating
      if (options.window) {
        options.window.webContents.send('chat:status', {
          stage: 'generating',
          message: '✨ Génération de la réponse...',
        });
      }

      // Track generation timing and prompt size for explanation
      const generationStart = Date.now();
      let promptSize = 0;

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
        const generator = llmProviderManager.generateWithSources(
          message,
          searchResults,
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

      const totalDuration = Date.now() - startTime;

      console.log('✅ [RAG DETAILED DEBUG] Chat response completed:', {
        queryHash: queryHash,
        responseLength: fullResponse.length,
        totalDuration: `${totalDuration}ms`,
        ragUsed: searchResults.length > 0,
        timestamp: new Date().toISOString(),
      });

      // Log chat messages and AI operation to history
      const hm = historyService.getHistoryManager();
      if (hm) {
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

      // Build explanation context (Explainable AI)
      const generationDurationMs = Date.now() - generationStart;
      if (options.context && searchResults.length > 0) {
        // Group results by document
        const documentMap = new Map<string, { title: string; similarity: number; sourceType: string; chunkCount: number }>();
        searchResults.forEach(r => {
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

        explanationContext = {
          search: {
            query: message,
            totalResults: searchResults.length,
            searchDurationMs,
            cacheHit,
            sourceType: options.sourceType || 'both',
            documents: Array.from(documentMap.values()).slice(0, 10) as any,
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

      return {
        response: fullResponse,
        ragUsed: searchResults.length > 0,
        sourcesCount: searchResults.length,
        explanation: explanationContext,
      };
    } catch (error: any) {
      console.error('❌ [RAG DETAILED DEBUG] Chat error:', {
        queryHash: queryHash,
        error: error.message,
        stack: error.stack,
        classified: error.classified, // If error was classified by OllamaClient
      });

      // 🚀 FEEDBACK: Send error status to renderer
      if (options.window) {
        options.window.webContents.send('chat:status', {
          stage: 'error',
          message: error.message || 'Une erreur est survenue',
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
