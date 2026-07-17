/**
 * Pandoc-style footnotes for @lezer/markdown.
 *
 * Inline references: `[^id]` — numeric (`[^1]`) or free-form
 * (`[^lester-danzig]`, `[^ü]`) identifiers: any run of characters without
 * whitespace, `[` or `]`.
 *
 * Block definitions: `[^id]: content`, starting at column < baseIndent + 4.
 * A definition is a composite block: continuation lines indented by at least
 * four columns (and blank lines between them) belong to the definition, so a
 * definition can hold several paragraphs, exactly like Pandoc.
 *
 * This module is self-contained (no application imports) and intended for
 * standalone publication.
 */
import type {
  BlockContext,
  InlineContext,
  Line,
  MarkdownConfig,
} from '@lezer/markdown';
import { Tag, tags } from '@lezer/highlight';

/** Highlighting tags exported for editor themes. */
export const footnoteTags = {
  /** The whole inline reference `[^id]`. */
  reference: Tag.define(),
  /** The identifier inside a reference or definition. */
  label: Tag.define(tags.labelName),
  /** The `[^`, `]` and `]:` punctuation. */
  mark: Tag.define(tags.processingInstruction),
};

const BRACKET_L = 91; /* [ */
const BRACKET_R = 93; /* ] */
const CARET = 94; /* ^ */
const COLON = 58; /* : */

/** Continuation indent (columns) required by Pandoc for definition bodies. */
const DEFINITION_INDENT = 4;

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

/**
 * Scan a footnote label starting right after `[^` in `text`.
 * Returns the end index (exclusive) of the label, or -1 when the label is
 * empty or not terminated by `]` on valid characters.
 */
function scanLabel(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === BRACKET_R) return i > start ? i : -1;
    if (ch === BRACKET_L || isSpace(ch)) return -1;
    i++;
  }
  return -1;
}

function parseReference(cx: InlineContext, next: number, pos: number): number {
  if (next !== BRACKET_L || cx.char(pos + 1) !== CARET) return -1;
  const text = cx.slice(pos, cx.end);
  const labelEnd = scanLabel(text, 2);
  if (labelEnd < 0) return -1;
  // Relative offsets in `text` → document offsets.
  const from = pos;
  const to = pos + labelEnd + 1;
  return cx.addElement(
    cx.elt('FootnoteReference', from, to, [
      cx.elt('FootnoteMark', from, from + 2),
      cx.elt('FootnoteLabel', from + 2, pos + labelEnd),
      cx.elt('FootnoteMark', pos + labelEnd, to),
    ])
  );
}

/**
 * Test whether `line` starts a footnote definition. Returns the offset of
 * the closing `]` (line-relative), or -1.
 */
function matchDefinitionStart(line: Line): number {
  // Indented-code territory is not ours.
  if (line.indent >= line.baseIndent + DEFINITION_INDENT) return -1;
  if (line.next !== BRACKET_L || line.text.charCodeAt(line.pos + 1) !== CARET) {
    return -1;
  }
  const labelEnd = scanLabel(line.text.slice(line.pos), 2);
  if (labelEnd < 0) return -1;
  const closeBracket = line.pos + labelEnd;
  if (line.text.charCodeAt(closeBracket + 1) !== COLON) return -1;
  return closeBracket;
}

function parseDefinitionStart(cx: BlockContext, line: Line): boolean | null {
  const closeBracket = matchDefinitionStart(line);
  if (closeBracket < 0) return false;

  const start = cx.lineStart + line.pos;
  cx.startComposite('FootnoteDefinition', line.pos, DEFINITION_INDENT);
  cx.addElement(cx.elt('FootnoteMark', start, start + 2));
  cx.addElement(
    cx.elt('FootnoteLabel', start + 2, cx.lineStart + closeBracket)
  );
  cx.addElement(
    cx.elt(
      'FootnoteMark',
      cx.lineStart + closeBracket,
      cx.lineStart + closeBracket + 2
    )
  );
  // Content after `]:` (plus one optional space) parses as child blocks.
  line.moveBase(line.skipSpace(closeBracket + 2));
  return null;
}

/**
 * MarkdownConfig adding `FootnoteReference` (inline) and
 * `FootnoteDefinition` (composite block) nodes.
 */
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    {
      name: 'FootnoteDefinition',
      block: true,
      composite(_cx, line, value) {
        // Same continuation rule as list items: blank lines, or lines
        // indented by at least `value` columns, stay in the definition.
        if (line.indent < line.baseIndent + value && line.next > -1) {
          return false;
        }
        line.moveBaseColumn(line.baseIndent + value);
        return true;
      },
    },
    { name: 'FootnoteReference', style: footnoteTags.reference },
    { name: 'FootnoteLabel', style: footnoteTags.label },
    { name: 'FootnoteMark', style: footnoteTags.mark },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse: parseDefinitionStart,
      // A `[^id]:` line interrupts an open paragraph — otherwise a second
      // definition right below a one-line definition would be swallowed by
      // lazy paragraph continuation.
      endLeaf: (_cx, line) => matchDefinitionStart(line) >= 0,
      before: 'LinkReference',
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse: parseReference,
      before: 'Link',
    },
  ],
};
