import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  convertInchesToTwip,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  UnderlineType,
  Header,
  Footer,
  PageNumber,
} from 'docx';
import { marked } from 'marked';
import { processMarkdownCitations, type ProcessedFootnote } from './citation-pipeline.js';
import { bibliographyService } from './bibliography-service.js';
// FootnoteReferenceRun is the inline run; document footnotes are declared
// via `Document.footnotes` keyed by id.
import { FootnoteReferenceRun } from 'docx';
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

// MARK: - Markdown Parser for Word

/**
 * Parse markdown to Word document elements
 */
class MarkdownToWordParser {
  private paragraphs: Paragraph[] = [];

  async parse(markdownContent: string): Promise<Paragraph[]> {
    this.paragraphs = [];

    // Parse markdown using marked
    const tokens = marked.lexer(markdownContent);

    for (const token of tokens) {
      await this.processToken(token);
    }

    return this.paragraphs;
  }

  private async processToken(token: any): Promise<void> {
    switch (token.type) {
      case 'heading':
        this.addHeading(token.text, token.depth);
        break;

      case 'paragraph':
        this.addParagraph(token.text);
        break;

      case 'list':
        this.addList(token);
        break;

      case 'code':
        this.addCodeBlock(token.text);
        break;

      case 'blockquote':
        this.addBlockquote(token.text);
        break;

      case 'table':
        this.addTable(token);
        break;

      case 'hr':
        this.addHorizontalRule();
        break;

      case 'space':
        // Skip empty space
        break;

      default:
        // For unsupported types, add as plain text
        if ('text' in token && typeof token.text === 'string') {
          this.addParagraph(token.text);
        }
    }
  }

  private addHeading(text: string, level: number): void {
    const headingLevels: Record<number, typeof HeadingLevel[keyof typeof HeadingLevel]> = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
      4: HeadingLevel.HEADING_4,
      5: HeadingLevel.HEADING_5,
      6: HeadingLevel.HEADING_6,
    };

    this.paragraphs.push(
      new Paragraph({
        text: this.stripMarkdown(text),
        heading: headingLevels[level] || HeadingLevel.HEADING_1,
      })
    );
  }

  private addParagraph(text: string): void {
    const runs = this.parseInlineFormatting(text);
    this.paragraphs.push(
      new Paragraph({
        children: runs,
        spacing: { after: 200 },
      })
    );
  }

  private addList(token: any): void {
    for (const item of token.items) {
      const runs = this.parseInlineFormatting(item.text);
      this.paragraphs.push(
        new Paragraph({
          children: runs,
          bullet: { level: 0 },
          spacing: { after: 100 },
        })
      );

      // Handle nested lists recursively
      if (item.task !== undefined) {
        // Task list item
        const checkbox = item.checked ? '☑' : '☐';
        runs.unshift(new TextRun({ text: checkbox + ' ' }));
      }
    }
  }

  private addCodeBlock(code: string): void {
    this.paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: code,
            font: 'Courier New',
            size: 20,
          }),
        ],
        shading: {
          type: ShadingType.SOLID,
          color: 'F5F5F5',
        },
        spacing: { before: 100, after: 100 },
      })
    );
  }

  private addBlockquote(text: string): void {
    this.paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: this.stripMarkdown(text),
            italics: true,
          }),
        ],
        indent: { left: convertInchesToTwip(0.5) },
        spacing: { before: 100, after: 100 },
      })
    );
  }

  private addTable(token: any): void {
    const rows: TableRow[] = [];

    // Header row
    if (token.header && token.header.length > 0) {
      const headerCells = token.header.map(
        (cell: any) =>
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: this.stripMarkdown(cell.text),
                    bold: true,
                  }),
                ],
              }),
            ],
            shading: {
              type: ShadingType.SOLID,
              color: 'CCCCCC',
            },
          })
      );
      rows.push(new TableRow({ children: headerCells }));
    }

    // Data rows
    for (const row of token.rows) {
      const cells = row.map(
        (cell: any) =>
          new TableCell({
            children: [
              new Paragraph({
                children: this.parseInlineFormatting(cell.text),
              }),
            ],
          })
      );
      rows.push(new TableRow({ children: cells }));
    }

    const table = new Table({
      rows,
      width: {
        size: 100,
        type: WidthType.PERCENTAGE,
      },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1 },
        bottom: { style: BorderStyle.SINGLE, size: 1 },
        left: { style: BorderStyle.SINGLE, size: 1 },
        right: { style: BorderStyle.SINGLE, size: 1 },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
        insideVertical: { style: BorderStyle.SINGLE, size: 1 },
      },
    });

    // Tables need to be wrapped in a special container
    this.paragraphs.push(new Paragraph({ children: [] })); // Empty paragraph before table
    // @ts-ignore - Table is a valid document element
    this.paragraphs.push(table);
    this.paragraphs.push(new Paragraph({ children: [] })); // Empty paragraph after table
  }

  private addHorizontalRule(): void {
    this.paragraphs.push(
      new Paragraph({
        border: {
          bottom: {
            color: '000000',
            space: 1,
            style: BorderStyle.SINGLE,
            size: 6,
          },
        },
        spacing: { before: 200, after: 200 },
      })
    );
  }

  private parseInlineFormatting(text: string): Array<TextRun | FootnoteReferenceRun> {
    const runs: Array<TextRun | FootnoteReferenceRun> = [];

    // Footnote placeholder produced by CitationEngine pipeline:
    //   {{FN:N}} -> FootnoteReferenceRun(N)
    const segments = text.split(
      /(\{\{FN:\d+\}\}|\*\*.*?\*\*|__.*?__|_.*?_|\*.*?\*|`.*?`|\[.*?\]\(.*?\))/g
    );

    for (const segment of segments) {
      if (!segment) continue;

      // Footnote reference placeholder
      const fnMatch = segment.match(/^\{\{FN:(\d+)\}\}$/);
      if (fnMatch) {
        runs.push(new FootnoteReferenceRun(parseInt(fnMatch[1], 10)));
        continue;
      }

      // Bold: **text** or __text__
      if (/^\*\*(.*?)\*\*$/.test(segment) || /^__(.*?)__$/.test(segment)) {
        const match = segment.match(/^\*\*(.*?)\*\*$/) || segment.match(/^__(.*?)__$/);
        if (match) {
          runs.push(new TextRun({ text: match[1], bold: true }));
        }
      }
      // Italic: *text* or _text_
      else if (/^\*(.*?)\*$/.test(segment) || /^_(.*?)_$/.test(segment)) {
        const match = segment.match(/^\*(.*?)\*$/) || segment.match(/^_(.*?)_$/);
        if (match) {
          runs.push(new TextRun({ text: match[1], italics: true }));
        }
      }
      // Code: `text`
      else if (/^`(.*?)`$/.test(segment)) {
        const match = segment.match(/^`(.*?)`$/);
        if (match) {
          runs.push(
            new TextRun({
              text: match[1],
              font: 'Courier New',
              shading: { type: ShadingType.SOLID, color: 'F5F5F5' },
            })
          );
        }
      }
      // Link: [text](url)
      else if (/^\[(.*?)\]\((.*?)\)$/.test(segment)) {
        const match = segment.match(/^\[(.*?)\]\((.*?)\)$/);
        if (match) {
          runs.push(
            new TextRun({
              text: match[1],
              color: '0000FF',
              underline: { type: UnderlineType.SINGLE },
            })
          );
        }
      }
      // Plain text
      else {
        runs.push(new TextRun({ text: segment }));
      }
    }

    return runs.length > 0 ? runs : [new TextRun({ text })];
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1');
  }
}

