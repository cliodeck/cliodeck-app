import { randomUUID } from 'crypto';
import type { DocumentPage, DocumentChunk } from '../../types/pdf-document';

// MARK: - Configuration

export interface ChunkingConfig {
  maxChunkSize: number; // Nombre de mots maximum par chunk
  overlapSize: number; // Nombre de mots de chevauchement
  minChunkSize: number; // Nombre de mots minimum (éviter les chunks trop petits)
}

export const CHUNKING_CONFIGS = {
  cpuOptimized: {
    maxChunkSize: 300, // Plus petit pour CPU
    overlapSize: 50,
    minChunkSize: 50,
  } as ChunkingConfig,

  standard: {
    maxChunkSize: 500,
    overlapSize: 75,
    minChunkSize: 100,
  } as ChunkingConfig,

  large: {
    maxChunkSize: 800,
    overlapSize: 100,
    minChunkSize: 150,
  } as ChunkingConfig,
};

export interface ChunkingStatistics {
  totalChunks: number;
  averageWordCount: number;
  minWordCount: number;
  maxWordCount: number;
  totalWords: number;
}

export class DocumentChunker {
  private config: ChunkingConfig;

  constructor(config: ChunkingConfig = CHUNKING_CONFIGS.cpuOptimized) {
    this.config = config;
  }

  // MARK: - Chunking principal

  createChunks(
    pages: DocumentPage[],
    documentId: string,
    documentMeta?: { title?: string; abstract?: string }
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;

    // Regrouper le texte de toutes les pages
    let fullText = '';
    const pageMapping: Array<{ pageNumber: number; startPosition: number; endPosition: number }> =
      [];

    for (const page of pages) {
      const pageStart = fullText.length;
      fullText += page.text + '\n\n';
      const pageEnd = fullText.length;
      pageMapping.push({ pageNumber: page.pageNumber, startPosition: pageStart, endPosition: pageEnd });
    }

    // Découper en chunks
    const words = fullText.split(/\s+/).filter((w) => w.length > 0);

    let i = 0;
    while (i < words.length) {
      // Déterminer la taille du chunk avec sentence boundary awareness
      let endIndex = Math.min(i + this.config.maxChunkSize, words.length);

      // Try to end at sentence boundary (look ahead up to 50 words)
      if (endIndex < words.length) {
        for (let j = endIndex; j > Math.max(i, endIndex - 50); j--) {
          if (/[.!?;]$/.test(words[j])) {
            endIndex = j + 1;
            break;
          }
        }
      }

      const chunkWords = words.slice(i, endIndex);
      const chunkText = chunkWords.join(' ');

      // Trouver la position dans le texte complet
      // Pour simplifier, on cherche la première occurrence du premier mot
      const searchStart = i > 0 ? chunks[chunks.length - 1]?.endPosition || 0 : 0;
      const firstWordIndex = fullText.indexOf(chunkWords[0], searchStart);
      const chunkStart = firstWordIndex >= 0 ? firstWordIndex : searchStart;
      const chunkEnd = chunkStart + chunkText.length;

      const pageNumber = this.findPageNumber(chunkStart, pageMapping);

      // Créer le chunk seulement s'il est assez long
      if (chunkWords.length >= this.config.minChunkSize || endIndex === words.length) {
        let content = this.cleanChunkText(chunkText);

        // Add document context if available
        if (documentMeta?.title) {
          content = `[Doc: ${documentMeta.title}]\n\n` + content;
        }

        const chunk: DocumentChunk = {
          id: randomUUID(),
          documentId,
          content,
          pageNumber,
          chunkIndex,
          startPosition: chunkStart,
          endPosition: chunkEnd,
        };
        chunks.push(chunk);
        chunkIndex++;
      }

      // Avancer avec overlap
      i += this.config.maxChunkSize - this.config.overlapSize;

      // Éviter les boucles infinies
      if (i <= 0) {
        i = this.config.maxChunkSize;
      }
    }

    console.log(
      `✅ ${chunks.length} chunks créés (config: max=${this.config.maxChunkSize}, overlap=${this.config.overlapSize})`
    );

    return chunks;
  }

  // MARK: - Chunking sémantique (bonus)

  /**
   * Découpe en respectant les paragraphes quand possible
   */
  createSemanticChunks(pages: DocumentPage[], documentId: string): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;
    let currentPosition = 0;

