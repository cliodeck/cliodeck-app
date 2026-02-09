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
import { projectManager } from './project-manager.js';

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

// MARK: - Service

class SimilarityService {
  private abortController: AbortController | null = null;

  /**
   * Analyze a document and find similar PDFs for each segment
   */
  async analyzeDocument(
    text: string,
    options: Partial<SimilarityOptions> = {},
    onProgress?: (progress: AnalysisProgress) => void
  ): Promise<SimilarityResult[]> {
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      throw new Error('No project is currently open');
    }

    // Merge with defaults
    const opts: SimilarityOptions = { ...DEFAULT_OPTIONS, ...options };

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
    const vectorStoreHash = await this.computeVectorStoreHash();

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
      } catch (error: any) {
        console.error(`❌ [SIMILARITY] Error analyzing segment ${i + 1}:`, error.message);
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
      documentHash,
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
   * Segment by sentences
   * Handles common abbreviations in French and English
   */
  private segmentBySentence(text: string): TextSegment[] {
    const segments: TextSegment[] = [];

    // Common abbreviations to not split on
    const abbreviations = [
      'M.',
      'Mme.',
      'Mlle.',
      'Dr.',
      'Pr.',
      'Prof.',
      'Mr.',
      'Mrs.',
      'Ms.',
      'Jr.',
      'Sr.',
      'vs.',
      'etc.',
      'cf.',
      'i.e.',
      'e.g.',
      'p.',
      'pp.',
      'vol.',
      'no.',
      'ed.',
      'eds.',
      'chap.',
      'fig.',
      'tab.',
      'op.',
      'cit.',
      'ibid.',
    ];

    // Replace abbreviations with placeholders
    let processedText = text;
    const placeholderMap: Map<string, string> = new Map();

    abbreviations.forEach((abbr, idx) => {
      const placeholder = `__ABBR_${idx}__`;
      const regex = new RegExp(abbr.replace('.', '\\.'), 'gi');
      processedText = processedText.replace(regex, (match) => {
        placeholderMap.set(placeholder, match);
        return placeholder;
      });
    });

    // Split on sentence-ending punctuation
    const sentencePattern = /[.!?]+[\s\n]+/g;
    const rawSentences = processedText.split(sentencePattern);

    // Track line numbers (approximate)
    const lines = text.split('\n');
    let currentLineIndex = 0;
    let charCount = 0;

    for (const sentence of rawSentences) {
      // Restore abbreviations
      let restoredSentence = sentence;
      placeholderMap.forEach((original, placeholder) => {
        restoredSentence = restoredSentence.replace(new RegExp(placeholder, 'g'), original);
      });

      const trimmed = restoredSentence.trim();
      if (trimmed.length > 0) {
        // Find approximate line number
        const startLine = currentLineIndex;
        let endLine = startLine;

        // Count how many lines this sentence spans
        const sentenceLines = trimmed.split('\n').length;
        endLine = Math.min(startLine + sentenceLines - 1, lines.length - 1);

        segments.push({
          id: this.computeHash(trimmed),
          content: trimmed,
          startLine,
          endLine,
          type: 'sentence',
        });

        // Update line tracking
        charCount += sentence.length;
        while (currentLineIndex < lines.length - 1) {
          const lineLength = lines[currentLineIndex].length + 1; // +1 for newline
          if (charCount <= lineLength) {
            break;
          }
          charCount -= lineLength;
          currentLineIndex++;
        }
      }
    }

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
    if (segment.content.trim().length < 20) {
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
          chunkPreview: result.chunk?.content?.substring(0, 200) || '',
          sourceType: 'primary',
          sourceId: result.source.id,
          archive: result.source.archive,
          collection: result.source.collection,
          date: result.source.date,
          tags: result.source.tags,
        });
      }
      // Handle secondary sources (PDFs)
      else if (result.document) {
        recommendations.push({
          pdfId: result.document.id,
          title: result.document.title || 'Sans titre',
          authors: result.document.author ? [result.document.author] : [],
          similarity: result.similarity,
          chunkPreview: result.chunk?.content?.substring(0, 200) || '',
          zoteroKey: result.document.bibtexKey,
          pageNumber: result.chunk?.pageNumber,
          sourceType: 'secondary',
        });
      }
    }

    // Apply LLM reranking if enabled and we have enough candidates
    if (options.useReranking && recommendations.length > 1) {
      try {
        recommendations = await this.rerankWithLLM(segment.content, recommendations);
        console.log('🔄 [SIMILARITY] Reranking applied successfully');
      } catch (error: any) {
        console.warn('⚠️  [SIMILARITY] Reranking failed, using original order:', error.message);
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
    const ollamaClient = pdfService.getOllamaClient();
    if (!ollamaClient) {
      throw new Error('Ollama client not available');
    }

    // Limit candidates to avoid context length issues
    const maxCandidates = Math.min(candidates.length, 10);
    const candidatesToRank = candidates.slice(0, maxCandidates);

    // Build the ranking prompt
    const candidateList = candidatesToRank
      .map((c, i) => {
        const preview = c.chunkPreview.substring(0, 150).replace(/\n/g, ' ');
        return `${i + 1}. "${c.title}" - ${preview}...`;
      })
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

    // Use generateResponse (non-streaming) for efficiency
    const response = await ollamaClient.generateResponse(prompt, []);
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

    // Reorder candidates based on ranking
    const reranked: PDFRecommendation[] = [];
    const seen = new Set<number>();

    for (const rank of ranking) {
      const index = rank - 1; // Convert 1-based to 0-based
      if (index >= 0 && index < candidatesToRank.length && !seen.has(index)) {
        // Update similarity to reflect new ranking (higher rank = higher score)
        const newSimilarity = (ranking.length - reranked.length) / ranking.length;
        reranked.push({
          ...candidatesToRank[index],
          similarity: newSimilarity,
        });
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

  async loadCache(projectPath: string): Promise<SimilarityCache | null> {
    try {
      const cachePath = this.getCachePath(projectPath);
      if (!fs.existsSync(cachePath)) {
        return null;
      }

      const content = fs.readFileSync(cachePath, 'utf-8');
      const cache = JSON.parse(content) as SimilarityCache;

      console.log('💾 [SIMILARITY] Cache loaded', {
        segmentCount: Object.keys(cache.segments).length,
        createdAt: new Date(cache.createdAt).toISOString(),
      });

      return cache;
    } catch (error: any) {
      console.warn('⚠️  [SIMILARITY] Failed to load cache:', error.message);
      return null;
    }
  }

  async saveCache(projectPath: string, cache: SimilarityCache): Promise<void> {
    try {
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
    } catch (error: any) {
      console.error('❌ [SIMILARITY] Failed to save cache:', error.message);
    }
  }

  async clearCache(projectPath?: string): Promise<void> {
    const targetPath = projectPath || projectManager.getCurrentProjectPath();
    if (!targetPath) {
      return;
    }

    try {
      const cachePath = this.getCachePath(targetPath);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
        console.log('🗑️  [SIMILARITY] Cache cleared');
      }
    } catch (error: any) {
      console.error('❌ [SIMILARITY] Failed to clear cache:', error.message);
    }
  }

  private isCacheValid(
    cache: SimilarityCache,
    documentHash: string,
    vectorStoreHash: string,
    options: SimilarityOptions
  ): boolean {
    // Check document and vector store haven't changed
    if (cache.documentHash !== documentHash || cache.vectorStoreHash !== vectorStoreHash) {
      console.log('💾 [SIMILARITY] Cache invalidated: content changed');
      return false;
    }

    // Check options match
    if (
      cache.options.granularity !== options.granularity ||
      cache.options.maxResults !== options.maxResults ||
      cache.options.similarityThreshold !== options.similarityThreshold
    ) {
      console.log('💾 [SIMILARITY] Cache invalidated: options changed');
      return false;
    }

    // Cache is valid for 24 hours
    const cacheAge = Date.now() - cache.createdAt;
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (cacheAge > maxAge) {
      console.log('💾 [SIMILARITY] Cache invalidated: too old');
      return false;
    }

    return true;
  }

  // MARK: - Hash Utilities

  private computeHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
  }

  private async computeVectorStoreHash(): Promise<string> {
    try {
      const stats = await pdfService.getStatistics();
      // Hash based on document count and last modification
      const hashInput = `${stats.documents}-${stats.chunks}`;
      return this.computeHash(hashInput);
    } catch {
      return 'unknown';
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
   * Get all cached results
   */
  async getAllCachedResults(): Promise<SimilarityResult[]> {
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      return [];
    }

    const cache = await this.loadCache(projectPath);
    if (!cache) {
      return [];
    }

    return Object.values(cache.segments);
  }
}

// Export singleton
export const similarityService = new SimilarityService();
