import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join, dirname, extname, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { extendedToolPath, toolFinderCommand } from '../../../backend/core/tools/external-tools.js';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
  TableOfContents,
} from 'docx';
import {
  MarkdownToWordParser,
  inlineMarkdownRuns,
  ORDERED_LIST_NUMBERING,
  type BlockChild,
} from './word-markdown.js';
import { CitationEngine } from '../../../backend/core/citation/CitationEngine.js';
import { processMarkdownCitations, type ProcessedFootnote } from './citation-pipeline.js';
import { extractManualFootnotes } from './word-footnotes.js';
import { parseOutline } from '../../editor/outline.js';
import { assembleManuscript } from './manuscript-assembler.js';
import { resolveBookSettings, referenceSectionTitle } from './pandoc-args.js';
import { normalizeBookSettings, type BookSettings, type Chapter } from '../../../backend/types/book.js';
import { bibliographyService } from './bibliography-service.js';
// @ts-ignore - No type definitions available
import Docxtemplater from 'docxtemplater';
// @ts-ignore - No type definitions available
import PizZip from 'pizzip';

// MARK: - Types

export interface WordExportOptions {
  projectPath: string;
  projectType: 'article' | 'book' | 'presentation';
  content: string;
  outputPath?: string;
  bibliographyPath?: string;
  cslPath?: string; // Path to CSL file for citation styling
  templatePath?: string; // Path to .dotx template
  /** Réglages d'ouvrage (notes, bibliographie, numérotation). */
  bookSettings?: Partial<BookSettings>;
  /**
   * Manuscrit à assembler côté main (livre). Quand il est fourni, `content`
   * peut être vide : le texte vient des chapitres, dans l'ordre du
   * manifeste, avec l'isolation des notes par chapitre. Même motif que
   * l'export PDF.
   */
  manuscript?: {
    chapters: Chapter[];
    liveOverrides?: Record<string, string>;
    scope?: 'book' | { chapterId: string };
  };
  /**
   * Citation rendering options. When `useEngine` is true, `[@key]` markers
   * are pre-processed into Word native footnotes + a bibliography section.
   */
  citation?: {
    useEngine?: boolean;
    style?: string;
    locale?: string;
  };
  metadata?: {
    title?: string;
    author?: string;
    date?: string;
    abstract?: string;
  };
}

interface WordExportProgress {
  stage: 'preparing' | 'parsing' | 'generating' | 'template' | 'pandoc' | 'complete';
  message: string;
  progress: number;
}

/**
 * Découpe un manuscrit assemblé en chapitres, aux titres de niveau 1.
 *
 * Le découpage passe par l'arbre Lezer (`parseOutline`) et non par une
 * regex : un `#` en tête de ligne dans un bloc de code n'ouvre pas un
 * chapitre. Ce qui précède le premier titre (liminaires éventuels) forme
 * un bloc à part, pour ne rien perdre.
 */
/**
 * Scalaire YAML entre guillemets, sûr pour le frontmatter pandoc :
 * antislashs et guillemets échappés, retours à la ligne aplatis en espace
 * (un champ de métadonnée est mono-ligne ; un `\n` brut permettrait
 * d'injecter des clés arbitraires dans le frontmatter).
 */
export function yamlQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')}"`;
}