/** Strip HTML tags / entities from citeproc output for plain-text Word runs. */
const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Unescape citation keys that were escaped by Milkdown editor
 * Transforms \[@citation\_key] back to [@citation_key]
 */
const unescapeCitations = (content: string): string => {
  return content
    // Unescape the opening bracket: \[@ -> [@
    .replace(/\\(\[@)/g, '$1')
    // Unescape underscores within citation brackets [@...\_...] -> [@..._...]
    .replace(/(\[@[^\]]*)\\_([^\]]*\])/g, (_match, before, after) => {
      let result = before + '_' + after;
      while (result.includes('\\_')) {
        result = result.replace('\\_', '_');
      }
      return result;
    });
};

// MARK: - Service

export class WordExportService {
  private parser = new MarkdownToWordParser();

  /**
   * Get the extended PATH for macOS that includes Homebrew and MacTeX paths
   * GUI apps on macOS don't inherit the user's shell PATH
   */
  private getExtendedPath(): string {
    const currentPath = process.env.PATH || '';
    const additionalPaths = [
      '/opt/homebrew/bin',           // Homebrew on Apple Silicon
      '/usr/local/bin',              // Homebrew on Intel Mac
      '/Library/TeX/texbin',         // MacTeX
      '/usr/texbin',                 // Older MacTeX location
      '/opt/local/bin',              // MacPorts
    ];

    // Add paths that aren't already in PATH
    const pathsToAdd = additionalPaths.filter(p => !currentPath.includes(p));
    return [...pathsToAdd, currentPath].join(':');
  }

