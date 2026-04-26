/**
 * MCP tool kind classifier (fusion 2.5).
 *
 * Used to decide whether an MCP tool should be auto-enabled or opt-in
 * when surfaced in the Brainstorm chat. Per A12 (validated): read-only
 * tools auto-enable; write/network tools require explicit user opt-in.
 *
 * The classifier is a pure heuristic on the bare tool name (the part
 * after the `clientName__` namespace prefix is stripped). It deliberately
 * **defaults to `'write'` when uncertain**: the cost of a false positive
 * (asking the user to enable a harmless search tool) is tiny; the cost
 * of a false negative (auto-enabling `delete_record` because the model
 * has decided to call it) is potentially destructive.
 *
 * The whitelist below covers every read-class verb that ships in the
 * cliodeck builtin MCP server (`search_*`, `entity_*`, `graph_*`) and
 * the common verbs third-party servers tend to use. Anything outside
 * is `'write'`.
 */

export type MCPToolKind = 'read' | 'write';

const READ_PREFIXES: readonly string[] = [
  'search_',
  'find_',
  'get_',
  'list_',
  'fetch_',
  'read_',
  'view_',
  'show_',
  'lookup_',
  'query_',
  'count_',
  'describe_',
  'inspect_',
  'analyze_',
  'analyse_',
  'entity_',
  'graph_',
];

/** Whole-name reads where no prefix verb fits cleanly. */
const READ_EXACT: ReadonlySet<string> = new Set([
  'ping',
  'health',
  'healthcheck',
  'whoami',
  'version',
]);

/**
 * Classify `bareToolName` (i.e. the tool name **without** the
 * `clientName__` namespace prefix that `fusion-chat-service.ts` adds
 * before sending to the LLM). Empty / unknown names default to write.
 */
export function classifyMcpTool(bareToolName: string): MCPToolKind {
  if (!bareToolName) return 'write';
  const lower = bareToolName.toLowerCase();
  if (READ_EXACT.has(lower)) return 'read';
  for (const prefix of READ_PREFIXES) {
    if (lower.startsWith(prefix)) return 'read';
  }
  return 'write';
}

/**
 * Convenience: strip the `clientName__` prefix that `fusion-chat-service`
 * applies before the model sees the tool, then classify. Both sides of
 * the system can call `classifyMcpTool` directly when they already have
 * the bare name; this is for code paths that only ever see the
 * namespaced form.
 */
export function classifyNamespacedMcpTool(namespacedName: string): MCPToolKind {
  const sep = namespacedName.indexOf('__');
  const bare = sep >= 0 ? namespacedName.slice(sep + 2) : namespacedName;
  return classifyMcpTool(bare);
}
