import { randomUUID } from 'crypto';
import type { DocumentPage, DocumentChunk } from '../../types/pdf-document';
import { CHUNKING_CONFIGS, type ChunkingConfig } from './DocumentChunker';

/**
 * Adaptive Chunker using structure-aware splitting
 *
 * Instead of fixed-size chunks, this chunker:
 * 1. Detects document structure (sections, subsections)
 * 2. Keeps semantically related content together
 * 3. Respects natural boundaries (paragraphs, sections)
 *
 * Benefits:
 * - Better semantic coherence within chunks
 * - More meaningful context for RAG
 * - Improved retrieval accuracy (+10-15%)
 *
 * Performance: Pure regex-based, no ML overhead
 * Memory: Same as standard chunker
 */
export class AdaptiveChunker {
  private config: ChunkingConfig;

  constructor(config: ChunkingConfig = CHUNKING_CONFIGS.cpuOptimized) {
    this.config = config;
  }

  /**
   * Create chunks using adaptive structure-aware strategy
   */
  createChunks(
    pages: DocumentPage[],
    documentId: string,
    documentMeta?: { title?: string; abstract?: string }
  ): DocumentChunk[] {
    const sections = this.detectSections(this.toLines(pages));

    // Chunk each section
    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const section of sections) {
      // Skip references section (low value for RAG)
      if (section.type === 'references') {
        console.log(`⏭️  Skipping references section (low RAG value)`);
        continue;
      }

      const sectionChunks = this.chunkSection(section, documentId, chunkIndex, documentMeta);
      chunks.push(...sectionChunks);
      chunkIndex += sectionChunks.length;
    }

    console.log(
      `✅ ${chunks.length} adaptive chunks created (${sections.length} sections detected)`
    );