  /**
   * Check if pandoc is available
   */
  private async checkPandoc(): Promise<boolean> {
    const extendedPath = this.getExtendedPath();
    return new Promise((resolve) => {
      const proc = spawn('which', ['pandoc'], {
        env: { ...process.env, PATH: extendedPath }
      });
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
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
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

      // Build YAML frontmatter for metadata
      let yamlFrontmatter = '---\n';
      if (options.metadata?.title) {
        yamlFrontmatter += `title: "${options.metadata.title}"\n`;
      }
      if (options.metadata?.author) {
        yamlFrontmatter += `author: "${options.metadata.author}"\n`;
      }
      if (options.metadata?.date) {
        yamlFrontmatter += `date: "${options.metadata.date}"\n`;
      }
      if (options.metadata?.abstract) {
        yamlFrontmatter += `abstract: |\n  ${options.metadata.abstract.replace(/\n/g, '\n  ')}\n`;
      }
      yamlFrontmatter += '---\n\n';

      const cleanedContent = unescapeCitations(options.content);
      const fullContent = yamlFrontmatter + cleanedContent;
      await writeFile(inputPath, fullContent);

      // Build pandoc arguments
      const pandocArgs = [
        inputPath,
        '-o', outputPath,
        '--from', 'markdown',
        '--to', 'docx',
      ];

      // Add bibliography and CSL if provided
      const bibPath = options.bibliographyPath;
      if (bibPath && existsSync(bibPath)) {
        pandocArgs.push('--bibliography', bibPath);
        pandocArgs.push('--citeproc');
        console.log('📚 Using bibliography:', bibPath);

        // Add CSL style if provided
        if (options.cslPath && existsSync(options.cslPath)) {
          pandocArgs.push('--csl', options.cslPath);
          console.log('📚 Using CSL style:', options.cslPath);
        }

        // Add reference section title
        pandocArgs.push('--metadata', 'reference-section-title=Références');
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
      await new Promise<void>((resolve, reject) => {
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
            resolve();
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

      // Cleanup temp directory
      await rm(tempDir, { recursive: true, force: true });

      console.log('✅ Word document exported successfully with pandoc:', outputPath);
      return { success: true, outputPath };
    } catch (error: any) {
      // Cleanup on error
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {}

      console.error('❌ Pandoc Word export failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Export markdown to Word document (.docx)
   * Uses pandoc when bibliography is available for proper citation processing
   */
  async exportToWord(
    options: WordExportOptions,
    onProgress?: (progress: WordExportProgress) => void
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      onProgress?.({
        stage: 'preparing',
        message: 'Préparation de l\'export Word...',
        progress: 10,
      });

      // Load abstract if needed
      let abstract = options.metadata?.abstract;
      if (
        !abstract &&
        (options.projectType === 'article' || options.projectType === 'book')
      ) {
        const abstractPath = join(options.projectPath, 'abstract.md');
        if (existsSync(abstractPath)) {
          const abstractContent = await readFile(abstractPath, 'utf-8');
          abstract = abstractContent.replace(/^#\s*Résumé\s*\n*/i, '').trim();
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

      // Check if we should use pandoc (when bibliography is present)
      const hasBibliography = options.bibliographyPath && existsSync(options.bibliographyPath);
      const hasPandoc = await this.checkPandoc();

      // When the CitationEngine pipeline is requested we stay on the
      // native docx path so we can emit proper Word footnotes via
      // FootnoteReferenceRun — pandoc's citeproc would otherwise fight
      // for the same markers.
      const useEnginePipeline = !!options.citation?.useEngine;

      if (hasBibliography && hasPandoc && !useEnginePipeline) {
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
      let sourceMarkdown = options.content;
      let engineFootnotes: ProcessedFootnote[] = [];
      let engineBibliography: string[] = [];
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
          }
          // Swap Pandoc footnote markers for our docx placeholder.
          sourceMarkdown = processed.md.replace(/\[\^(\d+)\]/g, '{{FN:$1}}');
          engineFootnotes = processed.footnotes;
          engineBibliography = processed.bibliography;
        } catch (err) {
          console.warn('⚠️ CitationEngine pre-processing failed:', err);
        }
      }

      // Parse markdown content
      const contentParagraphs = await this.parser.parse(sourceMarkdown);

      // Append bibliography section if we have entries.
      if (engineBibliography.length > 0) {
        contentParagraphs.push(
          new Paragraph({
            text: 'Bibliographie',
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 },
          })
        );
        for (const entry of engineBibliography) {
          contentParagraphs.push(
            new Paragraph({
              children: [new TextRun({ text: stripHtml(entry) })],
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
        const titlePageChildren: Paragraph[] = [];

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
                  text: 'Résumé',
                  bold: true,
                  size: 28,
                }),
              ],
              spacing: { before: 400, after: 200 },
            })
          );

          titlePageChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: abstract,
                  size: 24,
                }),
              ],
              spacing: { after: 400 },
            })
          );
        }

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
      for (const fn of engineFootnotes) {
        docxFootnotes[String(fn.n)] = {
          children: [
            new Paragraph({
              children: [new TextRun({ text: stripHtml(fn.text) })],
            }),
          ],
        };
      }

      // Create document
      const doc = new Document({
        creator: options.metadata?.author || 'ClioDesk',
        title: options.metadata?.title || 'Document',
        description: abstract || '',
        sections,
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
      return { success: true, outputPath };
    } catch (error: any) {
      console.error('❌ Word export failed:', error);
      return { success: false, error: error.message };
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
