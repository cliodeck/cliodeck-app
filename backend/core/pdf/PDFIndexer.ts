import { randomUUID } from 'crypto';
import { measureTextDensity } from './text-density.js';
import { PDFExtractor } from './PDFExtractor.js';
import { TextPreprocessor } from './TextPreprocessor.js';
import { DocumentChunker, CHUNKING_CONFIGS, type ChunkingConfig } from '../chunking/DocumentChunker.js';
import { AdaptiveChunker } from '../chunking/AdaptiveChunker.js';
import { SemanticChunker } from '../chunking/SemanticChunker.js';
import { ChunkQualityScorer } from '../chunking/ChunkQualityScorer.js';
import { ChunkDeduplicator } from '../chunking/ChunkDeduplicator.js';
import { EmbeddingCache } from '../chunking/EmbeddingCache.js';
import { VectorStore } from '../vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../vector-store/EnhancedVectorStore.js';
// OllamaClient import removed: PDFIndexer now accepts a generic embedding function
import { CitationExtractor } from '../analysis/CitationExtractor.js';
import { DocumentSummarizer, type SummarizerConfig } from '../analysis/DocumentSummarizer.js';
import type { PDFDocument, DocumentChunk, DocumentPage, PDFMetadata } from '../../types/pdf-document.js';
import type { RAGConfig } from '../../types/config.js';

/**
 * Extended indexing options including all RAG optimization features
 */
export interface IndexingOptions {
  // Chunking
  chunkingPreset?: 'cpuOptimized' | 'standard' | 'large';
  customChunkingEnabled?: boolean;
  customMaxChunkSize?: number;
  customMinChunkSize?: number;
  customOverlapSize?: number;
  useAdaptiveChunking?: boolean;

  // Quality filtering
  enableQualityFiltering?: boolean;
  minChunkEntropy?: number;
  minUniqueWordRatio?: number;

  // Preprocessing
  enablePreprocessing?: boolean;
  enableOCRCleanup?: boolean;
  enableHeaderFooterRemoval?: boolean;

  // Deduplication
  enableDeduplication?: boolean;
  enableSimilarityDedup?: boolean;
  dedupSimilarityThreshold?: number;

  // Semantic chunking
  useSemanticChunking?: boolean;
  semanticSimilarityThreshold?: number;
  semanticWindowSize?: number;

  // Summarizer
  summarizerConfig?: SummarizerConfig;
}

export interface IndexingProgress {
  stage:
    | 'extracting'
    | 'analyzing'
    | 'citations'
    | 'summarizing'
    | 'chunking'
    | 'embedding'
    | 'similarities'
    | 'completed'
    | 'error';
  progress: number; // 0-100
  message: string;
  currentPage?: number;
  totalPages?: number;
  currentChunk?: number;
  totalChunks?: number;
}

/**
 * Signature for an extraction function that can replace the built-in
 * PDFExtractor.extractDocument(). Used by the Electron-side wrapper to
 * inject child_process-based isolation so a pdfjs SIGSEGV does not kill
 * the main process.
 */
export type ExtractDocumentFn = (
  filePath: string
) => Promise<{ pages: DocumentPage[]; metadata: PDFMetadata; title: string }>;

export class PDFIndexer {
  private pdfExtractor: PDFExtractor;
  private extractDocumentFn: ExtractDocumentFn;
  private textPreprocessor: TextPreprocessor;
  private chunker: DocumentChunker | AdaptiveChunker;
  private semanticChunker: SemanticChunker | null = null;
  private qualityScorer: ChunkQualityScorer;
  private deduplicator: ChunkDeduplicator;
  private embeddingCache: EmbeddingCache;
  private vectorStore: VectorStore | EnhancedVectorStore;
  private generateEmbeddingFn: (text: string) => Promise<Float32Array>;
  private citationExtractor: CitationExtractor;
  private documentSummarizer: DocumentSummarizer | null = null;
  private summarizerConfig: SummarizerConfig;
  private options: IndexingOptions;

