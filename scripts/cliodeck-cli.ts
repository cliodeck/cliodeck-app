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
      return await twoLevel[maybeKey](parseArgs(argv.slice(2)));
    }

    if (cmd === 'search') {
      return await cmdSearch(parseArgs(argv.slice(1)));
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
