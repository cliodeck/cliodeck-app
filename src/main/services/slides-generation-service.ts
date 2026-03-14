import { BrowserWindow } from 'electron';
import { pdfService } from './pdf-service.js';
import { getSlideGenerationPrompt } from '../../../backend/core/llm/SystemPrompts.js';
import { logger } from '../utils/logger.js';

export class SlidesGenerationService {
  private abortController: AbortController | null = null;

  /**
   * Génère des slides à partir d'un texte source.
   * Streame les tokens vers le renderer via 'slides:stream'.
   * Retourne le markdown complet généré.
   */
  async generateSlides(
    sourceText: string,
    language: string,
    window: BrowserWindow,
    citations?: Array<{ id: string; author: string; title: string; year: string }>
  ): Promise<string> {
    const llmManager = pdfService.getLLMProviderManager();

    if (!llmManager) {
      throw new Error('LLM non initialisé. Ouvrez un projet avant de générer des slides.');
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const systemPrompt = getSlideGenerationPrompt(language);

    // Build bibliography section if citations are provided
    let bibliographySection = '';
    if (citations && citations.length > 0) {
      const bibLines = citations
        .slice(0, 50) // cap to avoid overloading context
        .map((c) => `- [@${c.id}] ${c.author} (${c.year}). *${c.title}*`)
        .join('\n');
      bibliographySection = `\n\nBIBLIOGRAPHIE DISPONIBLE (utilise ces clés [@id] pour les citations) :\n${bibLines}`;
    }

    const prompt = `Voici le texte source à transformer en présentation :${bibliographySection}\n\n---\n${sourceText}\n---\n\nGénère les slides maintenant :`;

    let fullResponse = '';

    try {
      logger.info('slides', 'generateSlides:start', { textLength: sourceText.length, language });

      const stream = llmManager.generateWithoutSources(prompt, [], {
        systemPrompt,
        generationOptions: {
          temperature: 0.3,
        },
      });

      for await (const chunk of stream) {
        if (signal.aborted) {
          logger.info('slides', 'generateSlides:cancelled');
          break;
        }
        fullResponse += chunk;
        window.webContents.send('slides:stream', chunk);
      }

      window.webContents.send('slides:stream-done', { content: fullResponse });
      logger.info('slides', 'generateSlides:done', { outputLength: fullResponse.length });

      return fullResponse;
    } catch (error: any) {
      if (signal.aborted) {
        window.webContents.send('slides:stream-done', { content: fullResponse, cancelled: true });
        return fullResponse;
      }
      logger.error('slides', 'generateSlides:error', { error: error.message });
      window.webContents.send('slides:stream-error', { error: error.message });
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  cancelGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

export const slidesGenerationService = new SlidesGenerationService();