  constructor(
    vectorStore: VectorStore | EnhancedVectorStore,
    generateEmbedding: (text: string) => Promise<Float32Array>,
    chunkingConfig: 'cpuOptimized' | 'standard' | 'large' = 'cpuOptimized',
    summarizerConfig?: SummarizerConfig,
    useAdaptiveChunking: boolean = false,
    ragConfig?: Partial<RAGConfig>,
    extractDocumentOverride?: ExtractDocumentFn
  ) {
    this.pdfExtractor = new PDFExtractor();
    this.extractDocumentFn = extractDocumentOverride
      ?? ((fp: string) => this.pdfExtractor.extractDocument(fp));
    this.textPreprocessor = new TextPreprocessor();
    this.qualityScorer = new ChunkQualityScorer();
    this.deduplicator = new ChunkDeduplicator();
    this.embeddingCache = new EmbeddingCache(500);
    this.vectorStore = vectorStore;
    this.generateEmbeddingFn = generateEmbedding;
    this.citationExtractor = new CitationExtractor();

    // Build options from ragConfig or use defaults
    this.options = {
      chunkingPreset: chunkingConfig,
      useAdaptiveChunking: ragConfig?.useAdaptiveChunking ?? useAdaptiveChunking,
      customChunkingEnabled: ragConfig?.customChunkingEnabled ?? false,
      customMaxChunkSize: ragConfig?.customMaxChunkSize ?? 500,
      customMinChunkSize: ragConfig?.customMinChunkSize ?? 100,
      customOverlapSize: ragConfig?.customOverlapSize ?? 75,
      enableQualityFiltering: ragConfig?.enableQualityFiltering ?? true,
      minChunkEntropy: ragConfig?.minChunkEntropy ?? 0.3,
      minUniqueWordRatio: ragConfig?.minUniqueWordRatio ?? 0.4,
      enablePreprocessing: ragConfig?.enablePreprocessing ?? true,
      enableOCRCleanup: ragConfig?.enableOCRCleanup ?? true,
      enableHeaderFooterRemoval: ragConfig?.enableHeaderFooterRemoval ?? true,
      enableDeduplication: ragConfig?.enableDeduplication ?? true,
      enableSimilarityDedup: ragConfig?.enableSimilarityDedup ?? false,
      dedupSimilarityThreshold: ragConfig?.dedupSimilarityThreshold ?? 0.85,
      useSemanticChunking: ragConfig?.useSemanticChunking ?? false,
      semanticSimilarityThreshold: ragConfig?.semanticSimilarityThreshold ?? 0.7,
      semanticWindowSize: ragConfig?.semanticWindowSize ?? 3,
      summarizerConfig,
    };

    // Build chunking config
    let chunkingCfg: ChunkingConfig;
    if (this.options.customChunkingEnabled) {
      chunkingCfg = {
        maxChunkSize: this.options.customMaxChunkSize!,
        minChunkSize: this.options.customMinChunkSize!,
        overlapSize: this.options.customOverlapSize!,
      };
      console.log('📐 Using custom chunking config:', chunkingCfg);
    } else {
      chunkingCfg = CHUNKING_CONFIGS[chunkingConfig];
    }

    // Choose chunker based on configuration
    if (this.options.useAdaptiveChunking) {
      console.log('📐 Using AdaptiveChunker (structure-aware)');
      this.chunker = new AdaptiveChunker(chunkingCfg);
    } else {
      console.log('📐 Using DocumentChunker (fixed-size)');
      this.chunker = new DocumentChunker(chunkingCfg);
    }

    // Initialize semantic chunker if enabled
    if (this.options.useSemanticChunking) {
      console.log('🧠 Semantic chunking enabled');
      this.semanticChunker = new SemanticChunker(
        (text) => this.generateEmbeddingFn(text),
        {
          similarityThreshold: this.options.semanticSimilarityThreshold!,
          windowSize: this.options.semanticWindowSize!,
          minChunkSize: chunkingCfg.minChunkSize,
          maxChunkSize: chunkingCfg.maxChunkSize,
        },
        this.embeddingCache
      );
    }

    // Log enabled features
    console.log('🔧 [INDEXER] RAG optimization features:');
    console.log(`   - Preprocessing: ${this.options.enablePreprocessing}`);
    console.log(`   - Quality filtering: ${this.options.enableQualityFiltering}`);
    console.log(`   - Deduplication: ${this.options.enableDeduplication}`);
    console.log(`   - Semantic chunking: ${this.options.useSemanticChunking}`);

    // Initialiser DocumentSummarizer si activé
    this.summarizerConfig = summarizerConfig || {
      enabled: false,
      method: 'extractive',
      maxLength: 250,
    };

    if (this.summarizerConfig.enabled) {
      this.documentSummarizer = new DocumentSummarizer(this.summarizerConfig, generateEmbedding);
    }
  }

