import * as fs from 'fs';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  UnderlineType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from 'docx';
import { marked } from 'marked';

export interface DOCXExportOptions {
  title?: string;
  author?: string;
  fontSize?: number;
  lineSpacing?: number;
}

interface ParsedBlock {
  type: 'paragraph' | 'heading' | 'list' | 'code' | 'blockquote' | 'table' | 'hr';
  level?: number;
  content: string;
  items?: string[];
  ordered?: boolean;
  rows?: string[][];
}

export class DOCXExporter {
  /**
   * Exporte du markdown en DOCX
   */
  async exportToDOCX(
    markdown: string,
    outputPath: string,
    options?: DOCXExportOptions
  ): Promise<void> {
    // Parser le markdown
    const blocks = this.parseMarkdown(markdown);

    // Créer le document DOCX
    const doc = new Document({
      title: options?.title,
      creator: options?.author || 'ClioDesk',
      sections: [
        {
          properties: {},
          children: this.blocksToDocxElements(blocks, options),
        },
      ],
    });

    // Générer le fichier
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    console.log(`✅ DOCX exporté: ${outputPath}`);
  }

  /**
   * Parse le markdown en blocs structurés
   */
  private parseMarkdown(markdown: string): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    const lines = markdown.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Heading
      if (line.startsWith('#')) {
        const level = line.match(/^#+/)?.[0].length || 1;
        const content = line.replace(/^#+\s*/, '').trim();
        blocks.push({ type: 'heading', level, content });
        i++;
        continue;
      }

      // Horizontal rule
      if (line.match(/^[-*_]{3,}$/)) {
        blocks.push({ type: 'hr', content: '' });
        i++;
        continue;
      }

      // Code block
      if (line.startsWith('```')) {
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'code', content: codeLines.join('\n') });
        i++;
        continue;
      }

      // Unordered list
      if (line.match(/^[-*+]\s/)) {
        const items: string[] = [];
        while (i < lines.length && lines[i].match(/^[-*+]\s/)) {
          items.push(lines[i].replace(/^[-*+]\s*/, ''));
          i++;
        }
        blocks.push({ type: 'list', content: '', items, ordered: false });
        continue;
      }