export function splitIntoChapters(markdown: string): string[] {
  const starts = parseOutline(markdown)
    .filter((h) => h.level === 1)
    .map((h) => h.from);
  if (starts.length === 0) return [markdown];

  const chunks: string[] = [];
  const preamble = markdown.slice(0, starts[0]).trim();
  if (preamble) chunks.push(preamble);
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : markdown.length;
    const chunk = markdown.slice(starts[i], end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/** Résultat d'un export Word. */
export interface WordExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  /**
   * Clés de citation restées sans référence. L'export aboutit quand même —
   * mais le document contient ces clés telles quelles, et le dire est la
   * seule façon que l'auteur l'apprenne avant son relecteur.
   */
  unresolvedCitations?: string[];
}

/**
 * Sépare le titre éventuel de `abstract.md` de son texte.
 *
 * Seul `# Résumé` était reconnu : un article en anglais (`# Abstract`) ou en
 * allemand gardait son titre, croisillon compris, au milieu du résumé.
 */
export function splitAbstract(content: string): { heading?: string; body: string } {
  const m = content.match(/^\s*#{1,6}[ \t]+([^\n]*?)[ \t]*#*[ \t]*(?:\n|$)/);
  if (!m) return { body: content.trim() };
  return { heading: m[1].trim() || undefined, body: content.slice(m[0].length).trim() };
}

/** Clés que citeproc (pandoc) signale introuvables sur sa sortie d'erreur. */
export function pandocUnresolvedCitations(stderr: string): string[] {
  const keys = new Set<string>();
  for (const m of stderr.matchAll(/citation (\S+) not found/g)) keys.add(m[1]);
  return [...keys];
}

// MARK: - Service

export class WordExportService {
  private parser = new MarkdownToWordParser();

  /**
   * PATH des outils d'export : voir `backend/core/tools/external-tools.ts` (emplacements ajoutés
   * hors Windows, où le PATH part tel quel).
   */
  private getExtendedPath(): string {
    return extendedToolPath(process.env.PATH || '');
  }

  /**
   * Check if pandoc is available
   */
  private async checkPandoc(): Promise<boolean> {
    const extendedPath = this.getExtendedPath();
    return new Promise((resolve) => {
      const proc = spawn(toolFinderCommand(), ['pandoc'], {
        env: { ...process.env, PATH: extendedPath }
      });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  /**
   * Export markdown to Word using pandoc (for bibliography support)
   */
  private async exportWithPandoc(
    options: WordExportOptions,
    outputPath: string,
    onProgress?: (progress: WordExportProgress) => void
  ): Promise<WordExportResult> {
    const tempDir = join(tmpdir(), `cliodeck-word-export-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    try {
      onProgress?.({
        stage: 'pandoc',
        message: 'Préparation de la conversion pandoc...',
        progress: 30,
      });

      // Write content to temp file
      const inputPath = join(tempDir, 'input.md');

      // Build YAML frontmatter for metadata. Les valeurs passent par
      // yamlQuote : un guillemet dans un titre cassait le frontmatter, et
      // un retour à la ligne permettait d'y injecter des clés arbitraires
      // (seul abstract était déjà sûr, en scalaire bloc).
      let yamlFrontmatter = '---\n';
      if (options.metadata?.title) {
        yamlFrontmatter += `title: ${yamlQuote(options.metadata.title)}\n`;
      }
      if (options.metadata?.author) {
        yamlFrontmatter += `author: ${yamlQuote(options.metadata.author)}\n`;
      }
      if (options.metadata?.date) {
        yamlFrontmatter += `date: ${yamlQuote(options.metadata.date)}\n`;
      }
      if (options.metadata?.abstract) {
        yamlFrontmatter += `abstract: |\n  ${options.metadata.abstract.replace(/\n/g, '\n  ')}\n`;
      }
      yamlFrontmatter += '---\n\n';

      const cleanedContent = options.content;
      const fullContent = yamlFrontmatter + cleanedContent;
      await writeFile(inputPath, fullContent);

      // Build pandoc arguments
      const pandocArgs = [
        inputPath,
        '-o', outputPath,
        '--from', 'markdown',
        '--to', 'docx',
      ];

      // Réglages d'ouvrage. La modale annonce qu'ils « pilotent l'assemblage
      // du manuscrit ET les exports (PDF, Word) » — c'était vrai du seul
      // PDF : word-export construisait ses propres arguments, sans
      // `--number-sections` ni `--top-level-division`. Décocher « numéroter
      // les chapitres » puis exporter en .docx pour un éditeur donnait des
      // chapitres numérotés quand même.
      if (options.projectType === 'book') {
        const settings = resolveBookSettings(
          options.bookSettings as BookSettings | undefined
        );
        pandocArgs.push('--top-level-division=chapter');
        if (settings.numberChapters !== false || settings.numberSections) {
          pandocArgs.push('--number-sections');
        }
      }

      // Add bibliography and CSL if provided
      const bibPath = options.bibliographyPath;
      if (bibPath && existsSync(bibPath)) {
        pandocArgs.push('--bibliography', bibPath);
        pandocArgs.push('--citeproc');
        console.log('📚 Using bibliography:', bibPath);

        // Style de citation. Case « moteur CSL » cochée : le style choisi
        // dans la boîte de dialogue, pris parmi les styles embarqués, et sa
        // langue. Sinon le CSL du projet. Dans les deux cas c'est pandoc qui
        // rend : il comprend toute la syntaxe (renvois de page, clés nues,
        // citations dans une note) là où le moteur interne n'en lit qu'une
        // partie — et où le générateur docx interne n'interprète pas tout le
        // markdown.
        const engineCsl = options.citation?.useEngine
          ? new CitationEngine().stylePath(options.citation.style ?? 'chicago-note-bibliography')
          : undefined;
        // `project.json` enregistre un chemin relatif au projet.
        const projectCsl =
          options.cslPath && !isAbsolute(options.cslPath)
            ? join(options.projectPath, options.cslPath)
            : options.cslPath;
        const cslPath = engineCsl ?? projectCsl;
        if (cslPath && existsSync(cslPath)) {
          pandocArgs.push('--csl', cslPath);
          console.log('📚 Using CSL style:', cslPath);
        }
        if (engineCsl && options.citation?.locale) {
          pandocArgs.push('--metadata', `lang=${options.citation.locale}`);
        }

        // Add reference section title
        // Titre de section écrit DANS le document exporté : il doit suivre la
        // langue de l'interface, sinon un germanophone reçoit « Références ».
        pandocArgs.push('--metadata', `reference-section-title=${referenceSectionTitle()}`);
      }

      // Add reference doc (template) if provided
      if (options.templatePath && existsSync(options.templatePath)) {
        pandocArgs.push('--reference-doc', options.templatePath);
        console.log('📝 Using Word template:', options.templatePath);
      }

      onProgress?.({
        stage: 'pandoc',
        message: 'Conversion avec pandoc...',
        progress: 50,
      });

      const extendedPath = this.getExtendedPath();

      // Run pandoc
      const pandocStderr = await new Promise<string>((resolve, reject) => {
        console.log('📄 Running pandoc:', 'pandoc', pandocArgs.join(' '));

        const pandoc = spawn('pandoc', pandocArgs, {
          cwd: tempDir,
          env: { ...process.env, PATH: extendedPath },
        });

        let stderr = '';

        pandoc.stderr.on('data', (data) => {
          stderr += data.toString();
          console.log('📄 Pandoc output:', data.toString());
        });

        pandoc.on('close', (code) => {
          if (code === 0) {
            resolve(stderr);
          } else {
            reject(new Error(`Pandoc failed with code ${code}:\n${stderr}`));
          }
        });

        pandoc.on('error', (err) => {
          reject(new Error(`Failed to start pandoc: ${err.message}`));
        });
      });

      onProgress?.({
        stage: 'complete',
        message: 'Export Word terminé!',
        progress: 100,
      });

      console.log('✅ Word document exported successfully with pandoc:', outputPath);
      const unresolved = pandocUnresolvedCitations(pandocStderr);
      return {
        success: true,
        outputPath,
        ...(unresolved.length > 0 ? { unresolvedCitations: unresolved } : {}),
      };
    } catch (error: unknown) {
      console.error('❌ Pandoc Word export failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    } finally {
      // Un seul point de nettoyage : le manuscrit intermédiaire ne survit ni
      // au succès, ni à l'échec, ni à un futur retour anticipé.
      await rm(tempDir, { recursive: true, force: true }).catch((err) => {
        console.warn('⚠️ Failed to clean Word export temp directory:', err);
      });
    }
  }

  /**
   * Export markdown to Word document (.docx)
   * Uses pandoc when bibliography is available for proper citation processing
   */
  async exportToWord(
    options: WordExportOptions,
    onProgress?: (progress: WordExportProgress) => void
  ): Promise<WordExportResult> {
    try {
      onProgress?.({
        stage: 'preparing',
        message: 'Préparation de l\'export Word...',
        progress: 10,
      });

      // Load abstract if needed
      let abstract = options.metadata?.abstract;
      let abstractTitle = 'Résumé';
      if (
        !abstract &&
        (options.projectType === 'article' || options.projectType === 'book')
      ) {
        const abstractPath = join(options.projectPath, 'abstract.md');
        if (existsSync(abstractPath)) {
          const abstractContent = await readFile(abstractPath, 'utf-8');
          const parts = splitAbstract(abstractContent);
          abstract = parts.body;
          if (parts.heading) abstractTitle = parts.heading;
          options.metadata = { ...options.metadata, abstract };
          console.log('📄 Abstract loaded from file:', abstractPath);
        }
      }

      // Determine output path
      const outputPath =
        options.outputPath ||
        join(
          dirname(options.projectPath),
          `${options.metadata?.title || 'output'}.docx`
        );

      // Manuscrit assemblé côté main, AVANT le branchement pandoc/natif :
      // le renderer envoie content='' pour les livres (le contenu passe par
      // options.manuscript), donc assembler seulement sur le chemin natif
      // faisait produire au chemin pandoc un .docx vide (#19). Même
      // stratégie que pdf-export : assemblage inconditionnel d'abord.
      // La cible doit être connue AVANT d'assembler : le chemin docx natif
      // ne comprend pas le LaTeX de structure, et rendait `\mainmatter`
      // comme un paragraphe de texte en tête de document.
      //
      // La case « moteur CSL » ne détourne plus de pandoc : cochée, elle
      // choisit le style (voir exportWithPandoc). Elle envoyait auparavant
      // tout l'export vers le générateur interne, dont le rendu du markdown
      // et des citations est plus pauvre — et elle est cochée d'office dès
      // qu'un style est enregistré dans les réglages.
      const willUsePandoc =
        !!options.bibliographyPath &&
        existsSync(options.bibliographyPath) &&
        (await this.checkPandoc());

      if (options.manuscript?.chapters?.length) {
        const assembled = await assembleManuscript({
          projectPath: options.projectPath,
          chapters: options.manuscript.chapters,
          settings: normalizeBookSettings(options.bookSettings),
          liveOverrides: options.manuscript.liveOverrides,
          scope: options.manuscript.scope,
          target: willUsePandoc ? 'latex' : 'plain',
        });
        for (const w of assembled.warnings) console.warn('⚠️ word-export:', w);
        options = { ...options, content: assembled.markdown };
      }

      // Même décision que celle prise plus haut pour choisir la cible
      // d'assemblage : les deux DOIVENT concorder, sinon on assemblerait
      // du LaTeX pour le générateur natif, ou l'inverse.
      const hasBibliography = options.bibliographyPath && existsSync(options.bibliographyPath);
      const hasPandoc = await this.checkPandoc();
      const useEnginePipeline = !!options.citation?.useEngine;

      if (willUsePandoc) {
        console.log('📚 Bibliography detected, using pandoc for export...');
        return await this.exportWithPandoc(options, outputPath, onProgress);
      }

      if (hasBibliography && !hasPandoc) {
        console.warn('⚠️ Bibliography present but pandoc not found. Citations will not be processed.');
      }

      // Fall back to native docx generation (without bibliography processing)
      onProgress?.({
        stage: 'parsing',
        message: 'Analyse du contenu Markdown...',
        progress: 30,
      });

      // Run CitationEngine pipeline if requested, transforming [@key]
      // clusters into {{FN:N}} placeholders that the inline parser turns
      // into FootnoteReferenceRuns.
      // L'assemblage du manuscrit a déjà eu lieu plus haut (avant le
      // branchement pandoc) : options.content est le flux complet.
      let sourceMarkdown = options.content;
      let engineFootnotes: ProcessedFootnote[] = [];
      let engineBibliography: string[] = [];
      let unresolvedCitations: string[] = [];
      if (useEnginePipeline) {
        try {
          const style = options.citation?.style ?? 'chicago-note-bibliography';
          const locale = options.citation?.locale ?? 'fr-FR';
          const processed = await processMarkdownCitations(sourceMarkdown, {
            style,
            locale,
            resolve: (key) => bibliographyService.getByCitationKey(key),
          });
          if (processed.missingKeys.length > 0) {
            console.warn('⚠️ CitationEngine: unresolved keys:', processed.missingKeys);
            unresolvedCitations = processed.missingKeys;
          }
          // Seuls les marqueurs PRODUITS par le moteur deviennent des
          // placeholders : les notes de l'auteur sont traitées plus bas, avec
          // leurs définitions. Auparavant, un `[^1]` manuel était converti ici
          // et pointait vers la note d'une citation.
          const engineNumbers = new Set(processed.footnotes.map((f) => f.n));
          sourceMarkdown = processed.md.replace(/\[\^(\d+)\]/g, (marker, n: string) =>
            engineNumbers.has(parseInt(n, 10)) ? `{{FN:${n}}}` : marker
          );
          engineFootnotes = processed.footnotes;
          engineBibliography = processed.bibliography;
        } catch (err) {
          console.warn('⚠️ CitationEngine pre-processing failed:', err);
        }
      }

      // Notes manuelles de l'auteur : leurs définitions sortent du corps et
      // leurs appels deviennent de vraies notes docx. Sans cela, hors
      // pipeline moteur, `marked` les laissait en texte littéral (`[^1]`).
      const manual = extractManualFootnotes(
        sourceMarkdown,
        engineFootnotes.map((f) => f.n)
      );
      sourceMarkdown = manual.markdown;

      // Parse markdown content. Pour un livre, le corps est découpé aux
      // titres de niveau 1 (un chapitre = une section docx, donc un saut de
      // page et des en-têtes propres). Le découpage passe par l'arbre
      // Lezer : un `#` dans un bloc de code n'ouvre pas un chapitre.
      const isBook = options.projectType === 'book';
      const chapterChunks: string[] = isBook
        ? splitIntoChapters(sourceMarkdown)
        : [sourceMarkdown];
      const chapterParagraphs: BlockChild[][] = [];
      for (const chunk of chapterChunks) {
        chapterParagraphs.push(this.parser.parse(chunk));
      }
      const contentParagraphs = chapterParagraphs.flat();

      // Append bibliography section if we have entries.
      if (engineBibliography.length > 0) {
        contentParagraphs.push(
          new Paragraph({
            text: referenceSectionTitle(),
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 },
          })
        );
        for (const entry of engineBibliography) {
          contentParagraphs.push(
            new Paragraph({
              children: inlineMarkdownRuns(entry),
              spacing: { after: 120 },
            })
          );
        }
      }

      onProgress?.({
        stage: 'generating',
        message: 'Génération du document Word...',
        progress: 60,
      });

      // Build document sections
      const sections: any[] = [];

      // Title page for articles and books
      if (options.projectType === 'article' || options.projectType === 'book') {
        const titlePageChildren: BlockChild[] = [];

        // Title
        if (options.metadata?.title) {
          titlePageChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: options.metadata.title,
                  bold: true,
                  size: 48,
                }),
              ],
              alignment: AlignmentType.CENTER,
              spacing: { after: 400 },
            })
          );
        }

        // Author
        if (options.metadata?.author) {
          titlePageChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: options.metadata.author,
                  size: 28,
                }),
              ],
              alignment: AlignmentType.CENTER,
              spacing: { after: 200 },
            })
          );
        }

        // Date
        if (options.metadata?.date) {
          titlePageChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: options.metadata.date,
                  size: 24,
                }),
              ],
              alignment: AlignmentType.CENTER,
              spacing: { after: 400 },
            })
          );
        }

        // Abstract
        if (abstract) {
          titlePageChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: abstractTitle,
                  bold: true,
                  size: 28,
                }),
              ],
              spacing: { before: 400, after: 200 },
            })
          );

          titlePageChildren.push(...this.parser.parse(abstract, { size: 24 }));
        }

        if (isBook) {
          // Ouvrage : liminaires (titre, résumé, table des matières) puis
          // une section par chapitre.
          sections.push({
            properties: {},
            children: [
              ...titlePageChildren,
              new Paragraph({
                children: [new TextRun({ text: 'Table des matières', bold: true, size: 32 })],
                spacing: { before: 400, after: 200 },
                pageBreakBefore: true,
              }),
              new TableOfContents('Sommaire', { hyperlink: true, headingStyleRange: '1-3' }),
            ],
          });
          for (const paragraphs of chapterParagraphs) {
            if (paragraphs.length === 0) continue;
            sections.push({
              properties: { page: { pageNumbers: { start: undefined } } },
              headers: {
                default: new Header({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({ text: options.metadata?.title || '', italics: true }),
                      ],
                      alignment: AlignmentType.RIGHT,
                    }),
                  ],
                }),
              },
              footers: {
                default: new Footer({
                  children: [
                    new Paragraph({
                      children: [new TextRun({ children: ['Page ', PageNumber.CURRENT] })],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                }),
              },
              children: paragraphs,
            });
          }
        } else {
        sections.push({
          properties: {},
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: options.metadata?.title || '',
                      italics: true,
                    }),
                  ],
                  alignment: AlignmentType.RIGHT,
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      children: ["Page ", PageNumber.CURRENT],
                    }),
                  ],
                  alignment: AlignmentType.CENTER,
                }),
              ],
            }),
          },
          children: [...titlePageChildren, ...contentParagraphs],
        });
        }
      } else {
        // For notes and presentations, just add content
        sections.push({
          properties: {},
          children: contentParagraphs,
        });
      }

      // Build the footnotes map expected by docx:
      //   { [id]: { children: Paragraph[] } }
      const docxFootnotes: Record<string, { children: Paragraph[] }> = {};
      // Le texte d'une note est du markdown (notes de l'auteur) ou le HTML
      // léger de citeproc (notes du moteur) : il passe par le même rendu en
      // ligne que le corps, sinon italiques, liens et titres d'ouvrages
      // sortent en `*…*` et `[…](…)` littéraux.
      for (const fn of engineFootnotes) {
        docxFootnotes[String(fn.n)] = {
          children: [new Paragraph({ children: inlineMarkdownRuns(fn.text) })],
        };
      }
      // Notes de l'auteur : identifiants disjoints de ceux du moteur.
      for (const fn of manual.footnotes) {
        docxFootnotes[String(fn.id)] = {
          children: [new Paragraph({ children: inlineMarkdownRuns(fn.text) })],
        };
      }

      // Create document
      const doc = new Document({
        creator: options.metadata?.author || 'ClioDesk',
        title: options.metadata?.title || 'Document',
        description: abstract || '',
        sections,
        numbering: ORDERED_LIST_NUMBERING,
        ...(Object.keys(docxFootnotes).length > 0 ? { footnotes: docxFootnotes } : {}),
      });

      // Check if template is provided or exists
      let finalBuffer: Buffer;

      if (options.templatePath && existsSync(options.templatePath)) {
        onProgress?.({
          stage: 'template',
          message: 'Application du modèle Word...',
          progress: 85,
        });

        try {
          // Load template and merge with content
          finalBuffer = await this.mergeWithTemplate(
            options.templatePath,
            {
              title: options.metadata?.title || '',
              author: options.metadata?.author || '',
              date: options.metadata?.date || '',
              content: options.content,
              abstract: abstract || '',
            }
          );
        } catch (error) {
          console.warn('⚠️ Template merge failed, using generated document:', error);
          finalBuffer = await Packer.toBuffer(doc);
        }
      } else {
        // No template, use generated document
        finalBuffer = await Packer.toBuffer(doc);
      }

      await writeFile(outputPath, finalBuffer);

      onProgress?.({
        stage: 'complete',
        message: 'Export Word terminé!',
        progress: 100,
      });

      console.log('✅ Word document exported successfully:', outputPath);
      return {
        success: true,
        outputPath,
        ...(unresolvedCitations.length > 0 ? { unresolvedCitations } : {}),
      };
    } catch (error: unknown) {
      console.error('❌ Word export failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Merge content with a Word template (.dotx)
   */
  private async mergeWithTemplate(
    templatePath: string,
    data: {
      title: string;
      author: string;
      date: string;
      content: string;
      abstract: string;
    }
  ): Promise<Buffer> {
    try {
      // Read the template file
      const templateContent = await readFile(templatePath, 'binary');

      // Load template with PizZip
      const zip = new PizZip(templateContent);

      // Create Docxtemplater instance
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
      });

      // Render template with data
      // The template should contain placeholders like {title}, {author}, {content}, etc.
      doc.render({
        title: data.title,
        author: data.author,
        date: data.date,
        content: data.content,
        abstract: data.abstract,
      });

      // Get the generated zip
      const outputZip = doc.getZip();

      // Generate buffer
      const buffer = outputZip.generate({
        type: 'nodebuffer',
        compression: 'DEFLATE',
      });

      console.log('✅ Template merged successfully');
      return buffer;
    } catch (error) {
      console.error('❌ Template merge error:', error);
      throw error;
    }
  }

  /**
   * Check if a .dotx template exists in the project directory
   */
  async findTemplate(projectPath: string): Promise<string | null> {
    try {
      const { readdir } = await import('fs/promises');
      const files = await readdir(projectPath);

      const templateFile = files.find(
        (file) => extname(file).toLowerCase() === '.dotx'
      );

      if (templateFile) {
        const templatePath = join(projectPath, templateFile);
        console.log('📝 Word template found:', templatePath);
        return templatePath;
      }

      return null;
    } catch (error) {
      console.error('Error finding template:', error);
      return null;
    }
  }
}

export const wordExportService = new WordExportService();
