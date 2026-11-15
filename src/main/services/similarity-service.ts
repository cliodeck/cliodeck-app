/**
 * Similarity Finder Service
 *
 * Analyzes user's document (document.md) and finds similar content
 * in the indexed PDF corpus. Provides contextual bibliographic recommendations.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pdfService } from './pdf-service.js';
import { tropyService } from './tropy-service.js';
import { projectManager } from './project-manager.js';
import { workspaceLinkOutsideSync } from '../../../backend/core/workspace/link-guard.js';
import { assertProjectRoot } from '../../../backend/core/workspace/project-root.js';
import { sameFile } from '../../../backend/core/vector-store/file-identity.js';
import { toStoredPath } from '../../../backend/core/bibliography/stored-path.js';
import { chunkPreview } from '../../../backend/core/chunking/chunk-preview.js';

// MARK: - Types

export type Granularity = 'section' | 'paragraph' | 'sentence';
export type SourceType = 'secondary' | 'primary' | 'both';

export interface SimilarityOptions {
  granularity: Granularity;
  maxResults: number;
  similarityThreshold: number;
  collectionFilter: string[] | null;
  useReranking: boolean; // Use LLM to rerank results for better accuracy
  useContextualEmbedding: boolean; // Add document context to embeddings for better matching
  sourceType: SourceType; // Which sources to search: secondary (PDFs), primary (Tropy), or both
}

// Context extracted from the document for contextual embeddings
interface DocumentContext {
  title: string | null;
  currentSection: string | null;
}

export interface TextSegment {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
  type: Granularity;
  title?: string; // For sections: the heading text
}

export interface PDFRecommendation {
  pdfId: string;
  title: string;
  authors: string[];
  similarity: number;
  chunkPreview: string;
  zoteroKey?: string;
  pageNumber?: number;
  // Source type indicator
  sourceType?: 'secondary' | 'primary';
  // Primary source specific fields
  sourceId?: string;
  archive?: string;
  collection?: string;
  date?: string;
  tags?: string[];
}

export interface SimilarityResult {
  segmentId: string;
  segment: TextSegment;
  recommendations: PDFRecommendation[];
  analyzedAt: number;
}

export interface SimilarityCache {
  documentHash: string;
  /**
   * Le document analysé, rangé relatif au projet (`toStoredPath`) ; `null` pour un document sans
   * nom. Absent d'un cache écrit avant L11-2.
   */
  documentPath?: string | null;
  /** La version du contenu rangé (`SIMILARITY_CACHE_VERSION`). Absente d'un cache écrit avant L11-3. */
  version?: number;
  vectorStoreHash: string;
  segments: Record<string, SimilarityResult>;
  createdAt: number;
  options: SimilarityOptions;
}

export interface AnalysisProgress {
  current: number;
  total: number;
  status: string;
  percentage: number;
  currentSegment?: string;
}

// MARK: - Default Options

const DEFAULT_OPTIONS: SimilarityOptions = {
  granularity: 'paragraph',
  maxResults: 5,
  // Note: pdfService.search() already applies its own threshold (typically 0.12)
  // and has a fallback mechanism. This threshold is for additional filtering.
  // For cross-language search (e.g., FR document → EN PDFs), scores are often
  // in the 0.01-0.05 range. Setting to 0 to rely on pdfService's built-in filtering.
  similarityThreshold: 0,
  collectionFilter: null,
  useReranking: true, // Enable LLM reranking by default for better accuracy
  useContextualEmbedding: true, // Add document context to embeddings by default
  sourceType: 'secondary', // Default to secondary sources (PDFs) only
};

/**
 * Options effectives d'une analyse : celles du renderer par-dessus les
 * défauts. Exporté pour que le handler décide du consentement sur les mêmes
 * options que celles qu'appliquera l'analyse.
 */
export function resolveSimilarityOptions(
  options: Partial<SimilarityOptions> = {}
): SimilarityOptions {
  return { ...DEFAULT_OPTIONS, ...options };
}

/** L'empreinte de corpus qu'on n'a pas pu lire : aucun cache ne la vaut. */
const UNKNOWN_CORPUS = 'unknown';

/** Un cache vaut 24 heures. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * La version de ce que range le cache. Elle monte à chaque changement des segments ou des
 * recommandations rendus pour un même texte, avec les mêmes options et les mêmes corpus : sans
 * elle, un cache écrit avant restait servi jusqu'à 24 h. Un cache d'une autre version n'est ni
 * servi ni relu.
 *
 * 2 (L11-3) : la similarité reste le cosinus après reclassement, l'aperçu montre le passage
 * trouvé, et le découpage en phrases est refait (d'autres segments).
 */
