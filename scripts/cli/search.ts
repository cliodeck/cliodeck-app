/**
 * cliodeck search … — CLI search over the workspace's Obsidian vault
 * (fusion step 4.6).
 *
 * Lexical-only (FTS5) for now so the command stays offline and fast —
 * same trade-off as the MCP tool (2.5). A `--hybrid` flag will land when
 * we wire the embedding provider through the CLI, needing a running
 * Ollama or a cloud key.
 */

import { ObsidianVaultStore } from '../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import { readWorkspaceConfig } from '../../backend/core/workspace/config.js';
import type { ParsedArgs } from './args.js';

const DEFAULT_DIM = 768;

export async function cmdSearch(args: ParsedArgs): Promise<number> {
  const workspace = args.flags.workspace;
  const query = args.positional.join(' ').trim();
  const topK = args.flags.topK ? Number(args.flags.topK) : 10;

  if (!workspace) {
    process.stderr.write('--workspace is required\n');
    return 2;
  }
  if (!query) {
    process.stderr.write('usage: cliodeck search "query" --workspace <path> [--topK 10]\n');
    return 2;
  }

  // Read workspace config to get the declared embedding dimension, so the
  // store opens with the right schema even though the lexical path ignores
  // the embedding column.
  let dimension = DEFAULT_DIM;
  try {
    const cfg = await readWorkspaceConfig(workspace);
    if (cfg.embedding?.dimension) dimension = cfg.embedding.dimension;
  } catch {
    // workspace may not have a v2 config yet — default dim is fine.
  }

  const store = new ObsidianVaultStore({
    dbPath: obsidianStorePath(workspace),
    dimension,
  });

  try {
    const hits = store.searchLexical(query, topK);
    process.stdout.write(
      JSON.stringify(
        {
          query,
          topK,
          hits: hits.map((h) => ({
            notePath: h.note.relativePath,
            title: h.note.title,
            section: h.chunk.sectionTitle ?? null,
            score: h.score,
            content: h.chunk.content,
          })),
        },
        null,
        2
      ) + '\n'
    );
    return 0;
  } finally {
    store.close();
  }
}