    return chunks;
  }

  /**
   * Les lignes du document, chacune avec sa page et sa position dans le texte
   * complet (les pages jointes par une ligne vide).
   *
   * La page voyage avec le texte au lieu d'être recalculée après coup à partir
   * de longueurs cumulées : c'est ce recalcul qui faisait dériver les numéros
   * de page, le recouvrement entre extraits y étant compté deux fois (#160).
   */
  private toLines(pages: DocumentPage[]): SourceLine[] {
    const lines: SourceLine[] = [];
    let pageStart = 0;

    for (const page of pages) {
      let offset = 0;
      for (const raw of page.text.split('\n')) {
        const indent = raw.length - raw.trimStart().length;
        lines.push({
          text: raw.trim(),
          position: pageStart + offset + indent,
          pageNumber: page.pageNumber,
        });
        offset += raw.length + 1;
      }
      pageStart += page.text.length + 2; // « \n\n » entre deux pages
    }

    return lines;
  }

  /**
   * Detect document sections using common academic patterns.
   *
   * Ce qui précède le premier titre reconnu forme une section à part entière :
   * le jeter, comme c'était le cas, faisait disparaître de l'index la page de
   * titre, le résumé ou une introduction sans numéro.
   */
  private detectSections(lines: SourceLine[]): Section[] {
    const sections: Section[] = [];
    let current: Section = { title: 'Document', level: 1, type: 'content', lines: [] };
    const hasText = (section: Section) => section.lines.some((line) => line.text.length > 0);

    for (const line of lines) {
      const headerMatch = this.matchSectionHeader(line.text);

      if (headerMatch) {
        if (hasText(current)) sections.push(current);
        current = {
          title: headerMatch.title,
          level: headerMatch.level,
          type: this.classifySectionType(headerMatch.title),
          lines: [],
        };
      } else {
        current.lines.push(line);
      }
    }

    if (hasText(current)) sections.push(current);

    return sections;
  }

  /**
   * Match section headers using regex patterns
   */
  private matchSectionHeader(line: string): { title: string; level: number } | null {
    // Markdown headers: # Header, ## Subheader
    const markdownMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (markdownMatch) {
      return {
        title: markdownMatch[2],
        level: markdownMatch[1].length,
      };
    }

    // Numbered sections: "1. Introduction", "1.1 Background"
    const numberedMatch = line.match(/^(\d+(?:\.\d+)*)\.\s+([A-Z][^.]{2,50})$/);
    if (numberedMatch) {
      const depth = numberedMatch[1].split('.').length;
      return {
        title: numberedMatch[2],
        level: depth,
      };
    }

    // Roman numerals: "I. Introduction", "II. Methodology"
    const romanMatch = line.match(/^([IVX]+)\.\s+([A-Z][^.]{2,50})$/);
    if (romanMatch) {
      return {
        title: romanMatch[2],
        level: 1,
      };
    }

    // ALL CAPS headers (common in older papers)
    const capsMatch = line.match(/^([A-Z][A-Z\s]{5,50})$/);
    if (capsMatch && line.length < 60) {
      const commonHeaders = [
        'ABSTRACT',
        'INTRODUCTION',
        'METHODOLOGY',
        'METHODS',
        'RESULTS',
        'DISCUSSION',
        'CONCLUSION',
        'REFERENCES',
        'BIBLIOGRAPHY',
        'ACKNOWLEDGMENTS',
      ];
      if (commonHeaders.some((h) => line.toUpperCase().includes(h))) {
        return {
          title: line,
          level: 1,
        };
      }
    }

    return null;
  }

  /**
   * Classify section type (intro, method, results, etc.)
   */
  private classifySectionType(title: string): SectionType {
    const titleLower = title.toLowerCase();

    if (
      titleLower.includes('abstract') ||
      titleLower.includes('résumé') ||
      titleLower.includes('summary')
    ) {
      return 'abstract';
    }

    if (
      titleLower.includes('introduction') ||
      titleLower.includes('background') ||
      titleLower.includes('context')
    ) {
      return 'introduction';
    }

    if (
      titleLower.includes('method') ||
      titleLower.includes('méthodologie') ||
      titleLower.includes('approach') ||
      titleLower.includes('design')
    ) {
      return 'methodology';
    }

    if (
      titleLower.includes('result') ||
      titleLower.includes('résultat') ||
      titleLower.includes('finding') ||
      titleLower.includes('analysis') ||
      titleLower.includes('analyse')
    ) {
      return 'results';
    }

    if (
      titleLower.includes('discussion') ||
      titleLower.includes('interpretation') ||
      titleLower.includes('implication')
    ) {
      return 'discussion';
    }

    if (
      titleLower.includes('conclusion') ||
      titleLower.includes('summary') ||
      titleLower.includes('closing')
    ) {
      return 'conclusion';
    }

    if (
      titleLower.includes('reference') ||
      titleLower.includes('bibliograph') ||
      titleLower.includes('citation')
    ) {
      return 'references';
    }

    return 'content';
  }

  /**
   * Chunk a single section.
   *
   * Aucun extrait ne dépasse `maxChunkSize` mots, recouvrement compris (#157).
   * Un paragraphe trop long est recoupé à la fin d'une phrase, et une phrase
   * trop longue entre deux mots. Sans cela la limite ne valait rien pour un
   * PDF : le texte extrait d'une page ne contient aucun saut de ligne, donc
   * chaque page formait un seul « paragraphe » jamais recoupé — 443 mots en
   * médiane pour une limite de 300, jusqu'à 2 213, mesuré sur 39 PDF réels.
   *
   * Rien n'est écarté : ni la fin d'une section trop courte pour faire un
   * extrait « normal », ni la fin d'un extrait qui ne tombe pas sur un point.
   */
  private chunkSection(
    section: Section,
    documentId: string,
    startingIndex: number,
    documentMeta?: { title?: string; abstract?: string }
  ): DocumentChunk[] {
    const source = sectionSource(section.lines);
    const max = this.config.maxChunkSize;
    const chunks: DocumentChunk[] = [];

    let body: TextRange[] = [];
    let bodyWords = 0;
    let overlap = '';
    let overlapWords = 0;

    const flush = () => {
      const start = body[0].start;
      const end = body[body.length - 1].end;
      const ownText = this.cleanText(source.text.slice(start, end));
      const from = source.locate(start);

      chunks.push({
        id: randomUUID(),
        documentId,
        content: this.enhanceChunkWithContext(
          overlap ? `${overlap} ${ownText}` : ownText,
          documentMeta,
          section.title
        ),
        // La page et la position sont celles du texte propre à l'extrait,
        // recouvrement exclu : là où un lecteur doit aller le chercher.
        pageNumber: from.pageNumber,
        chunkIndex: startingIndex + chunks.length,
        startPosition: from.position,
        endPosition: source.locate(end - 1).position + 1,
        metadata: {
          sectionTitle: section.title,
          sectionType: section.type,
          sectionLevel: section.level,
        },
      });

      // Start next chunk with smart overlap (sentence boundaries)
      overlap = this.createSmartOverlap(ownText, this.config.overlapSize);
      overlapWords = countWords(overlap);
      body = [];
      bodyWords = 0;
    };

    for (const unit of this.splitIntoUnits(source.text)) {
      if (body.length > 0 && overlapWords + bodyWords + unit.words > max) flush();

      // Le recouvrement est un confort : il cède devant la limite.
      if (body.length === 0 && overlapWords + unit.words > max) {
        overlap = '';
        overlapWords = 0;
      }

      body.push(unit);
      bodyWords += unit.words;
    }

    if (body.length > 0) flush();

    return chunks;
  }

  /**
   * Les morceaux qu'on ne recoupe pas : un paragraphe s'il tient dans un
   * extrait, sinon ses phrases, et pour une phrase démesurée (tableau, liste
   * sans ponctuation) des tranches de mots.
   */
  private splitIntoUnits(text: string): TextRange[] {
    const max = this.config.maxChunkSize;
    const whole: TextRange = { start: 0, end: text.length, words: 0 };
    const units: TextRange[] = [];

    for (const paragraph of splitRange(text, whole, PARAGRAPH_BREAK)) {
      if (paragraph.words <= max) {
        units.push(paragraph);
        continue;
      }
      for (const sentence of splitRange(text, paragraph, SENTENCE_BREAK)) {
        if (sentence.words <= max) units.push(sentence);
        else units.push(...sliceByWords(text, sentence, max));
      }
    }

    return units;
  }

  /**
   * Create smart overlap at sentence boundaries
   */
  private createSmartOverlap(text: string, targetWords: number): string {
    // Split into sentences
    const sentences = text.split(/(?<=[.!?])\s+/);
    let overlap = '';
    let wordCount = 0;

    // Take sentences from the end until we reach target
    for (let i = sentences.length - 1; i >= 0 && wordCount < targetWords; i--) {
      const sentence = sentences[i];
      const sentenceWords = sentence.split(/\s+/).filter((w) => w.length > 0).length;

      // Add sentence if it doesn't exceed target by too much (+20 tolerance)
      if (wordCount + sentenceWords <= targetWords + 20) {
        overlap = sentence + ' ' + overlap;
        wordCount += sentenceWords;
      } else {
        // Would exceed too much, stop here
        break;
      }
    }

    return overlap.trim();
  }

  /**
   * Add document context to chunk content
   */
  private enhanceChunkWithContext(
    content: string,
    documentMeta?: { title?: string; abstract?: string },
    sectionTitle?: string
  ): string {
    if (!documentMeta?.title) {
      return content;
    }

    // Lightweight context prefix (doesn't consume too many tokens)
    const contextParts: string[] = [];

    if (documentMeta.title) {
      contextParts.push(`Doc: ${documentMeta.title}`);
    }

    if (sectionTitle && sectionTitle !== 'Document') {
      contextParts.push(`Section: ${sectionTitle}`);
    }

    if (contextParts.length > 0) {
      const context = `[${contextParts.join(' | ')}]\n\n`;
      return context + content;
    }

    return content;
  }

  /**
   * Clean chunk text
   */
  private cleanText(text: string): string {
    return (
      text
        // Les sauts de ligne sont des blancs comme les autres, pas des
        // caractères de contrôle à retirer : les supprimer collait le dernier
        // mot d'une page au premier de la suivante.
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .replace(/[ \t\r]*\n[ \t\r]*\n\s*/g, '\n\n')
        .replace(/(?<!\n)\n(?!\n)/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    );
  }

  /**
   * Get chunking statistics (compatible with DocumentChunker)
   */
  getChunkingStats(chunks: any[]): {
    totalChunks: number;
    totalWords: number;
    averageWordCount: number;
    minWordCount: number;
    maxWordCount: number;
  } {
    const wordCounts = chunks.map((chunk) => {
      return chunk.content.split(/\s+/).filter((w: string) => w.length > 0).length;
    });

    const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);

    return {
      totalChunks: chunks.length,
      totalWords,
      averageWordCount: Math.round(totalWords / chunks.length) || 0,
      minWordCount: Math.min(...wordCounts) || 0,
      maxWordCount: Math.max(...wordCounts) || 0,
    };
  }
}