export const SIMILARITY_CACHE_VERSION = 2;

/** En deçà, un segment (un intertitre, un astérisme) n'est pas cherché : il n'a aucune recommandation. */
const MIN_SEARCHED_LENGTH = 20;

const isSearched = (segment: TextSegment): boolean => segment.content.trim().length >= MIN_SEARCHED_LENGTH;

/**
 * Les fins de ligne ramenées à `\n`. L'éditeur rend le texte d'un fichier CRLF avec ses `\r\n`
 * (`getValue`), les segments se coupent sur `\n`, et l'id d'un segment est le hash de son contenu :
 * un `\r` resté en fin de ligne le changerait selon la forme reçue. L'analyse et la relecture du
 * cache segmentent donc le même texte.
 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Une fin de phrase possible : « . », « ! » ou « ? », suivis d'un blanc ou de la fin du texte. */
const SENTENCE_END_RE = /[.!?]+(?=\s|$)/gu;

/** Titres, toujours suivis d'un nom, comparés tels qu'écrits : « M. Dupont », mais « 4 000 m. » finit une phrase. */
const TITLE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'M', 'MM', 'Mme', 'Mmes', 'Mlle', 'Mlles', 'Dr', 'Pr', 'Prof', 'Mr', 'Mrs', 'Ms', 'Jr', 'Sr',
]);

/**
 * Jamais une fin de phrase, en minuscules : latin et renvois (« cf. », « op. cit. »), éditeur
 * (« ed. »), et en allemand « vgl. », « bzw. », « Hg. », « Hrsg. », « z.B. », « d.h. », « u.a. »
 * écrits sans blanc.
 */
const ALWAYS_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'cf', 'vs', 'i.e', 'e.g', 'op', 'cit', 'ibid', 'ed', 'eds',
  'vgl', 'bzw', 'hg', 'hrsg', 'z.b', 'd.h', 'u.a',
]);

/** Les mêmes, écrites avec un blanc entre leurs deux lettres : « z. B. », « d. h. », « u. a. », « i. e. », « e. g. ». */
const SPACED_ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ['z', 'b'], ['d', 'h'], ['u', 'a'], ['i', 'e'], ['e', 'g'],
];

/**
 * Des abréviations seulement devant un nombre, en minuscules : « p. 12 », « vol. II, », « S. 12 »
 * (Seite), « Nr. 5 », « Bd. 3 ». Ailleurs, « vol », « no », « fig », « chap » ou « tab » sont des
 * mots qui peuvent finir une phrase (« C'était un vol. »).
 */
const BEFORE_NUMBER_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'p', 'pp', 'vol', 'no', 'chap', 'fig', 'tab', 's', 'nr', 'bd',
]);

/**
 * Un nombre après l'abréviation : des chiffres, ou des chiffres romains suivis d'une ponctuation
 * (« vol. II, »). Suivis d'un blanc, ils ne comptent pas : « He said no. I left. »
 */
const NUMBER_AHEAD = /^\s+(?:\p{N}|[IVXLCDM]+[,.;:)\]])/u;

/** « etc. », « usw. » : la fin d'une énumération, et d'une phrase seulement devant une capitale. */
const LIST_END_ABBREVIATIONS: ReadonlySet<string> = new Set(['etc', 'usw']);

