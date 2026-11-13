import { BrowserWindow } from 'electron';
import { getSlideGenerationPrompt } from '../../../backend/core/llm/SystemPrompts.js';
import { EMBEDDED_CONTEXT_SIZE, embeddedInputBudget } from '../../../backend/core/llm/context-windows.js';
import { fitTextToTokens, type EmbeddedTokenizer } from '../../../backend/core/llm/EmbeddedLLMClient.js';
import { embeddedTokenizerOf } from '../../../backend/core/llm/providers/fallback.js';
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
  const text = raw.replace(/^\s*```\s*(?:markdown)?\s*\n/i, '').replace(/\n\s*```\s*$/i, '');

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

// ── Fenêtre du modèle embarqué ──────────────────────────────────────────

/**
 * Jetons gardés en réserve : consignes, demande et document sont comptés séparément, et un texte
 * recollé se tokenise parfois à quelques jetons près de la somme de ses morceaux.
 */
const FIT_MARGIN_TOKENS = 16;

/** La part du document que le modèle a lue, quand il n'a pas pu tout lire. */
export interface SlidesSourceCut {
  readChars: number;
  totalChars: number;
}

/**
 * Le document que le modèle embarqué peut lire avec les consignes et la demande, dans sa fenêtre de
 * 4 096 jetons (L08-4). Le moteur ne coupe jamais la question, et le document y est : sans cette
 * coupe, un document de plus de 9 000 caractères environ était refusé, et, juste en deçà, ce sont
 * les consignes des diapositives, en rôle système, qui partaient. C'est la fin du document qui part,
 * marquée « […] », comme le moteur le faisait avant L08-4 ; les diapositives sont tirées de son début.
 */
function fitSourceToWindow(
  source: string,
  system: string,
  promptFor: (source: string) => string,
  tokenizer: EmbeddedTokenizer
): { source: string; cut?: SlidesSourceCut } {
  const fixed =
    tokenizer.tokenize(system).length + tokenizer.tokenize(promptFor('')).length + FIT_MARGIN_TOKENS;
  const room = embeddedInputBudget(EMBEDDED_CONTEXT_SIZE) - fixed;
  const kept = fitTextToTokens(source, Math.max(0, room), tokenizer);
  if (kept === source) return { source };
  // Ce qui a été lu, sans la marque de coupe.
  const readChars = kept.endsWith('[…]') ? kept.slice(0, -'[…]'.length).trimEnd().length : kept.length;
  return { source: kept, cut: { readChars, totalChars: source.length } };
}

/** Le modèle a fini en erreur : son code (`embedded_prompt_too_long`…) va au panneau, qui le traduit. */
class SlidesGenerationError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'SlidesGenerationError';
  }
}

// ── Service ─────────────────────────────────────────────────────────────

export class SlidesGenerationService {
  private abortController: AbortController | null = null;
  /**
   * Typed LLM provider (fusion 1.2a). The `slides-handlers` IPC builds a
   * `ProviderRegistry` from the active workspace config and wires this
   * field before each `generateSlides` call (and clears it in `finally`).
   * `generateSlides` fails loud if the provider isn't set — the previous
   * legacy `LLMProviderManager.generateWithoutSources` fallback is gone.
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
    if (!this.llm) {
      throw new Error(
        'slides-generation-service: LLM provider not wired (call setLLMProvider before generateSlides)'
      );
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

    const promptFor = (source: string): string =>
      `${t.intro} :${bibliographySection}\n\n---\n${source}\n---\n\n${t.go}`;

    let fullResponse = '';
    const llm = this.llm;

    try {
      logger.info('slides', 'generateSlides:start', { textLength: sourceText.length, language });

      // Le modèle embarqué (réglage « embarqué », ou « auto » Ollama arrêté) ne lit que ce qui tient
      // dans sa fenêtre : le document y est mesuré et coupé par la fin. Les autres le reçoivent entier.
      const tokenizer = await embeddedTokenizerOf(llm, signal);
      const fitted = tokenizer
        ? fitSourceToWindow(sourceText, systemPrompt, promptFor, tokenizer)
        : { source: sourceText };
      if (fitted.cut) {
        logger.warn('slides', 'generateSlides:source-cut', { ...fitted.cut });
      }

      // Stream via the typed provider. Single system+user turn,
      // per-token forwarding to the renderer, signal-driven cancellation.
      const iter = llm.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptFor(fitted.source) },
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
        // Le contrat des fournisseurs : une panne finit le flux par un terminal `error`, sans lever.
        // Sans cette lecture, un refus du modèle devenait un résultat vide, « terminé » sans un mot.
        if (chunk.done && chunk.finishReason === 'error' && !signal.aborted) {
          const cause = llm.getStatus().lastError;
          throw new SlidesGenerationError(cause?.message ?? 'Slide generation failed', cause?.code);
        }
        if (chunk.done) break;
      }

      // Post-process: normalise LLM output to reveal.js format
      const normalised = normaliseToRevealFormat(fullResponse);

      window.webContents.send('slides:stream-done', {
        content: normalised,
        ...(fitted.cut ? { sourceCut: fitted.cut } : {}),
      });
      logger.info('slides', 'generateSlides:done', { outputLength: normalised.length });

      return normalised;
    } catch (error: unknown) {
      if (signal.aborted) {
        const normalised = normaliseToRevealFormat(fullResponse);
        window.webContents.send('slides:stream-done', { content: normalised, cancelled: true });
        return normalised;
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof SlidesGenerationError ? error.code : undefined;
      logger.error('slides', 'generateSlides:error', { error: message, ...(code ? { code } : {}) });
      window.webContents.send('slides:stream-error', { error: message, ...(code ? { code } : {}) });
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
