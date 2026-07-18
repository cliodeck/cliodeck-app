#!/usr/bin/env node
/**
 * cliodeck CLI entrypoint (fusion step 4.6).
 *
 * Commands shipped in this scaffold:
 *   cliodeck recipe list     [--workspace <path>]
 *   cliodeck recipe run <name> --workspace <path> [--input k=v …]
 *   cliodeck search "query" --workspace <path> [--topK 10]
 *   cliodeck hints show      --workspace <path>
 *   cliodeck hints set [content] [--file path] --workspace <path>
 *
 * Exit codes:
 *   0   ok
 *   1   runtime failure (recipe step failed, search error, etc.)
 *   2   usage error (missing required flag / bad form)
 *
 * OpenAPI formalisation (plan 4.6.1) isn't in this commit — needs a
 * dedicated pass with openapi-typescript code generation. The command
 * surface here is small and stable enough that shipping it as-is now
 * unblocks batch workflows; the OpenAPI contract can back-fit when
 * external integrations need one.
 */

import { parseArgs } from './cli/args.js';
import { cmdRecipeList, cmdRecipeRun } from './cli/recipe.js';
import { cmdSearch } from './cli/search.js';
import { cmdHintsShow, cmdHintsSet } from './cli/hints.js';
import { cmdImportCliobrain } from './cli/migrate.js';
import { cmdRagBenchmark } from './cli/rag-benchmark.js';
import { initHeadlessJournal } from '../backend/core/usage-journal/headless.js';
import { runWithJournalContext } from '../backend/core/usage-journal/context.js';

const USAGE = `cliodeck — headless operations on a workspace

Usage:
  cliodeck recipe list    [--workspace <path>]
  cliodeck recipe run <name> --workspace <path> [--input k=v …]
  cliodeck search "query" --workspace <path> [--topK 10]
  cliodeck hints show     --workspace <path>
  cliodeck hints set      --workspace <path> [--file path | content]
  cliodeck import-cliobrain <workspace> [--overwrite] [--name <label>]
  cliodeck rag-benchmark   --corpus <docs.json> --queries <queries.json>
                            [--retriever bm25] [--topK 10]
`;

/**
 * Journal d'usage IA : les commandes qui font de l'inférence (recipe run,
 * search) s'exécutent dans un scope `mode: 'cli'` avec le sink headless posé —
 * le décorateur providers, déjà traversé par le CLI, capture alors les
 * événements. Le runner de recipes écrase le mode avec `recipe` + recipeId par
 * step, c'est voulu (une recipe reste une recipe, quel que soit son lanceur).
 */
async function withCliJournal(
  workspace: string | undefined,
  fn: () => Promise<number>
): Promise<number> {
  if (!workspace) return fn();
  const journal = initHeadlessJournal(workspace);
  try {
    return await runWithJournalContext(
      { mode: 'cli', workspaceRoot: workspace },
      fn
    );
  } finally {
    journal?.close();
  }
}

export async function runCli(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = argv[0];
  // Commands with a subcommand (two-level routing) vs. commands whose args
  // start directly after `cmd` (flat routing). We enumerate the two-level
  // ones up front and fall through to flat routing otherwise.
  const twoLevel: Record<string, (a: ReturnType<typeof parseArgs>) => Promise<number>> = {
    'recipe list': cmdRecipeList,
    'recipe run': cmdRecipeRun,
    'hints show': cmdHintsShow,
    'hints set': cmdHintsSet,
  };

  try {
    const sub = argv[1];
    const maybeKey = sub ? `${cmd} ${sub}` : cmd;
    if (twoLevel[maybeKey]) {
      const parsed = parseArgs(argv.slice(2));
      const handler = twoLevel[maybeKey];
      if (maybeKey === 'recipe run') {
        return await withCliJournal(parsed.flags.workspace, () => handler(parsed));
      }
      return await handler(parsed);
    }

    if (cmd === 'search') {
      const parsed = parseArgs(argv.slice(1));
      return await withCliJournal(parsed.flags.workspace, () => cmdSearch(parsed));
    }
    if (cmd === 'import-cliobrain') {
      return await cmdImportCliobrain(parseArgs(argv.slice(1)));
    }
    if (cmd === 'rag-benchmark') {
      return await cmdRagBenchmark(parseArgs(argv.slice(1)));
    }

    process.stderr.write(USAGE);
    return 2;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// Only auto-run when invoked directly, not when imported for tests.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('cliodeck-cli.js');

if (invokedDirectly) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
