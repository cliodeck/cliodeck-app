import {
  Paragraph,
  TextRun,
  HeadingLevel,
  convertInchesToTwip,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  ExternalHyperlink,
  FootnoteReferenceRun,
  LevelFormat,
  AlignmentType,
  type INumberingOptions,
} from 'docx';
import { marked, type Token, type Tokens } from 'marked';

/**
 * Markdown → éléments docx, pour le générateur Word interne (celui qui sert
 * quand pandoc n'est pas disponible).
 *
 * Le rendu en ligne suit l'arbre de jetons de `marked`, pas une expression
 * régulière. L'ancienne regex appariait le `_` d'une clé (`Srnicek_2025`)
 * avec le premier `_` venu plus loin et mettait en italique tout ce qui les
 * séparait ; elle laissait les `\[` avec leur antislash ; et trois chemins —
 * notes de bas de page, résumé, citations en retrait — ne passaient pas par
 * elle du tout, d'où des `*…*` et des `[…](…)` littéraux dans le document.
 * Tout ce qui porte du texte passe désormais par `inlineRuns`.
 */

export type InlineChild = TextRun | FootnoteReferenceRun | ExternalHyperlink;
export type BlockChild = Paragraph | Table;

export interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  smallCaps?: boolean;
  /** Taille en demi-points, pour les blocs qui imposent la leur (résumé). */
  size?: number;
  /** Vrai à l'intérieur d'un lien : style « hyperlien », pas de lien imbriqué. */
  link?: boolean;
}

/** Référence de la numérotation des listes ordonnées, à déclarer au document. */
export const ORDERED_LIST_REFERENCE = 'cliodeck-ordered';

export const ORDERED_LIST_NUMBERING: INumberingOptions = {
  config: [
    {
      reference: ORDERED_LIST_REFERENCE,
      levels: [0, 1, 2, 3, 4, 5].map((level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        style: {
          paragraph: {
            indent: {
              left: convertInchesToTwip(0.5 * (level + 1)),
              hanging: convertInchesToTwip(0.25),
            },
          },
        },
      })),
    },
  ],
};

/** Appel de note posé par les étapes amont : `{{FN:12}}`. */
const FOOTNOTE_PLACEHOLDER = /(\{\{FN:\d+\}\})/;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Balises HTML en ligne reconnues : celles que citeproc émet dans une
 * citation rendue (`<i>`, `<b>`, `<sup>`, petites capitales) et leurs
 * synonymes. Toute autre balise est ignorée, son contenu gardé.
 */
function applyHtmlTag(tag: string, style: InlineStyle, base: InlineStyle): InlineStyle {
  const m = tag.match(/^<\s*(\/)?\s*([a-z0-9]+)([^>]*)>$/i);
  if (!m) return style;
  const closing = !!m[1];
  const name = m[2].toLowerCase();
  const set = (key: keyof Omit<InlineStyle, 'size'>): InlineStyle => ({
    ...style,
    [key]: closing ? base[key] : true,
  });
  switch (name) {
    case 'i':
    case 'em':
      return set('italics');
    case 'b':
    case 'strong':
      return set('bold');
    case 'sup':
      return set('superScript');
    case 'sub':
      return set('subScript');
    case 'del':
    case 's':
      return set('strike');
    case 'span':
      if (closing) return { ...style, smallCaps: base.smallCaps };
      return /small-caps/i.test(m[3]) ? { ...style, smallCaps: true } : style;
    default:
      return style;
  }
}

function textRun(text: string, style: InlineStyle): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    superScript: style.superScript,
    subScript: style.subScript,
    smallCaps: style.smallCaps,
    size: style.size,
    ...(style.link ? { style: 'Hyperlink' } : {}),
  });
}

/** Lien cliquable seulement vers l'extérieur : jamais un chemin ou une ancre. */
const LINKABLE = /^(https?:|mailto:)/i;

/**
 * Jetons en ligne de `marked` → enfants de paragraphe docx.
 */
export function inlineRuns(tokens: Token[], base: InlineStyle = {}): InlineChild[] {
  const out: InlineChild[] = [];
  let style = base;

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens?.length) {
          out.push(...inlineRuns(t.tokens, style));
          break;
        }
        for (const piece of decodeEntities(t.text).split(FOOTNOTE_PLACEHOLDER)) {
          if (!piece) continue;
          const fn = piece.match(/^\{\{FN:(\d+)\}\}$/);
          out.push(fn ? new FootnoteReferenceRun(parseInt(fn[1], 10)) : textRun(piece, style));
        }
        break;
      }
      case 'escape':
        out.push(textRun((token as Tokens.Escape).text, style));
        break;
      case 'strong':
        out.push(...inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inlineRuns((token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push(
          new TextRun({
            text: (token as Tokens.Codespan).text,
            font: 'Courier New',
            size: style.size,
            shading: { type: ShadingType.SOLID, color: 'F5F5F5' },
          })
        );
        break;
      case 'br':
        out.push(new TextRun({ break: 1 }));
        break;
      case 'link': {
        const link = token as Tokens.Link;
        if (style.link || !LINKABLE.test(link.href)) {
          out.push(...inlineRuns(link.tokens, style));
          break;
        }
        const children = inlineRuns(link.tokens, { ...style, link: true }).filter(
          (c): c is TextRun => c instanceof TextRun
        );
        out.push(new ExternalHyperlink({ link: decodeEntities(link.href), children }));
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        if (image.text) out.push(textRun(image.text, style));
        break;
      }
      case 'html':
        style = applyHtmlTag((token as Tokens.HTML).text.trim(), style, base);
        break;
      default:
        if ('text' in token && typeof token.text === 'string' && token.text) {
          out.push(textRun(decodeEntities(token.text), style));
        }
    }
  }

  return out;
}

