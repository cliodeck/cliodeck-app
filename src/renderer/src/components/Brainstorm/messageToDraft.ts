/**
 * messageToDraft (fusion phase 3.3).
 *
 * Formats a Brainstorm assistant turn into a Markdown draft block ready to
 * land in the Write editor. Keeps the assistant's text verbatim, optionally
 * appends a "Sources" footer for any RAG citation messages that preceded
 * it (the citation injection pipeline lands later, but the draft format
 * already accommodates it so 3.3 doesn't need to be revisited).
 *
 * The block is wrapped between marker comments so the historian can spot
 * (and later strip) AI-imported drafts from their own prose. Markers are
 * deliberately HTML comments — invisible in rendered Markdown, scriptable
 * to extract.
 */

import type { BrainstormMessage } from '../../stores/chatStore';

export interface DraftCitation {
  /** Stable identifier (e.g., source.id from phase 0.4 union). */
  sourceId: string;
  /** Human label shown in the "Sources" list (title, BibTeX key, note path). */
  label: string;
  /** Optional verbatim quote — wrapped in a blockquote if present. */
  quote?: string;
}

export interface DraftBlockOptions {
  /** ISO timestamp embedded in the marker for traceability. Default: now. */
  at?: string;
  /** RAG citations to append as a Sources list. */
  citations?: DraftCitation[];
}

const OPEN_MARKER = '<!-- cliodeck:brainstorm-draft';
const CLOSE_MARKER = '<!-- /cliodeck:brainstorm-draft -->';

export function messageToDraft(
  message: Pick<BrainstormMessage, 'id' | 'role' | 'content'>,
  opts: DraftBlockOptions = {}
): string {
  if (message.role !== 'assistant') {
    throw new Error(
      `messageToDraft expects an assistant turn, got role=${message.role}`
    );
  }
  const at = opts.at ?? new Date().toISOString();
  const citations = opts.citations ?? [];

  const parts: string[] = [
    `${OPEN_MARKER} id="${message.id}" at="${at}" -->`,
    '',
    message.content.trim(),
  ];

  if (citations.length > 0) {
    parts.push('', '**Sources**', '');
    for (const c of citations) {
      const head = `- \`${c.sourceId}\` — ${c.label}`;
      parts.push(head);
      if (c.quote) {
        const quoted = c.quote
          .trim()
          .split('\n')
          .map((l) => `  > ${l}`)
          .join('\n');
        parts.push(quoted);
      }
    }
  }

  parts.push('', CLOSE_MARKER);
  return parts.join('\n');
}

/**
 * Append a draft to existing editor content, separating with a blank line
 * if the existing content doesn't already end with one. Pure function;
 * the caller commits the result to the editor store.
 */
export function appendDraftToContent(
  existing: string,
  draft: string
): string {
  if (!existing) return draft;
  const sep = existing.endsWith('\n\n')
    ? ''
    : existing.endsWith('\n')
      ? '\n'
      : '\n\n';
  return `${existing}${sep}${draft}\n`;
}

/**
 * Splice a draft block into existing content at `offset`, padding both
 * sides so the inserted markdown sits on a clean block boundary
 * (avoids the case where the draft is concatenated mid-paragraph and
 * the parser fails to recognise the marker line).
 *
 * Used by the cursor-insertion path of `editorStore.insertDraftAtCursor`
 * (fusion 2.6, A13 option a). The "append" path keeps using
 * `appendDraftToContent` above.
 */
export function insertDraftAtOffset(
  existing: string,
  offset: number,
  draft: string
): string {
  if (!existing) return draft;
  const safeOffset = Math.max(0, Math.min(offset, existing.length));
  const before = existing.slice(0, safeOffset);
  const after = existing.slice(safeOffset);
  const padBefore =
    before === '' || before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
        ? '\n'
        : '\n\n';
  const padAfter =
    after === '' || after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n';
  return before + padBefore + draft + padAfter + after;
}