  /**
   * Indexe un PDF complet
   * @param filePath Chemin vers le fichier PDF
   * @param bibtexKey Clé BibTeX optionnelle pour lier à la bibliographie
   * @param onProgress Callback pour la progression
   * @param bibliographyMetadata Métadonnées optionnelles provenant de la bibliographie (prioritaires sur l'extraction PDF)
   */
  async indexPDF(
    filePath: string,
    bibtexKey?: string,
    onProgress?: (progress: IndexingProgress) => void,
    bibliographyMetadata?: { title?: string; author?: string; year?: string }
  ): Promise<PDFDocument> {
    console.log('🔍 [INDEXER] Starting PDF indexing...');
    console.log(`   File: ${filePath}`);
    console.log(`   BibtexKey: ${bibtexKey || 'none'}`);

    try {
      // 1. Extraire le texte + métadonnées
      console.log('🔍 [INDEXER] Step 1: Extracting text and metadata...');
      onProgress?.({
        stage: 'extracting',
        progress: 10,
        message: 'Extraction du texte PDF...',
      });

      const { pages, metadata, title: extractedTitle } = await this.extractDocumentFn(filePath);
      console.log(`🔍 [INDEXER] Step 1 complete: ${pages.length} pages extracted`);

      // Un PDF sans couche de texte s'indexe sans erreur mais reste
      // introuvable : on le mesure, pour que l'app puisse le dire (#132).
      const textDensity = measureTextDensity(pages);
      metadata.textDensity = textDensity;
      if (textDensity.lowText) {
        console.warn(
          `⚠️ [INDEXER] Presque aucun texte extrait (${textDensity.charsPerPage} car./page) : PDF image sans OCR ? ${filePath}`
        );
      }

      // Use bibliography metadata if provided, otherwise fall back to PDF extraction
      const title = bibliographyMetadata?.title || extractedTitle;

      onProgress?.({
        stage: 'extracting',
        progress: 25,
        message: `${pages.length} pages extraites`,
        totalPages: pages.length,
      });

      // 2. Use bibliography metadata for author/year if provided, otherwise extract from PDF
      let author: string | undefined;
      let year: string | undefined;

      if (bibliographyMetadata?.author) {
        author = bibliographyMetadata.author;
        console.log(`   Using bibliography author: ${author}`);
      } else {
        author = await this.pdfExtractor.extractAuthor(filePath);
      }

      if (bibliographyMetadata?.year) {
        year = bibliographyMetadata.year;
        console.log(`   Using bibliography year: ${year}`);
      } else {
        year = await this.pdfExtractor.extractYear(filePath);
      }

      // 3. Extraire le texte complet pour analyse
      const fullText = pages.map((p) => p.text).join('\n\n');

      // 4. Détecter la langue du document
      onProgress?.({
        stage: 'analyzing',
        progress: 27,
        message: 'Analyse du document...',
      });

      const language = this.citationExtractor.detectLanguage(fullText);
      console.log(`   Langue détectée: ${language}`);

      // 5. Extraction des citations
      onProgress?.({
        stage: 'citations',
        progress: 30,
        message: 'Extraction des citations...',
      });

      const citations = this.citationExtractor.extractCitations(fullText, pages);
      console.log(`   Citations extraites: ${citations.length}`);

      // Statistiques sur les citations
      if (citations.length > 0) {
        const stats = this.citationExtractor.getCitationStatistics(citations);
        console.log(
          `   - ${stats.totalCitations} citations, ${stats.uniqueAuthors} auteurs, années ${stats.yearRange.min}-${stats.yearRange.max}`
        );
      }

      // 6. Génération du résumé (optionnel)
      let summary: string | undefined;
      let summaryEmbedding: Float32Array | undefined;

      if (this.documentSummarizer) {
        onProgress?.({
          stage: 'summarizing',
          progress: 33,
          message: `Génération du résumé (${this.summarizerConfig.method})...`,
        });

        summary = await this.documentSummarizer.generateSummary(fullText, metadata);

        // Générer l'embedding du résumé
        if (summary) {
          summaryEmbedding = await this.documentSummarizer.generateSummaryEmbedding(summary);
          console.log(`   Résumé généré: ${summary.split(' ').length} mots`);
        }
      }

      // 7. Créer le document avec données enrichies
      const documentId = randomUUID();
      const now = new Date();

      const document: PDFDocument = {
        id: documentId,
        fileURL: filePath,
        title,
        author,
        year,
        bibtexKey,
        pageCount: pages.length,
        metadata,
        createdAt: now,
        indexedAt: now,
        lastAccessedAt: now,
        get displayString() {
          if (this.author && this.year) {
            return `${this.author} (${this.year})`;
          }
          return this.title;
        },
      };

      // Ajouter les champs enrichis
      (document as any).language = language;
      (document as any).citationsExtracted = citations;
      (document as any).summary = summary;
      (document as any).summaryEmbedding = summaryEmbedding;

      // Rien n'est écrit avant la fin : document, citations et extraits partent ensemble (étape 15).

      // 10. Preprocess pages (if enabled)
      let processedPages = pages;
      if (this.options.enablePreprocessing) {
        onProgress?.({
          stage: 'chunking',
          progress: 38,
          message: 'Prétraitement du texte...',
        });

        const preprocessResult = this.textPreprocessor.preprocess(pages, {
          enableOCRCleanup: this.options.enableOCRCleanup,
          enableHeaderFooterRemoval: this.options.enableHeaderFooterRemoval,
          enablePageNumberRemoval: true,
        });
        processedPages = preprocessResult.pages;

        console.log(`🧹 [PREPROCESS] Stats:`, {
          headersRemoved: preprocessResult.stats.headersRemoved,
          footersRemoved: preprocessResult.stats.footersRemoved,
          pageNumbersRemoved: preprocessResult.stats.pageNumbersRemoved,
          charactersRemoved: preprocessResult.stats.charactersRemoved,
        });
      }

      // 11. Créer les chunks
      onProgress?.({
        stage: 'chunking',
        progress: 40,
        message: 'Découpage du texte en chunks...',
      });

      // Pass document metadata to chunker for context enhancement
      const documentMeta = {
        title: document.title,
        abstract: summary,
      };

      let chunks: DocumentChunk[];

      // Use semantic chunker if enabled, otherwise use regular chunker
      if (this.semanticChunker && this.options.useSemanticChunking) {
        console.log('🧠 [SEMANTIC] Using semantic chunking...');
        chunks = await this.semanticChunker.createChunks(processedPages, documentId, documentMeta);
      } else if (this.chunker instanceof AdaptiveChunker) {
        chunks = this.chunker.createChunks(processedPages, documentId, documentMeta);
      } else {
        chunks = this.chunker.createChunks(processedPages, documentId);
      }

      console.log(`📊 Initial chunking: ${chunks.length} chunks created`);

      // 12. Quality filtering (if enabled)
      if (this.options.enableQualityFiltering) {
        const qualityResult = this.qualityScorer.filterByQuality(chunks, {
          minEntropy: this.options.minChunkEntropy,
          minUniqueWordRatio: this.options.minUniqueWordRatio,
        }, false); // Don't log each filtered chunk

        console.log(`🎯 [QUALITY] Filtering: ${qualityResult.stats.passedChunks}/${qualityResult.stats.totalChunks} passed (${(qualityResult.stats.filterRate * 100).toFixed(1)}% filtered)`);
        chunks = qualityResult.passed;
      }

      // 13. Deduplication (if enabled)
      if (this.options.enableDeduplication) {
        const dedupResult = this.deduplicator.deduplicate(chunks, {
          useContentHash: true,
          useSimilarity: this.options.enableSimilarityDedup,
          similarityThreshold: this.options.dedupSimilarityThreshold!,
        });

        if (dedupResult.duplicateCount > 0) {
          console.log(`🔄 [DEDUP] Removed ${dedupResult.duplicateCount} duplicate chunks`);
        }
        chunks = dedupResult.uniqueChunks;
      }

      const stats = this.chunker.getChunkingStats(chunks);
      console.log(
        `📊 Final: ${stats.totalChunks} chunks, ${stats.averageWordCount} mots/chunk en moyenne`
      );

      onProgress?.({
        stage: 'chunking',
        progress: 45,
        message: `${chunks.length} chunks créés`,
        totalChunks: chunks.length,
      });

      // 14. Générer les embeddings, tous en mémoire jusqu'à l'écriture
      onProgress?.({
        stage: 'embedding',
        progress: 50,
        message: 'Génération des embeddings...',
        totalChunks: chunks.length,
      });

      const isEnhancedStore = this.vectorStore instanceof EnhancedVectorStore;
      console.log(`🔍 [INDEXER] Generating embeddings (EnhancedStore: ${isEnhancedStore})...`);
      const chunksWithEmbeddings: Array<{ chunk: DocumentChunk; embedding: Float32Array }> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await this.generateEmbeddingFn(chunk.content);
        chunksWithEmbeddings.push({ chunk, embedding });

        // Mise à jour de la progression
        const progress = 50 + Math.floor((i / chunks.length) * 40);
        onProgress?.({
          stage: 'embedding',
          progress,
          message: `Embeddings: ${i + 1}/${chunks.length}`,
          currentChunk: i + 1,
          totalChunks: chunks.length,
        });

        // Log progression tous les 10 chunks
        if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
          console.log(`  Embeddings: ${i + 1}/${chunks.length}`);
        }
      }