/** Le mot qui précède un point : ce qui suit le dernier blanc ou la dernière ouverture (« ( », « « »…). */
const WORD_BEFORE = /[^\s«"“‘([]*$/u;

/**
 * Vrai si le point en `dot` termine une abréviation et pas une phrase. Le mot qui précède se
 * compare en entier : « signed. » ne finit pas par l'abréviation « ed. ».
 */
function isAbbreviationDot(text: string, dot: number): boolean {
  const word = WORD_BEFORE.exec(text.slice(Math.max(0, dot - 40), dot))?.[0] ?? '';
  if (word === '') return false;
  if (TITLE_ABBREVIATIONS.has(word)) return true;

  const lower = word.toLowerCase();
  if (ALWAYS_ABBREVIATIONS.has(lower)) return true;

  const ahead = text.slice(dot + 1, dot + 12);
  if (BEFORE_NUMBER_ABBREVIATIONS.has(lower)) return NUMBER_AHEAD.test(ahead);
  if (LIST_END_ABBREVIATIONS.has(lower)) return !/^\s+\p{Lu}/u.test(ahead);

  // « z. B. » : au premier point, la lettre qui suit ; au second, celle qui précède.
  const next = /^\s(\p{L})\./u.exec(ahead)?.[1]?.toLowerCase();
  const behind = text.slice(Math.max(0, dot - word.length - 4), dot - word.length);
  const before = /(?:^|[^\p{L}\p{N}])(\p{L})\.\s$/u.exec(behind)?.[1]?.toLowerCase();
  return SPACED_ABBREVIATIONS.some(
    ([first, second]) => (lower === first && next === second) || (lower === second && before === first)
  );
}

/** Les sept options, collections triées : tout ce qui change les recommandations (S13-1-3). */
function optionsFingerprint(options: SimilarityOptions): string {
  return JSON.stringify([
    options.granularity,
    options.maxResults,
    options.similarityThreshold,
    options.collectionFilter ? [...options.collectionFilter].sort() : null,
    options.useReranking,
    options.useContextualEmbedding,
    options.sourceType,
  ]);
}

// MARK: - Service

class SimilarityService {
  private abortController: AbortController | null = null;
  /**
   * Typed LLM provider (fusion 1.2a). Callers (similarity-handlers IPC,
   * tests) wire this from a `ProviderRegistry` built off the active
   * workspace config before invoking `analyzeDocument`. `rerankWithLLM`
   * fails loud if it isn't set — the previous legacy `OllamaClient`
   * fallback is gone.
   */
  private llm: import('../../../backend/core/llm/providers/base').LLMProvider | null = null;

  setLLMProvider(
    llm:
      | import('../../../backend/core/llm/providers/base').LLMProvider
      | null
  ): void {
    this.llm = llm;
  }

  /**
   * Analyze a document and find similar PDFs for each segment. `documentPath` est le fichier du
   * document analysé (`null` sans nom) : le cache n'en rend les segments qu'à lui (S13-1-3).
   */
  async analyzeDocument(
    documentText: string,
    options: Partial<SimilarityOptions> = {},
    onProgress?: (progress: AnalysisProgress) => void,
    documentPath: string | null = null
  ): Promise<SimilarityResult[]> {
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      throw new Error('No project is currently open');
    }
    const text = toLf(documentText);

    // Merge with defaults
    const opts = resolveSimilarityOptions(options);

    console.log('🔍 [SIMILARITY] Starting document analysis', {
      granularity: opts.granularity,
      maxResults: opts.maxResults,
      threshold: opts.similarityThreshold,
      textLength: text.length,
    });

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    // Compute hashes for caching
    const documentHash = this.computeHash(text);
    const vectorStoreHash = this.computeVectorStoreHash(opts.sourceType, opts.collectionFilter);

    // Try to load from cache
    const cache = await this.loadCache(projectPath);
    if (cache && this.isCacheValid(cache, documentHash, vectorStoreHash, opts)) {
      console.log('💾 [SIMILARITY] Using cached results');
      onProgress?.({
        current: 100,
        total: 100,
        status: 'Résultats en cache chargés',
        percentage: 100,
      });
      return Object.values(cache.segments);
    }

    // Extract document-level context for contextual embeddings
    const documentContext = this.extractDocumentContext(text);
    console.log('📄 [SIMILARITY] Document context:', documentContext);

    // Segment the text
    const segments = this.segmentText(text, opts.granularity);
    console.log(`📝 [SIMILARITY] Document split into ${segments.length} segments`);

    if (segments.length === 0) {
      console.warn('⚠️  [SIMILARITY] No segments found in document');
      return [];
    }

    // Build section map for contextual embeddings (maps line number to section title)
    const sectionMap = this.buildSectionMap(text);

    const results: SimilarityResult[] = [];
    const total = segments.length;

    // Process each segment
    for (let i = 0; i < segments.length; i++) {
      // Check for cancellation
      if (this.abortController?.signal.aborted) {
        console.log('⚠️  [SIMILARITY] Analysis cancelled');
        throw new Error('Analysis cancelled by user');
      }

      const segment = segments[i];
      const segmentTitle = segment.title || segment.content.substring(0, 50) + '...';

      // Get current section context for this segment
      const currentSection = sectionMap.get(segment.startLine) || segment.title || null;
      const segmentContext: DocumentContext = {
        title: documentContext.title,
        currentSection,
      };

      onProgress?.({
        current: i + 1,
        total,
        status: `Analyse du segment ${i + 1}/${total}`,
        percentage: Math.round(((i + 1) / total) * 100),
        currentSegment: segmentTitle,
      });

      try {
        const recommendations = await this.findSimilarPDFs(segment, opts, segmentContext);

        results.push({
          segmentId: segment.id,
          segment,
          recommendations,
          analyzedAt: Date.now(),
        });
      } catch (error: unknown) {
        console.error(`❌ [SIMILARITY] Error analyzing segment ${i + 1}:`, (error instanceof Error ? error.message : String(error)));
        // Continue with other segments
        results.push({
          segmentId: segment.id,
          segment,
          recommendations: [],
          analyzedAt: Date.now(),
        });
      }
    }

    // Save to cache
    await this.saveCache(projectPath, {
      version: SIMILARITY_CACHE_VERSION,
      documentHash,
      documentPath: documentPath ? toStoredPath(documentPath, projectPath) : null,
      vectorStoreHash,
      segments: Object.fromEntries(results.map((r) => [r.segmentId, r])),
      createdAt: Date.now(),
      options: opts,
    });

    console.log('✅ [SIMILARITY] Analysis complete', {
      segmentsAnalyzed: results.length,
      totalRecommendations: results.reduce((sum, r) => sum + r.recommendations.length, 0),
    });

    return results;
  }

  /**
   * Cancel ongoing analysis
   */
  cancelAnalysis(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      console.log('⚠️  [SIMILARITY] Analysis cancellation requested');
    }
  }

  /**
   * Extract document-level context (title from first H1)
   */
  private extractDocumentContext(text: string): DocumentContext {
    const lines = text.split('\n');
    let title: string | null = null;

    // Look for first H1 heading as document title
    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)$/);
      if (h1Match) {
        title = h1Match[1].trim();
        break;
      }
    }

    return { title, currentSection: null };
  }

  /**
   * Build a map of line numbers to their containing section title
   * Used for contextual embeddings to know which section a paragraph belongs to
   */
  private buildSectionMap(text: string): Map<number, string> {
    const lines = text.split('\n');
    const sectionMap = new Map<number, string>();
    let currentSection: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^#{1,6}\s+(.+)$/);

      if (headingMatch) {
        currentSection = headingMatch[1].trim();
      }

      if (currentSection) {
        sectionMap.set(i, currentSection);
      }
    }

    return sectionMap;
  }

  /**
   * Build a contextual query by adding document context
   * This helps the embedding model understand the broader topic
   */
  private buildContextualQuery(
    segmentContent: string,
    context: DocumentContext,
    options: SimilarityOptions
  ): string {
    if (!options.useContextualEmbedding) {
      return segmentContent;
    }

    const parts: string[] = [];

    if (context.title) {
      parts.push(`Document: ${context.title}`);
    }

    if (context.currentSection) {
      parts.push(`Section: ${context.currentSection}`);
    }

    if (parts.length > 0) {
      parts.push(''); // Empty line before content
      parts.push(`Content: ${segmentContent}`);
      return parts.join('\n');
    }

    return segmentContent;
  }

  /**
   * Segment text based on granularity
   */
  segmentText(text: string, granularity: Granularity): TextSegment[] {
    switch (granularity) {
      case 'section':
        return this.segmentBySection(text);
      case 'paragraph':
        return this.segmentByParagraph(text);
      case 'sentence':
        return this.segmentBySentence(text);
      default:
        return this.segmentByParagraph(text);
    }
  }

  /**
   * Segment by Markdown headings (#, ##, ###, etc.)
   */
  private segmentBySection(text: string): TextSegment[] {
    const lines = text.split('\n');
    const segments: TextSegment[] = [];

    let currentSection: { title: string; content: string[]; startLine: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Save previous section if exists
        if (currentSection && currentSection.content.length > 0) {
          const content = currentSection.content.join('\n').trim();
          if (content.length > 0) {
            segments.push({
              id: this.computeHash(content),
              content,
              startLine: currentSection.startLine,
              endLine: i - 1,
              type: 'section',
              title: currentSection.title,
            });
          }
        }

        // Start new section
        currentSection = {
          title: headingMatch[2].trim(),
          content: [],
          startLine: i,
        };
      } else if (currentSection) {
        currentSection.content.push(line);
      } else {
        // Content before first heading - create an intro section
        if (line.trim().length > 0) {
          if (!currentSection) {
            currentSection = {
              title: 'Introduction',
              content: [line],
              startLine: i,
            };
          }
        }
      }
    }

    // Don't forget last section
    if (currentSection && currentSection.content.length > 0) {
      const content = currentSection.content.join('\n').trim();
      if (content.length > 0) {
        segments.push({
          id: this.computeHash(content),
          content,
          startLine: currentSection.startLine,
          endLine: lines.length - 1,
          type: 'section',
          title: currentSection.title,
        });
      }
    }

    return segments;
  }

  /**
   * Segment by paragraphs (separated by blank lines)
   */
  private segmentByParagraph(text: string): TextSegment[] {
    const lines = text.split('\n');
    const segments: TextSegment[] = [];

    let currentParagraph: string[] = [];
    let startLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() === '') {
        // End of paragraph
        if (currentParagraph.length > 0) {
          const content = currentParagraph.join('\n').trim();
          if (content.length > 0) {
            segments.push({
              id: this.computeHash(content),
              content,
              startLine,
              endLine: i - 1,
              type: 'paragraph',
            });
          }
          currentParagraph = [];
        }
        startLine = i + 1;
      } else {
        if (currentParagraph.length === 0) {
          startLine = i;
        }
        currentParagraph.push(line);
      }
    }

    // Don't forget last paragraph
    if (currentParagraph.length > 0) {
      const content = currentParagraph.join('\n').trim();
      if (content.length > 0) {
        segments.push({
          id: this.computeHash(content),
          content,
          startLine,
          endLine: lines.length - 1,
          type: 'paragraph',
        });
      }
    }

    return segments;
  }

  /**
   * Segment by sentences. Une phrase finit sur « . », « ! » ou « ? » suivis d'un blanc ou de la fin
   * du texte, sauf après une abréviation (`isAbbreviationDot`). Le texte n'est pas transformé : chaque
   * phrase est découpée dans l'original, ponctuation comprise, et ses lignes se comptent à sa position
   * (S13-1-7). Les abréviations devenaient des marqueurs sans limite de mot (« M. » prenait la fin de
   * « Potsdam. ») et les lignes se comptaient sur le texte à marqueurs.
   */
  private segmentBySentence(text: string): TextSegment[] {
    const segments: TextSegment[] = [];

    // Les positions croissent : les lignes se comptent au fil du texte.
    let line = 0;
    let scanned = 0;
    const lineAt = (position: number): number => {
      for (; scanned < position; scanned++) if (text[scanned] === '\n') line++;
      return line;
    };

    let start = 0;
    const cut = (end: number) => {
      const raw = text.slice(start, end);
      const content = raw.trim();
      if (content.length > 0) {
        const from = start + raw.length - raw.trimStart().length;
        segments.push({
          id: this.computeHash(content),
          content,
          startLine: lineAt(from),
          endLine: lineAt(from + content.length - 1),
          type: 'sentence',
        });
      }
      start = end;
    };

    for (const match of text.matchAll(SENTENCE_END_RE)) {
      const at = match.index ?? 0;
      if (match[0] === '.' && isAbbreviationDot(text, at)) continue;
      cut(at + match[0].length);
    }
    cut(text.length);

    return segments;
  }

  /**
   * Find similar PDFs for a given segment
   */
  private async findSimilarPDFs(
    segment: TextSegment,
    options: SimilarityOptions,
    context: DocumentContext = { title: null, currentSection: null }
  ): Promise<PDFRecommendation[]> {
    // Skip very short segments (less than 20 characters)
    if (!isSearched(segment)) {
      return [];
    }

    // Get more candidates for reranking (3x if reranking enabled, 2x otherwise)
    const candidateMultiplier = options.useReranking ? 3 : 2;

    // Build contextual query if enabled
    const searchQuery = this.buildContextualQuery(segment.content, context, options);

    if (options.useContextualEmbedding && searchQuery !== segment.content) {
      console.log('🎯 [SIMILARITY] Using contextual query:', {
        documentTitle: context.title,
        section: context.currentSection,
        originalLength: segment.content.length,
        contextualLength: searchQuery.length,
      });
    }

    // Use the existing search functionality with contextual query
    // Pass sourceType to search both secondary (PDFs) and primary (Tropy) sources
    const searchResults = await pdfService.search(searchQuery, {
      topK: options.maxResults * candidateMultiplier,
      collectionKeys: options.collectionFilter || undefined,
      sourceType: options.sourceType || 'secondary',
    });

    // Filter by similarity threshold and deduplicate by document
    let recommendations: PDFRecommendation[] = [];

    for (const result of searchResults) {
      if (result.similarity < options.similarityThreshold) {
        continue;
      }

      // Get unique ID based on source type
      const resultId = result.sourceType === 'primary'
        ? result.source?.id
        : result.document?.id;

      // Skip if we already have a recommendation from this document/source
      if (recommendations.some((r) => {
        if (result.sourceType === 'primary') {
          return r.sourceId === resultId;
        }
        return r.pdfId === resultId;
      })) {
        continue;
      }

      // Handle primary sources (Tropy)
      if (result.sourceType === 'primary' && result.source) {
        recommendations.push({
          pdfId: result.source.id || '',
          title: result.source.title || 'Sans titre',
          authors: result.source.creator ? [result.source.creator] : [],
          similarity: result.similarity,
          chunkPreview: chunkPreview(result.chunk?.content ?? '', segment.content),
          sourceType: 'primary',
          sourceId: result.source.id,
          archive: result.source.archive,
          collection: result.source.collection,
          date: result.source.date,
          tags: (result.source as any).tags,
        });
      }
      // Handle secondary sources (PDFs)
      else if (result.document) {
        recommendations.push({
          pdfId: result.document.id,
          title: result.document.title || 'Sans titre',
          authors: result.document.author ? [result.document.author] : [],
          similarity: result.similarity,
          chunkPreview: chunkPreview(result.chunk?.content ?? '', segment.content),
          zoteroKey: result.document.bibtexKey,
          pageNumber: (result.chunk as any)?.pageNumber,
          sourceType: 'secondary',
        });
      }
    }

    // Apply LLM reranking if enabled and we have enough candidates
    if (options.useReranking && recommendations.length > 1) {
      try {
        recommendations = await this.rerankWithLLM(segment.content, recommendations);
        console.log('🔄 [SIMILARITY] Reranking applied successfully');
      } catch (error: unknown) {
        console.warn('⚠️  [SIMILARITY] Reranking failed, using original order:', (error instanceof Error ? error.message : String(error)));
        // Fall back to original order if reranking fails
      }
    }

    // Limit to maxResults after reranking
    return recommendations.slice(0, options.maxResults);
  }

  /**
   * Rerank recommendations using LLM listwise comparison
   *
   * Asks the LLM to rank all candidates at once, which is more efficient
   * and often more accurate than pairwise or pointwise scoring.
   */
  private async rerankWithLLM(
    query: string,
    candidates: PDFRecommendation[]
  ): Promise<PDFRecommendation[]> {
    if (!this.llm) {
      throw new Error(
        'similarity-service: LLM provider not wired (call setLLMProvider before analyzeDocument)'
      );
    }

    // Limit candidates to avoid context length issues
    const maxCandidates = Math.min(candidates.length, 10);
    const candidatesToRank = candidates.slice(0, maxCandidates);

    // Build the ranking prompt. L'aperçu entier : le passage trouvé, sans le titre que l'en-tête
    // de l'extrait répétait (S13-2-0).
    const candidateList = candidatesToRank
      .map((c, i) => `${i + 1}. "${c.title}" - ${c.chunkPreview}`)
      .join('\n');

    const prompt = `You are a research assistant helping to find relevant academic sources.

Given this text from a document being written:
---
${query.substring(0, 500)}
---

Rank these potential source documents by relevance (most relevant first).
Consider: topic match, conceptual similarity, and potential usefulness as a citation.

Documents to rank:
${candidateList}

Return ONLY the numbers in order from most to least relevant, separated by commas.
Example response: 3, 1, 4, 2, 5

Your ranking:`;

    console.log('🔄 [SIMILARITY] Sending reranking request to LLM...');
    const startTime = Date.now();

    // Use complete() (non-streaming) for efficiency.
    const response = await this.llm.complete(prompt);
    const duration = Date.now() - startTime;

    console.log('🔄 [SIMILARITY] LLM reranking response:', {
      duration: `${duration}ms`,
      response: response.substring(0, 100),
    });

    // Parse the ranking from the response
    const ranking = this.parseRankingResponse(response, candidatesToRank.length);

    if (ranking.length === 0) {
      console.warn('⚠️  [SIMILARITY] Could not parse ranking, keeping original order');
      return candidates;
    }

    // Reorder candidates based on ranking. Seul l'ordre vient du modèle : la similarité reste le
    // cosinus de la recherche (contrat Path A′). Un score de rang affichait « 100 % » pour le
    // premier, quelle que soit sa proximité réelle (S13-1-33).
    const reranked: PDFRecommendation[] = [];
    const seen = new Set<number>();

    for (const rank of ranking) {
      const index = rank - 1; // Convert 1-based to 0-based
      if (index >= 0 && index < candidatesToRank.length && !seen.has(index)) {
        reranked.push(candidatesToRank[index]);
        seen.add(index);
      }
    }

    // Add any candidates that weren't in the ranking (shouldn't happen, but safety)
    for (let i = 0; i < candidatesToRank.length; i++) {
      if (!seen.has(i)) {
        reranked.push(candidatesToRank[i]);
      }
    }

    // Add remaining candidates that weren't ranked (beyond maxCandidates)
    if (candidates.length > maxCandidates) {
      reranked.push(...candidates.slice(maxCandidates));
    }

    return reranked;
  }

  /**
   * Parse the LLM's ranking response into an array of indices
   */
  private parseRankingResponse(response: string, expectedCount: number): number[] {
    // Extract numbers from the response
    const numbers = response.match(/\d+/g);

    if (!numbers) {
      return [];
    }

    // Parse and validate
    const ranking: number[] = [];
    const seen = new Set<number>();

    for (const numStr of numbers) {
      const num = parseInt(numStr, 10);
      // Only accept numbers within valid range and not duplicates
      if (num >= 1 && num <= expectedCount && !seen.has(num)) {
        ranking.push(num);
        seen.add(num);
      }
    }

    return ranking;
  }

  // MARK: - Cache Management

  private getCachePath(projectPath: string): string {
    return path.join(projectPath, '.cliodeck', 'similarity_cache.json');
  }

  /** `.cliodeck`, ou ce cache lui-même, lié hors du projet (D18) : il serait celui d'un autre projet. */
  private cacheLinkedOutside(projectPath: string): boolean {
    const entry = workspaceLinkOutsideSync(projectPath);
    if (entry) console.warn('⚠️ [SIMILARITY] Cache ignoré, lien hors du projet :', entry);
    return entry !== null;
  }

  async loadCache(projectPath: string): Promise<SimilarityCache | null> {
    if (this.cacheLinkedOutside(projectPath)) return null;
    try {
      const cachePath = this.getCachePath(projectPath);
      if (!fs.existsSync(cachePath)) {
        return null;
      }

      const content = fs.readFileSync(cachePath, 'utf-8');
      const cache = JSON.parse(content) as SimilarityCache;
      if (cache.version !== SIMILARITY_CACHE_VERSION) {
        console.log('💾 [SIMILARITY] Cache ignoré, version de son contenu dépassée', { version: cache.version ?? null });
        return null;
      }

      console.log('💾 [SIMILARITY] Cache loaded', {
        segmentCount: Object.keys(cache.segments).length,
        createdAt: new Date(cache.createdAt).toISOString(),
      });

      return cache;
    } catch (error: unknown) {
      console.warn('⚠️  [SIMILARITY] Failed to load cache:', (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }

  async saveCache(projectPath: string, cache: SimilarityCache): Promise<void> {
    if (this.cacheLinkedOutside(projectPath)) return;
    try {
      // Le dossier du projet a disparu pendant l'analyse (déplacé, évincé) : il n'est pas recréé
      // pour ce seul cache (L03-3b).
      await assertProjectRoot(projectPath);
      const cachePath = this.getCachePath(projectPath);
      const cacheDir = path.dirname(cachePath);

      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
      console.log('💾 [SIMILARITY] Cache saved', {
        path: cachePath,
        segmentCount: Object.keys(cache.segments).length,
      });
    } catch (error: unknown) {
      console.error('❌ [SIMILARITY] Failed to save cache:', (error instanceof Error ? error.message : String(error)));
    }
  }

  async clearCache(projectPath?: string): Promise<void> {
    const targetPath = projectPath || projectManager.getCurrentProjectPath();
    if (!targetPath || this.cacheLinkedOutside(targetPath)) {
      return;
    }

    try {
      const cachePath = this.getCachePath(targetPath);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
        console.log('🗑️  [SIMILARITY] Cache cleared');
      }
    } catch (error: unknown) {
      console.error('❌ [SIMILARITY] Failed to clear cache:', (error instanceof Error ? error.message : String(error)));
    }
  }

  private isCacheValid(
    cache: SimilarityCache,
    documentHash: string,
    vectorStoreHash: string,
    options: SimilarityOptions
  ): boolean {
    // Check document and vector store haven't changed. Un corpus illisible n'est jamais le même.
    if (
      vectorStoreHash === UNKNOWN_CORPUS ||
      cache.documentHash !== documentHash ||
      cache.vectorStoreHash !== vectorStoreHash
    ) {
      console.log('💾 [SIMILARITY] Cache invalidated: content changed');
      return false;
    }

    // Check options match
    if (optionsFingerprint(cache.options) !== optionsFingerprint(options)) {
      console.log('💾 [SIMILARITY] Cache invalidated: options changed');
      return false;
    }

    if (this.isExpired(cache)) {
      console.log('💾 [SIMILARITY] Cache invalidated: too old');
      return false;
    }

    return true;
  }

  /** Plus de 24 heures, ou sans date lisible. */
  private isExpired(cache: SimilarityCache): boolean {
    const age = Date.now() - cache.createdAt;
    return !Number.isFinite(age) || age > CACHE_MAX_AGE_MS;
  }

  // MARK: - Hash Utilities

  private computeHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
  }

  /**
   * Empreinte des seuls corpus où cherche l'analyse (S13-1-1). Elle lisait `stats.documents` et
   * `stats.chunks`, que `getStatistics` ne rend pas : elle ne changeait jamais, et des PDF indexés
   * après une analyse restaient invisibles 24 h. Une reconstruction de l'index ne la change pas : les
   * extraits et leurs vecteurs restent les mêmes. Sauf si elle était due (J8) : l'index servi avant
   * elle pouvait en manquer, et une analyse faite alors est à refaire. Avec un filtre de collections,
   * les documents qu'il retient en sont aussi : une synchronisation Zotero change l'appartenance sans
   * rien réindexer.
   */
  private computeVectorStoreHash(sourceType: SourceType, collectionFilter: string[] | null): string {
    try {
      const corpora = {
        secondary: sourceType === 'primary' ? null : pdfService.getIndexFreshness(collectionFilter),
        primary: sourceType === 'secondary' ? null : tropyService.getIndexFreshness(),
      };
      return this.computeHash(JSON.stringify(corpora));
    } catch {
      return UNKNOWN_CORPUS;
    }
  }

  /**
   * Get results for a specific segment from cache
   */
  async getResultsForSegment(segmentId: string): Promise<SimilarityResult | null> {
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      return null;
    }

    const cache = await this.loadCache(projectPath);
    if (!cache) {
      return null;
    }

    return cache.segments[segmentId] || null;
  }

  /**
   * Les résultats en cache pour le document ouvert, `text` dans `documentPath` (S13-1-3). Le cache
   * est unique par projet, et il était rendu quel que soit ce document : dans un livre, les segments
   * et les lignes de l'analyse du chapitre 3 s'affichaient sur le chapitre 5.
   *
   * Le texte exact de l'analyse la rend toute, quel que soit le fichier (« Enregistrer sous »).
   * Sinon, il faut le document analysé : un autre chapitre ne rend rien, même s'il partage avec lui
   * ses intertitres (« ## Introduction ») ou un astérisme, segments identiques d'un chapitre à
   * l'autre. Le texte est alors resegmenté comme à l'analyse, et seuls reviennent les segments qui y
   * sont encore, à leurs lignes actuelles : un paragraphe retouché ne fait pas perdre les autres. S'il
   * n'en reste que de trop courts pour avoir été cherchés, rien : « 2 segments analysés » mentirait.
   * Un document sans nom n'a que son texte exact. Un cache trop vieux, ou fait sur un autre état des
   * corpus, ne rend rien.
   */
  async getAllCachedResults(text: string, documentPath: string | null = null): Promise<SimilarityResult[]> {
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath || text.trim() === '') {
      return [];
    }

    const cache = await this.loadCache(projectPath);
    if (!cache || this.isExpired(cache)) {
      return [];
    }
    const vectorStoreHash = this.computeVectorStoreHash(cache.options.sourceType, cache.options.collectionFilter);
    if (vectorStoreHash === UNKNOWN_CORPUS || vectorStoreHash !== cache.vectorStoreHash) {
      return [];
    }

    const lf = toLf(text);
    const sameText = this.computeHash(lf) === cache.documentHash;
    if (!sameText && !this.isAnalysedDocument(projectPath, cache, documentPath)) {
      return [];
    }

    const results: SimilarityResult[] = [];
    for (const segment of this.segmentText(lf, cache.options.granularity)) {
      const cached = cache.segments[segment.id];
      if (cached) results.push({ ...cached, segment });
    }
    if (!sameText && !results.some((r) => isSearched(r.segment))) {
      return [];
    }
    return results;
  }

  /** `documentPath` est-il le fichier de l'analyse en cache ? Sans nom de part ou d'autre, non. */
  private isAnalysedDocument(projectPath: string, cache: SimilarityCache, documentPath: string | null): boolean {
    if (!cache.documentPath || !documentPath) return false;
    return sameFile(path.resolve(projectPath, cache.documentPath), documentPath);
  }
}

// Export singleton
export const similarityService = new SimilarityService();