// Types

/** Une ligne du document, avec de quoi la resituer. */
interface SourceLine {
  text: string;
  /** Position de son premier caractère dans le texte complet. */
  position: number;
  pageNumber: number;
}

interface Section {
  title: string;
  level: number;
  type: SectionType;
  lines: SourceLine[];
}

/** Un morceau du texte d'une section : `[start, end)`, et son nombre de mots. */
interface TextRange {
  start: number;
  end: number;
  words: number;
}

type SectionType =
  | 'abstract'
  | 'introduction'
  | 'methodology'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'references'
  | 'content';

/** Une ligne vide, ou davantage. */
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/g;

/** Les blancs qui suivent une fin de phrase, guillemet ou parenthèse fermante compris. */
const SENTENCE_BREAK = /(?<=[.!?…][)\]"'’»]*)\s+/g;

function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** Les morceaux non vides de `range` que sépare `separator`. */
function splitRange(text: string, range: TextRange, separator: RegExp): TextRange[] {
  const parts: TextRange[] = [];
  const push = (start: number, end: number) => {
    const piece = text.slice(start, end);
    const words = countWords(piece);
    if (words === 0) return;
    const lead = piece.length - piece.trimStart().length;
    parts.push({ start: start + lead, end: start + piece.trimEnd().length, words });
  };

  let cursor = range.start;
  separator.lastIndex = range.start;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null && match.index < range.end) {
    push(cursor, match.index);
    cursor = Math.min(match.index + match[0].length, range.end);
    if (match[0].length === 0) separator.lastIndex++;
  }
  push(cursor, range.end);

  return parts;
}

/** `range` en tranches d'au plus `size` mots. */
function sliceByWords(text: string, range: TextRange, size: number): TextRange[] {
  const words = [...text.slice(range.start, range.end).matchAll(/\S+/g)];
  const slices: TextRange[] = [];
  for (let i = 0; i < words.length; i += size) {
    const last = words[Math.min(i + size, words.length) - 1];
    slices.push({
      start: range.start + words[i].index,
      end: range.start + last.index + last[0].length,
      words: Math.min(size, words.length - i),
    });
  }
  return slices;
}

/**
 * Le texte d'une section d'un seul tenant, et de quoi retrouver pour chacun
 * de ses caractères sa page et sa position dans le document.
 */
function sectionSource(lines: SourceLine[]): {
  text: string;
  locate: (offset: number) => { position: number; pageNumber: number };
} {
  const starts: number[] = [];
  let text = '';
  for (const line of lines) {
    starts.push(text.length);
    text += line.text + '\n';
  }

  const locate = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    const line = lines[low];
    const column = Math.min(offset - starts[low], line.text.length);
    return { position: line.position + column, pageNumber: line.pageNumber };
  };

  return { text, locate };
}