      // 15. Écrire document, citations et extraits, tout ou rien. Écrit avant les embeddings, le
      // document restait sans extrait quand l'indexation s'arrêtait en route (Ollama arrêté, app
      // quittée) : le renderer le comptait « déjà indexé », et aucune recherche ne le trouvait
      // (S03-1-0). Un extrait en échec au milieu laissait une copie partielle, que le nettoyage du
      // démarrage préfère à la complète (S01-1-14). Synchrone : une autre indexation du même fichier
      // ne voit ce document qu'une fois complet, et la dernière à finir remplace l'autre, au lieu
      // de supprimer un document encore en cours (S01-1-13).
      //
      // Un document sans extrait n'est donc plus le reste d'une passe interrompue : le filtre de
      // qualité a tout écarté (page trop courte), ou le PDF n'a pas de texte (#132). On le marque,
      // pour que le renderer ne le repropose pas à chaque « Indexer tous les PDF » comme il
      // repropose, une fois, les documents vides hérités, qui n'ont pas cette marque.
      if (chunksWithEmbeddings.length === 0) {
        document.metadata.noChunks = true;
      }
      this.vectorStore.transaction(() => {
        this.vectorStore.saveDocument(document);

        // Matcher les citations avec les documents existants, celui-ci compris
        const citationMatches = this.citationExtractor.matchCitationsWithDocuments(
          citations,
          this.vectorStore.getAllDocuments()
        );
        for (const citation of citations) {
          this.vectorStore.saveCitation({
            id: randomUUID(),
            sourceDocId: documentId,
            targetCitation: citation.text,
            targetDocId: citationMatches.get(citation.id),
            context: citation.context,
            pageNumber: citation.pageNumber,
          });
        }
        if (citationMatches.size > 0) {
          console.log(`   Citations matchées: ${citationMatches.size}/${citations.length}`);
        }

        for (const { chunk, embedding } of chunksWithEmbeddings) {
          this.vectorStore.saveChunk(chunk, embedding);
        }

        // Un fichier, un document. Réindexer un PDF déjà présent le REMPLACE :
        // chaque bouton qui relançait l'indexation (tout indexer, télécharger
        // depuis Zotero, glisser-déposer, réindexer) ajoutait une copie, et
        // aucun garde-fou côté interface ne les couvrait tous. Fait APRÈS
        // l'écriture des nouveaux extraits, dans la même transaction : un échec
        // laisse l'ancienne copie intacte. Par le store de l'indexeur, qui
        // marque HNSW et BM25 périmés. Un PDF déplacé (même clé, même nom,
        // ancien fichier disparu) est remplacé de même, sans quoi il ferait
        // doublon. Un PDF renommé (autre nom) ne l'est pas : cf. `getMovedCopyIds`.
        const previousCopies = [
          ...new Set([
            ...this.vectorStore.getDocumentIdsByFilePath(filePath),
            ...(bibtexKey ? this.vectorStore.getMovedCopyIds(bibtexKey, filePath) : []),
          ]),
        ].filter((id) => id !== documentId);
        if (previousCopies.length > 0) {
          this.vectorStore.mergeDocumentsInto(documentId, previousCopies);
          console.log(`♻️  ${previousCopies.length} copie(s) précédente(s) remplacée(s)`);
        }
      });