/** Texte en ligne (markdown, ou HTML léger de citeproc) → enfants de paragraphe. */
export function inlineMarkdownRuns(text: string, base: InlineStyle = {}): InlineChild[] {
  const runs = inlineRuns(marked.Lexer.lexInline(text), base);
  return runs.length > 0 ? runs : [textRun('', base)];
}

interface BlockContext {
  /** Retrait cumulé des citations en retrait, en pouces. */
  quoteDepth: number;
  style: InlineStyle;
}

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/**
 * Parse markdown to Word document elements
 */
export class MarkdownToWordParser {
  private blocks: BlockChild[] = [];
  private orderedLists = 0;

  parse(markdownContent: string, style: InlineStyle = {}): BlockChild[] {
    this.blocks = [];
    this.processTokens(marked.lexer(markdownContent), { quoteDepth: 0, style });
    return this.blocks;
  }

  private processTokens(tokens: Token[], ctx: BlockContext): void {
    for (const token of tokens) this.processToken(token, ctx);
  }

  private quoteIndent(ctx: BlockContext): { left: number } | undefined {
    return ctx.quoteDepth > 0 ? { left: convertInchesToTwip(0.5 * ctx.quoteDepth) } : undefined;
  }

  private processToken(token: Token, ctx: BlockContext): void {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        this.blocks.push(
          new Paragraph({
            children: inlineRuns(heading.tokens, ctx.style),
            heading: HEADING_LEVELS[heading.depth] || HeadingLevel.HEADING_1,
          })
        );
        break;
      }

      case 'paragraph':
      case 'text': {
        const inline = (token as Tokens.Paragraph | Tokens.Text).tokens;
        this.blocks.push(
          new Paragraph({
            children: inline?.length
              ? inlineRuns(inline, ctx.style)
              : inlineMarkdownRuns((token as Tokens.Text).text, ctx.style),
            indent: this.quoteIndent(ctx),
            spacing: ctx.quoteDepth > 0 ? { before: 100, after: 100 } : { after: 200 },
          })
        );
        break;
      }

      case 'list':
        this.addList(token as Tokens.List, 0, ctx);
        break;

      case 'code':
        this.addCodeBlock((token as Tokens.Code).text);
        break;

      case 'blockquote':
        // Une citation en retrait garde sa structure (paragraphes, gras,
        // liens) : seuls le retrait et l'italique de fond s'ajoutent.
        this.processTokens((token as Tokens.Blockquote).tokens, {
          quoteDepth: ctx.quoteDepth + 1,
          style: { ...ctx.style, italics: true },
        });
        break;

      case 'table':
        this.addTable(token as Tokens.Table, ctx);
        break;

      case 'hr':
        this.addHorizontalRule();
        break;

      case 'space':
      case 'html':
      case 'def':
        break;

      default:
        if ('text' in token && typeof token.text === 'string') {
          this.blocks.push(
            new Paragraph({
              children: inlineMarkdownRuns(token.text, ctx.style),
              spacing: { after: 200 },
            })
          );
        }
    }
  }

  private addList(list: Tokens.List, level: number, ctx: BlockContext): void {
    const instance = list.ordered ? ++this.orderedLists : 0;
    for (const item of list.items) {
      let first = true;
      for (const child of item.tokens) {
        if (child.type === 'list') {
          this.addList(child as Tokens.List, level + 1, ctx);
          continue;
        }
        if (child.type === 'space' || child.type === 'checkbox') continue;
        const inline = (child as Tokens.Text | Tokens.Paragraph).tokens;
        const runs = inline?.length
          ? inlineRuns(inline, ctx.style)
          : inlineMarkdownRuns('text' in child && typeof child.text === 'string' ? child.text : '', ctx.style);
        if (first && item.task) {
          runs.unshift(new TextRun({ text: `${item.checked ? '☑' : '☐'} ` }));
        }
        this.blocks.push(
          new Paragraph({
            children: runs,
            // Seul le premier paragraphe d'un item porte la puce ; les
            // suivants s'alignent sur son texte.
            ...(first
              ? list.ordered
                ? { numbering: { reference: ORDERED_LIST_REFERENCE, level, instance } }
                : { bullet: { level } }
              : { indent: { left: convertInchesToTwip(0.5 * (level + 1)) } }),
            spacing: { after: 100 },
          })
        );
        first = false;
      }
    }
  }

  private addCodeBlock(code: string): void {
    const lines = code.split('\n');
    this.blocks.push(
      new Paragraph({
        children: lines.map(
          (line, i) =>
            new TextRun({
              text: line,
              font: 'Courier New',
              size: 20,
              ...(i > 0 ? { break: 1 } : {}),
            })
        ),
        shading: {
          type: ShadingType.SOLID,
          color: 'F5F5F5',
        },
        spacing: { before: 100, after: 100 },
      })
    );
  }

  private addTable(token: Tokens.Table, ctx: BlockContext): void {
    const rows: TableRow[] = [];

    if (token.header.length > 0) {
      rows.push(
        new TableRow({
          children: token.header.map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: inlineRuns(cell.tokens, { ...ctx.style, bold: true }),
                  }),
                ],
                shading: {
                  type: ShadingType.SOLID,
                  color: 'CCCCCC',
                },
              })
          ),
        })
      );
    }

    for (const row of token.rows) {
      rows.push(
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ children: inlineRuns(cell.tokens, ctx.style) })],
              })
          ),
        })
      );
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

    this.blocks.push(new Paragraph({ children: [] }));
    this.blocks.push(table);
    this.blocks.push(new Paragraph({ children: [] }));
  }

  private addHorizontalRule(): void {
    this.blocks.push(
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
}
