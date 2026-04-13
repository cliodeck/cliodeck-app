/**
 * Workspace hints loader (fusion step 4.1, goose lesson #3: `.cliohints`).
 *
 * A workspace's `hints.md` is durable context the historian wants injected
 * into every prompt: citation style, house rules ("toujours en Chicago"),
 * period focus, language preference, disambiguations. Kept as plain Markdown
 * so the user edits it in any editor and can version-control it with the
 * workspace.
 *
 * Scope: backend loader + prompt-injection helper. The renderer settings
 * editor arrives with Phase 3 UI work.
 *
 * Two injection modes are exposed — pick per call site:
 *   - `prependAsSystemMessage`: prepends a `system` `ChatMessage` to an
 *     existing chat array (for brainstorm / write tool flows).
 *   - `prependAsPrompt`: wraps a bare prompt string (for recipe steps
 *     calling `llm.complete`).
 *
 * External MCP tools MUST NOT receive workspace hints unless the user
 * explicitly opts in per-tool — `.cliohints` may contain private
 * historiographical judgements the historian doesn't want leaked to
 * third-party servers. The helpers here stay local; the MCP client phase
 * (4.4) layers opt-in on top.
 */

import fs from 'fs/promises';
import { v2Paths } from '../workspace/layout.js';
import type { ChatMessage } from '../llm/providers/base.js';

export interface WorkspaceHints {
  /** Raw markdown as authored by the user. Empty string when no hints file. */
  raw: string;
  /** Trimmed and whitespace-collapsed version, ready for prompt injection. */
  normalized: string;
  /** Absolute path of the `hints.md` that was read (whether or not present). */
  sourcePath: string;
  /** True if the hints file existed and was non-empty. */
  present: boolean;
}

export async function loadWorkspaceHints(
  workspaceRoot: string
): Promise<WorkspaceHints> {
  const sourcePath = v2Paths(workspaceRoot).hints;
  let raw = '';
  try {
    raw = await fs.readFile(sourcePath, 'utf8');
  } catch {
    return {
      raw: '',
      normalized: '',
      sourcePath,
      present: false,
    };
  }
  const normalized = raw.trim();
  return {
    raw,
    normalized,
    sourcePath,
    present: normalized.length > 0,
  };
}

export async function writeWorkspaceHints(
  workspaceRoot: string,
  markdown: string
): Promise<void> {
  const sourcePath = v2Paths(workspaceRoot).hints;
  await fs.writeFile(sourcePath, markdown, 'utf8');
}

const HEADER = 'Directives durables du workspace (.cliohints)';
const FOOTER = 'Fin des directives.';

function wrap(hints: WorkspaceHints): string {
  return `[${HEADER}]\n${hints.normalized}\n[${FOOTER}]`;
}

/**
 * Prepend a `system` message carrying the hints to an existing chat. If the
 * conversation already opens with a `system` message, the hints are merged
 * into a *new* leading system message so both stay distinguishable for
 * compactor logic (meta.ragCitation=false, ordinary system).
 */
export function prependAsSystemMessage(
  messages: ChatMessage[],
  hints: WorkspaceHints
): ChatMessage[] {
  if (!hints.present) return messages;
  return [{ role: 'system', content: wrap(hints) }, ...messages];
}

/**
 * Wrap a bare prompt string with a hints preamble. Recipes / one-shot
 * `llm.complete` calls use this when they don't have a message array.
 */
export function prependAsPrompt(prompt: string, hints: WorkspaceHints): string {
  if (!hints.present) return prompt;
  return `${wrap(hints)}\n\n${prompt}`;
}