      // Le document est validé : désormais, SQLite fait foi, et ce qui suit ne fait plus échouer la
      // passe. Un échec rendu au main lui faisait sauter le rattachement aux collections Zotero
      // (#130) et l'avertissement des PDF image (#132), pour un document complet en base que le lot
      // suivant compte indexé sans le reproposer.

      // 16. HNSW et BM25, hors transaction. En cas d'échec (index impossible à écrire : disque
      // plein, renommage refusé), `addToSearchIndexes` marque ces index périmés : la reconstruction
      // que `pdfService` planifie après chaque indexation y remettra ces extraits depuis SQLite, et
      // dira à l'historien si elle échoue à son tour.
      if (isEnhancedStore) {
        try {
          await (this.vectorStore as EnhancedVectorStore).addToSearchIndexes(chunksWithEmbeddings);
          onProgress?.({
            stage: 'embedding',
            progress: 95,
            message: 'Index HNSW et BM25 construits',
          });
        } catch (error) {
          console.error('⚠️ [INDEXER] Index HNSW et BM25 non mis à jour, reconstruction demandée :', error);
        }
      }

      // 17. Calculer les similarités avec les autres documents
      onProgress?.({
        stage: 'similarities',
        progress: 95,
        message: 'Calcul des similarités avec les autres documents...',
      });