      // Ordered list
      if (line.match(/^\d+\.\s/)) {
        const items: string[] = [];
        while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
          items.push(lines[i].replace(/^\d+\.\s*/, ''));
          i++;
        }
        blocks.push({ type: 'list', content: '', items, ordered: true });
        continue;
      }

      // Blockquote
      if (line.startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].startsWith('>')) {
          quoteLines.push(lines[i].replace(/^>\s*/, ''));
          i++;
        }
        blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph
      const paragraphLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !this.isSpecialLine(lines[i])) {
        paragraphLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', content: paragraphLines.join(' ') });
    }

    return blocks;
  }

  private isSpecialLine(line: string): boolean {
    return (
      line.startsWith('#') ||
      line.startsWith('```') ||
      line.match(/^[-*+]\s/) !== null ||
      line.match(/^\d+\.\s/) !== null ||
      line.startsWith('>') ||
      line.match(/^[-*_]{3,}$/) !== null
    );
  }

  /**
   * Convertit les blocs en éléments DOCX
   */
  private blocksToDocxElements(blocks: ParsedBlock[], options?: DOCXExportOptions): Paragraph[] {
    const elements: Paragraph[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'heading':
          elements.push(this.createHeading(block.content, block.level || 1));
          break;

        case 'paragraph':
          elements.push(this.createParagraph(block.content, options));
          break;

        case 'list':
          if (block.items) {
            for (const item of block.items) {
              elements.push(this.createListItem(item, block.ordered || false));
            }
          }
          break;

        case 'code':
          elements.push(this.createCodeBlock(block.content));
          break;

        case 'blockquote':
          elements.push(this.createBlockquote(block.content));
          break;

        case 'hr':
          elements.push(this.createHorizontalRule());
          break;
      }
    }

    return elements;
  }

  /**
   * Crée un heading
   */
  private createHeading(text: string, level: number): Paragraph {
    const headingLevel = this.getHeadingLevel(level);

    return new Paragraph({
      text,
      heading: headingLevel,
      spacing: { before: 240, after: 120 },
    });
  }

  private getHeadingLevel(level: number): typeof HeadingLevel[keyof typeof HeadingLevel] {
    const levels = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
      HeadingLevel.HEADING_5,
      HeadingLevel.HEADING_6,
    ];
    return levels[Math.min(level - 1, 5)];
  }

  /**
   * Crée un paragraphe avec formatting inline (bold, italic, code)
   */
  private createParagraph(text: string, options?: DOCXExportOptions): Paragraph {
    const runs = this.parseInlineFormatting(text);

    return new Paragraph({
      children: runs,
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 120, after: 120 },
      indent: { firstLine: 720 }, // 1.27 cm (0.5 inch)
    });
  }

  /**
   * Parse le formatting inline (bold, italic, code, links)
   */
  private parseInlineFormatting(text: string): TextRun[] {
    const runs: TextRun[] = [];

    // Simple parsing: détecter **bold**, *italic*, `code`
    const regex = /(\*\*.*?\*\*|\*.*?\*|`.*?`|\[.*?\]\(.*?\))/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Texte avant le match
      if (match.index > lastIndex) {
        runs.push(new TextRun(text.substring(lastIndex, match.index)));
      }

      const matched = match[0];

      // Bold
      if (matched.startsWith('**')) {
        runs.push(new TextRun({ text: matched.slice(2, -2), bold: true }));
      }
      // Italic
      else if (matched.startsWith('*')) {
        runs.push(new TextRun({ text: matched.slice(1, -1), italics: true }));
      }
      // Code
      else if (matched.startsWith('`')) {
        runs.push(
          new TextRun({
            text: matched.slice(1, -1),
            font: 'Courier New',
            shading: { fill: 'F0F0F0' },
          })
        );
      }
      // Link
      else if (matched.startsWith('[')) {
        const linkMatch = matched.match(/\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
          runs.push(
            new TextRun({
              text: linkMatch[1],
              color: '0066CC',
              underline: { type: UnderlineType.SINGLE },
            })
          );
        }
      }

      lastIndex = regex.lastIndex;
    }

    // Texte après le dernier match
    if (lastIndex < text.length) {
      runs.push(new TextRun(text.substring(lastIndex)));
    }

    return runs.length > 0 ? runs : [new TextRun(text)];
  }

  /**
   * Crée un item de liste
   */
  private createListItem(text: string, ordered: boolean): Paragraph {
    const runs = this.parseInlineFormatting(text);

    return new Paragraph({
      children: runs,
      bullet: ordered ? undefined : { level: 0 },
      numbering: ordered ? { reference: 'default-numbering', level: 0 } : undefined,
      spacing: { before: 60, after: 60 },
    });
  }

  /**
   * Crée un bloc de code
   */
  private createCodeBlock(code: string): Paragraph {
    return new Paragraph({
      children: [
        new TextRun({
          text: code,
          font: 'Courier New',
          size: 20, // 10pt
        }),
      ],
      shading: { fill: 'F5F5F5' },
      spacing: { before: 120, after: 120 },
      indent: { left: 360 },
    });
  }

  /**
   * Crée une blockquote
   */
  private createBlockquote(text: string): Paragraph {
    const runs = this.parseInlineFormatting(text);

    return new Paragraph({
      children: runs,
      shading: { fill: 'F9F9F9' },
      spacing: { before: 120, after: 120 },
      indent: { left: 720 },
      border: {
        left: {
          color: 'CCCCCC',
          space: 1,
          style: BorderStyle.SINGLE,
          size: 6,
        },
      },
    });
  }

  /**
   * Crée une ligne horizontale
   */
  private createHorizontalRule(): Paragraph {
    return new Paragraph({
      border: {
        bottom: {
          color: 'CCCCCC',
          space: 1,
          style: BorderStyle.SINGLE,
          size: 6,
        },
      },
      spacing: { before: 240, after: 240 },
    });
  }
}
