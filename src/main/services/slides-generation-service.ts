import { BrowserWindow } from 'electron';
import { pdfService } from './pdf-service.js';
import { getSlideGenerationPrompt } from '../../../backend/core/llm/SystemPrompts.js';
import { logger } from '../utils/logger.js';

// ── Post-processing: normalise any LLM output into reveal.js format ─────

/**
 * Many LLMs ignore formatting instructions and return free-form markdown
 * (bold titles, nested numbered lists, no --- separators, etc.).
 *
 * This function normalises the raw output into the # / ## / --- structure
 * that our reveal.js exporter expects.
 */
function normaliseToRevealFormat(raw: string): string {
  // Strip wrapping ```markdown … ``` if present
  let text = raw.replace(/^\s*```\s*(?:markdown)?\s*\n/i, '').replace(/\n\s*```\s*$/i, '');

  // If the output already has multiple # headings separated by ---,
  // AND uses ** sparingly (not as primary headings), assume it's well-formatted.
  const headingCount = (text.match(/^#{1,2}\s+/gm) || []).length;
  const separatorCount = (text.match(/\n---\n/g) || []).length;
  const boldHeadingCount = (text.match(/^\*\*[^*]+:?\s*\*\*\s*$/gm) || []).length;
  if (headingCount >= 3 && separatorCount >= 2 && boldHeadingCount <= 2) {
    return text.trim();
  }

  // ── Otherwise, convert free-form markdown to slide structure ──────────

  const lines = text.split('\n');
  const slides: { heading: string; body: string[]; notes: string[] }[] = [];
  let current: { heading: string; body: string[]; notes: string[] } | null = null;
  let inNotes = false;

  const flush = () => { if (current) slides.push(current); };

  const isHeadingLine = (line: string): string | null => {
    // Already a markdown heading
    let m = line.match(/^(#{1,2})\s+(.+)/);
    if (m) return line; // keep as-is

    // **Bold title:** or **Bold title**
    m = line.match(/^\*\*(.+?)(?::?\s*)\*\*\s*$/);
    if (m) return `## ${m[1].replace(/:$/, '').trim()}`;

    // UPPERCASE TITLE (at least 3 words, all caps or title-like)
    if (/^[A-ZÀ-Ü][A-ZÀ-Ü\s:]{6,}$/.test(line.trim())) {
      return `## ${line.trim()}`;
    }

    return null;
  };

  for (const line of lines) {
    // Detect note blocks
    if (/^\s*\*?\*?Notes?\s*:?\*?\*?\s*$/i.test(line) || /^\s*Note:\s*$/i.test(line)) {
      inNotes = true;
      continue;
    }

    const heading = isHeadingLine(line.trimEnd());
    if (heading) {
      inNotes = false;
      flush();
      current = { heading, body: [], notes: [] };
      continue;
    }

    if (!current) {
      // Content before any heading → create a title slide
      if (line.trim()) {
        current = { heading: `# ${line.trim()}`, body: [], notes: [] };
      }
      continue;
    }

    if (inNotes) {
      if (line.trim()) current.notes.push(line.replace(/^\s*\*\s*/, '').trim());
      continue;
    }

    // Normalise list markers: numbered "1." → "-", nested "  *" → "-"
    let bodyLine = line;
    bodyLine = bodyLine.replace(/^\s*\d+\.\s+/, '- ');
    bodyLine = bodyLine.replace(/^\s{2,}\*\s+/, '  - ');

    // Skip **bold:** sub-items that look like section introductions with no content
    if (/^\s*\*\*[^*]+\*\*\s*$/.test(bodyLine) && !bodyLine.includes('-')) {
      // Treat as a sub-heading within the slide — just bold text
      bodyLine = bodyLine.replace(/\*\*/g, '').trim();
      if (bodyLine) current.body.push(`\n**${bodyLine}**`);
      continue;
    }

    current.body.push(bodyLine);
  }
  flush();

  if (!slides.length) return text.trim(); // fallback: return raw

  // ── Assemble into reveal.js format ────────────────────────────────────
  // First slide with # is a section heading; subsequent ## are vertical slides.
  // Group consecutive ## slides under their preceding # section.

  // Ensure the very first slide uses # (section title)
  if (slides[0] && /^##\s/.test(slides[0].heading)) {
    slides[0].heading = slides[0].heading.replace(/^##/, '#');
  }

  const parts: string[] = [];
  let needsSeparator = false;

  for (const slide of slides) {
    const isSection = /^#(?!#)\s/.test(slide.heading);

    if (isSection && needsSeparator) {
      parts.push('\n---\n');
    }

    let block = slide.heading;
    const bodyText = slide.body
      .join('\n')
      .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
      .trim();
    if (bodyText) block += '\n\n' + bodyText;
    if (slide.notes.length) block += '\n\nNote:\n' + slide.notes.join('\n');

    parts.push(block);
    needsSeparator = true;
  }

  return parts.join('\n\n').trim();
}

// ── Service ─────────────────────────────────────────────────────────────

export class SlidesGenerationService {
  private abortController: AbortController | null = null;
  /**
   * Optional typed LLM provider (fusion 1.4f). When set, `generateSlides`
   * streams through `llm.chat()` instead of
   * `LLMProviderManager.generateWithoutSources`. Callers wire this when
   * they want slides under a non-Ollama backend (Anthropic/Mistral/etc.);
   * legacy path preserved for existing IPC callers.
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
    const llmManager = this.llm ? null : pdfService.getLLMProviderManager();

    if (!this.llm && !llmManager) {
      throw new Error('LLM non initialisé. Ouvrez un projet avant de générer des slides.');
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const systemPrompt = getSlideGenerationPrompt(language);

    // User-prompt wording per language
    const i18n: Record<string, { intro: string; bibHeader: string; go: string }> = {
      fr: {
        intro: 'Voici le texte source à transformer en présentation',
        bibHeader: 'BIBLIOGRAPHIE DISPONIBLE (utilise ces clés [@id] pour les citations)',
        go: 'Génère les slides maintenant, en FRANÇAIS :',
      },
      en: {
        intro: 'Here is the source text to turn into a presentation',
        bibHeader: 'AVAILABLE BIBLIOGRAPHY (use these [@id] keys for citations)',
        go: 'Generate the slides now, in ENGLISH:',
      },
      de: {
        intro: 'Hier ist der Quelltext, der in eine Präsentation umgewandelt werden soll',
        bibHeader: 'VERFÜGBARE BIBLIOGRAPHIE (verwenden Sie diese [@id]-Schlüssel für Zitate)',
        go: 'Generieren Sie jetzt die Folien, auf DEUTSCH:',
      },
    };
    const t = i18n[language] ?? i18n.fr;

    // Build bibliography section if citations are provided
    let bibliographySection = '';
    if (citations && citations.length > 0) {
      const bibLines = citations
        .slice(0, 50) // cap to avoid overloading context
        .map((c) => `- [@${c.id}] ${c.author} (${c.year}). *${c.title}*`)
        .join('\n');
      bibliographySection = `\n\n${t.bibHeader} :\n${bibLines}`;
    }

    const prompt = `${t.intro} :${bibliographySection}\n\n---\n${sourceText}\n---\n\n${t.go}`;

    let fullResponse = '';

    try {
      logger.info('slides', 'generateSlides:start', { textLength: sourceText.length, language });

      if (this.llm) {
        // Fusion 1.4f: stream via the typed provider. Build a single
        // system+user turn; preserve the same cancellation + per-token
        // forwarding semantics as the legacy path.
        const iter = this.llm.chat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          { temperature: 0.3, signal }
        );
        for await (const chunk of iter) {
          if (signal.aborted) {
            logger.info('slides', 'generateSlides:cancelled');
            break;
          }
          if (chunk.delta) {
            fullResponse += chunk.delta;
            window.webContents.send('slides:stream', chunk.delta);
          }
          if (chunk.done) break;
        }
      } else {
        const stream = llmManager!.generateWithoutSources(prompt, [], {
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
      }

      // Post-process: normalise LLM output to reveal.js format
      const normalised = normaliseToRevealFormat(fullResponse);

      window.webContents.send('slides:stream-done', { content: normalised });
      logger.info('slides', 'generateSlides:done', { outputLength: normalised.length });

      return normalised;
    } catch (error: any) {
      if (signal.aborted) {
        const normalised = normaliseToRevealFormat(fullResponse);
        window.webContents.send('slides:stream-done', { content: normalised, cancelled: true });
        return normalised;
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