      // Get the base VectorStore for similarity calculations
      const baseStore = isEnhancedStore
        ? (this.vectorStore as EnhancedVectorStore).getBaseStore()
        : (this.vectorStore as VectorStore);

      let similaritiesCount = 0;
      try {
        similaritiesCount = baseStore.computeAndSaveSimilarities(
          documentId,
          0.5 // Seuil de similarité
        );
      } catch (error) {
        console.error('⚠️ [INDEXER] Similarités entre documents non calculées :', error);
      }

      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: `✅ Indexation terminée: ${chunks.length} chunks, ${similaritiesCount} similarités`,
      });

      console.log(`✅ PDF indexé: ${document.title}`);
      console.log(`   - ${chunks.length} chunks`);
      console.log(`   - ${stats.totalWords} mots total`);
      console.log(`   - Moyenne: ${stats.averageWordCount} mots/chunk`);
      console.log(`   - ${similaritiesCount} similarités calculées`);

      return document;
    } catch (error) {
      console.error('❌ Erreur indexation PDF:', error);
      onProgress?.({
        stage: 'error',
        progress: 0,
        message: `Erreur: ${error}`,
      });
      throw error;
    }
  }

  /**
   * Indexe plusieurs PDFs en batch
   */
  async indexMultiplePDFs(
    filePaths: string[],
    onProgress?: (fileIndex: number, progress: IndexingProgress) => void
  ): Promise<PDFDocument[]> {
    const documents: PDFDocument[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];

      console.log(`\n📁 Indexation ${i + 1}/${filePaths.length}: ${filePath}`);

      try {
        const document = await this.indexPDF(filePath, undefined, (progress) => {
          onProgress?.(i, progress);
        });

        documents.push(document);
      } catch (error) {
        console.error(`❌ Erreur avec ${filePath}:`, error);
        // Continuer avec les autres fichiers
      }
    }

    console.log(`\n✅ Indexation batch terminée: ${documents.length}/${filePaths.length} PDFs`);

    return documents;
  }

  /**
   * Ré-indexe un document existant
   */
  async reindexPDF(documentId: string): Promise<void> {
    // Récupérer le document
    const document = this.vectorStore.getDocument(documentId);
    if (!document) {
      throw new Error(`Document introuvable: ${documentId}`);
    }

    console.log(`🔄 Ré-indexation: ${document.title}`);

    // Supprimer l'ancien (les chunks seront supprimés en CASCADE)
    this.vectorStore.deleteDocument(documentId);

    // Ré-indexer
    await this.indexPDF(document.fileURL, document.bibtexKey);
  }

  /**
   * Obtient les statistiques de la base vectorielle
   */
  getStatistics() {
    return this.vectorStore.getStatistics();
  }

  /**
   * Nettoie les chunks orphelins
   */
  cleanOrphanedChunks() {
    return this.vectorStore.cleanOrphanedChunks();
  }

  /**
   * Vérifie l'intégrité de la base
   */
  verifyIntegrity() {
    return this.vectorStore.verifyIntegrity();
  }
}
