/**
 * Pandoc-style citations for @lezer/markdown.
 *
 * Bracketed clusters: `[@key]`, `[@key, p. 12]`, `[see @key, p. 33]`,
 * `[@a; @b]`, `[@a, p. 7; @b, pp. 101-103]`. Each `;`-separated segment must
 * contain exactly one `@key`; otherwise the whole bracket is left alone
 * (`[not a citation]` stays plain text). Keys follow the conservative
 * grammar `[A-Za-z0-9_:-]+`.
 *
 * Bare citations: `@key` outside brackets, only when preceded by the start
 * of the inline section or a non-word delimiter — `name@example.org` never
 * matches.
 *
 * Known v1 limits (documented on purpose):
 * - no separate locator node: everything between the key and the next `;`
 *   or `]` is a single `CitationSuffix` (locators included);
 * - a segment whose suffix contains another `@` is rejected wholesale
 *   (avoids e-mail addresses inside brackets);
 * - `@key [p. 15]` parses as a bare citation followed by a plain bracket
 *   (Pandoc would attach the locator).
 *
 * This module is self-contained (no application imports) and intended for
 * standalone publication.
 */
import type { Element, InlineContext, MarkdownConfig } from '@lezer/markdown';
import { Tag, tags } from '@lezer/highlight';

/** Highlighting tags exported for editor themes. */
export const citationTags = {
  /** The whole citation (bracketed cluster or bare `@key`). */
  citation: Tag.define(),
  /** A citation key (without the `@`). */
  key: Tag.define(tags.labelName),
  /** `[`, `]`, `;` and `@` punctuation. */
  mark: Tag.define(tags.processingInstruction),
  /** Prefix (`see …`) and suffix / locator (`, p. 12`) text. */
  affix: Tag.define(),
};

const BRACKET_L = 91; /* [ */
const BRACKET_R = 93; /* ] */
const AT = 64; /* @ */
const SEMICOLON = 59; /* ; */
const BACKSLASH = 92; /* \ */
const CARET = 94; /* ^ */

function isKeyChar(ch: number): boolean {
  return (
    (ch >= 48 && ch <= 57) || // 0-9
    (ch >= 65 && ch <= 90) || // A-Z
    (ch >= 97 && ch <= 122) || // a-z
    ch === 95 || // _
    ch === 58 || // :
    ch === 45 // -
  );
}

/** Characters that may not directly precede a bare `@key`. */
function blocksBareCitation(ch: number): boolean {
  return (
    isKeyChar(ch) || // word characters → e-mail addresses, foo@bar
    ch === 46 || // .   (uni.lu@… style hosts)
    ch === AT ||
    ch === BRACKET_L || // a real `[@…` belongs to the bracketed parser
    ch === BACKSLASH ||
    ch === CARET
  );
}

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

/** True when text[from..to) contains a non-whitespace character. */
function hasInk(cx: InlineContext, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (!isSpace(cx.char(i))) return true;
  }
  return false;
}

/**
 * Parse one `;`-separated segment starting at `from` (document offset).
 * Appends child elements to `children` and returns the position after the
 * segment's terminator handling, or -1 when the segment is not a valid
 * citation segment. `end` is the offset of the closing `]`.
 */
function parseSegment(
  cx: InlineContext,
  from: number,
  end: number,
  children: Element[]
): number {
  // Locate the single `@` of the segment.
  let at = -1;
  let segEnd = end;
  for (let i = from; i < end; i++) {
    const ch = cx.char(i);
    if (ch === SEMICOLON) {
      segEnd = i;
      break;
    }
    if (ch === AT && at < 0) at = i;
  }
  if (at < 0 || at >= segEnd) return -1;

  // The prefix may not end with a word character (e-mail guard) and may not
  // contain `@` (checked implicitly: `at` is the first `@`).
  if (at > from) {
    const prev = cx.char(at - 1);
    if (isKeyChar(prev) || prev === 46) return -1;
  }

  // Key.
  let keyEnd = at + 1;
  while (keyEnd < segEnd && isKeyChar(cx.char(keyEnd))) keyEnd++;
  if (keyEnd === at + 1) return -1;

  // Suffix may not contain another `@`.
  for (let i = keyEnd; i < segEnd; i++) {
    if (cx.char(i) === AT) return -1;
  }

  if (hasInk(cx, from, at)) {
    children.push(cx.elt('CitationPrefix', from, at));
  }
  children.push(cx.elt('CitationMark', at, at + 1));
  children.push(cx.elt('CitationKey', at + 1, keyEnd));
  if (hasInk(cx, keyEnd, segEnd)) {
    children.push(cx.elt('CitationSuffix', keyEnd, segEnd));
  }
  if (segEnd < end) {
    children.push(cx.elt('CitationMark', segEnd, segEnd + 1)); // `;`
    return segEnd + 1;
  }
  return segEnd;
}

function parseBracketed(cx: InlineContext, pos: number): number {
  // Find the closing `]`; give up on nested `[` or an escape.
  let close = -1;
  for (let i = pos + 1; i < cx.end; i++) {
    const ch = cx.char(i);
    if (ch === BRACKET_R) {
      close = i;
      break;
    }
    if (ch === BRACKET_L || ch === BACKSLASH) return -1;
  }
  if (close < 0 || close === pos + 1) return -1;

  const children: Element[] = [cx.elt('CitationMark', pos, pos + 1)];
  let cursor = pos + 1;
  while (cursor < close) {
    const next = parseSegment(cx, cursor, close, children);
    if (next < 0) return -1;
    cursor = next;
  }
  children.push(cx.elt('CitationMark', close, close + 1));
  return cx.addElement(cx.elt('PandocCitation', pos, close + 1, children));
}

function parseBare(cx: InlineContext, pos: number): number {
  if (pos > cx.offset && blocksBareCitation(cx.char(pos - 1))) return -1;
  let keyEnd = pos + 1;
  while (keyEnd < cx.end && isKeyChar(cx.char(keyEnd))) keyEnd++;
  if (keyEnd === pos + 1) return -1;
  return cx.addElement(
    cx.elt('PandocCitation', pos, keyEnd, [
      cx.elt('CitationMark', pos, pos + 1),
      cx.elt('CitationKey', pos + 1, keyEnd),
    ])
  );
}

/**
 * MarkdownConfig adding `PandocCitation` nodes (with `CitationMark`,
 * `CitationKey`, `CitationPrefix`, `CitationSuffix` children).
 */
export const PandocCitations: MarkdownConfig = {
  defineNodes: [
    { name: 'PandocCitation', style: citationTags.citation },
    { name: 'CitationKey', style: citationTags.key },
    { name: 'CitationMark', style: citationTags.mark },
    { name: 'CitationPrefix', style: citationTags.affix },
    { name: 'CitationSuffix', style: citationTags.affix },
  ],
  parseInline: [
    {
      name: 'PandocCitation',
      parse(cx, next, pos) {
        if (next === BRACKET_L && cx.char(pos + 1) !== CARET) {
          return parseBracketed(cx, pos);
        }
        if (next === AT) return parseBare(cx, pos);
        return -1;
      },
      before: 'Link',
    },
  ],
};