    for (const page of pages) {
      const paragraphs = page.text.split('\n\n');
      let currentChunk = '';
      let chunkStartPos = currentPosition;

      for (const paragraph of paragraphs) {
        const paragraphWords = paragraph.split(/\s+/).filter((w) => w.length > 0);
        const currentWords = currentChunk.split(/\s+/).filter((w) => w.length > 0);

        // Si ajouter ce paragraphe dépasse la limite
        if (
          currentWords.length + paragraphWords.length > this.config.maxChunkSize &&
          currentChunk.length > 0
        ) {
          // Sauvegarder le chunk actuel
          const chunk: DocumentChunk = {
            id: randomUUID(),
            documentId,
            content: this.cleanChunkText(currentChunk),
            pageNumber: page.pageNumber,
            chunkIndex,
            startPosition: chunkStartPos,
            endPosition: currentPosition,
          };
          chunks.push(chunk);
          chunkIndex++;

          // Commencer un nouveau chunk avec overlap
          const overlapWords = currentWords.slice(-this.config.overlapSize);
          currentChunk = overlapWords.join(' ') + ' ';
          chunkStartPos = currentPosition - currentChunk.length;
        }

        // Ajouter le paragraphe au chunk actuel
        currentChunk += paragraph + '\n\n';
        currentPosition += paragraph.length + 2;
      }

      // Sauvegarder le dernier chunk de la page s'il n'est pas vide
      if (currentChunk.trim().length > 0) {
        const chunkWords = currentChunk.split(/\s+/).filter((w) => w.length > 0);
        if (chunkWords.length >= this.config.minChunkSize) {
          const chunk: DocumentChunk = {
            id: randomUUID(),
            documentId,
            content: this.cleanChunkText(currentChunk),
            pageNumber: page.pageNumber,
            chunkIndex,
            startPosition: chunkStartPos,
            endPosition: currentPosition,
          };
          chunks.push(chunk);
          chunkIndex++;
        }
      }
    }

    console.log(`✅ ${chunks.length} chunks sémantiques créés`);

    return chunks;
  }

  // MARK: - Utilitaires

  private findPageNumber(
    position: number,
    mapping: Array<{ pageNumber: number; startPosition: number; endPosition: number }>
  ): number {
    for (const { pageNumber, startPosition, endPosition } of mapping) {
      if (position >= startPosition && position < endPosition) {
        return pageNumber;
      }
    }
    return mapping[mapping.length - 1]?.pageNumber ?? 1;
  }

  private cleanChunkText(text: string): string {
    let cleaned = text;

    // Enlever les retours à la ligne excessifs (max 2 newlines)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Enlever les espaces multiples (max 1 espace)
    cleaned = cleaned.replace(/ {2,}/g, ' ');

    // Enlever les caractères de contrôle (0x00-0x1F, 0x7F-0x9F)
    cleaned = cleaned.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

    // Trim
    cleaned = cleaned.trim();

    return cleaned;
  }

  // MARK: - Statistiques

  getChunkingStats(chunks: DocumentChunk[]): ChunkingStatistics {
    if (chunks.length === 0) {
      return {
        totalChunks: 0,
        averageWordCount: 0,
        minWordCount: 0,
        maxWordCount: 0,
        totalWords: 0,
      };
    }

    const wordCounts = chunks.map((chunk) => {
      return chunk.content.split(/\s+/).filter((w) => w.length > 0).length;
    });

    const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
    const average = Math.floor(totalWords / chunks.length);

    return {
      totalChunks: chunks.length,
      averageWordCount: average,
      minWordCount: Math.min(...wordCounts),
      maxWordCount: Math.max(...wordCounts),
      totalWords,
    };
  }

  // MARK: - Comparaison de configurations

  static compareConfigs(pages: DocumentPage[], documentId: string): void {
    const configs: Array<[string, ChunkingConfig]> = [
      ['CPU Optimized', CHUNKING_CONFIGS.cpuOptimized],
      ['Standard', CHUNKING_CONFIGS.standard],
      ['Large', CHUNKING_CONFIGS.large],
    ];

    console.log('\n📊 Comparaison des configurations de chunking:');
    console.log('='.repeat(50));

    for (const [name, config] of configs) {
      const chunker = new DocumentChunker(config);
      const chunks = chunker.createChunks(pages, documentId);
      const stats = chunker.getChunkingStats(chunks);

      console.log(`\n${name}:`);
      console.log(`Chunks: ${stats.totalChunks}`);
      console.log(`Mots total: ${stats.totalWords}`);
      console.log(`Moyenne: ${stats.averageWordCount} mots/chunk`);
      console.log(`Min: ${stats.minWordCount} - Max: ${stats.maxWordCount}`);
    }

    console.log('\n' + '='.repeat(50));
  }
}
