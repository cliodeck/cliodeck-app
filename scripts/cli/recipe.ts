/**
 * cliodeck recipe … — CLI commands for recipes (fusion step 4.6).
 */

import fs from 'fs/promises';
import path from 'path';
import { parseRecipe, type Recipe } from '../../backend/recipes/schema.js';
import { RecipeRunner } from '../../backend/recipes/runner.js';
import { buildRegistryFromWorkspace } from './registry-from-v2.js';
import { coerceInputs, type ParsedArgs } from './args.js';
import { v2Paths } from '../../backend/core/workspace/layout.js';

const BUILTIN_DIR = path.join(
  process.cwd(),
  'backend',
  'recipes',
  'builtin'
);

async function loadRecipeByName(
  workspaceRoot: string,
  name: string
): Promise<{ source: 'builtin' | 'user'; recipe: Recipe; path: string }> {
  const userDir = v2Paths(workspaceRoot).recipesDir;
  for (const [source, dir] of [
    ['user', userDir],
    ['builtin', BUILTIN_DIR],
  ] as const) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.ya?ml$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const raw = await fs.readFile(full, 'utf8');
        const recipe = parseRecipe(raw);
        if (recipe.name === name) {
          return { source, recipe, path: full };
        }
      } catch {
        // skip malformed
      }
    }
  }
  throw new Error(`Recipe not found: ${name}`);
}

export async function cmdRecipeList(args: ParsedArgs): Promise<number> {
  const workspace = args.flags.workspace;
  const rows: Array<{
    source: string;
    name: string;
    version: string;
    description: string;
    steps: number;
  }> = [];

  for (const [source, dir] of [
    ['builtin', BUILTIN_DIR] as const,
    ...(workspace
      ? ([['user', v2Paths(workspace).recipesDir]] as const)
      : []),
  ]) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.ya?ml$/i.test(f)) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        const r = parseRecipe(raw);
        rows.push({
          source,
          name: r.name,
          version: r.version,
          description: r.description,
          steps: r.steps.length,
        });
      } catch (e) {
        process.stderr.write(
          `warn: could not parse ${f}: ${
            e instanceof Error ? e.message : String(e)
          }\n`
        );
      }
    }
  }

  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  return 0;
}

export async function cmdRecipeRun(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  const workspace = args.flags.workspace;
  if (!name) {
    process.stderr.write('usage: cliodeck recipe run <name> --workspace <path> [--input k=v]\n');
    return 2;
  }
  if (!workspace) {
    process.stderr.write('--workspace is required\n');
    return 2;
  }

  const { recipe } = await loadRecipeByName(workspace, name);
  const inputs = coerceInputs(args.inputs, recipe.inputs);

  const registry = await buildRegistryFromWorkspace(workspace);
  const runner = new RecipeRunner({
    registry,
    workspaceRoot: workspace,
  });

  const result = await runner.run(recipe, inputs);
  process.stdout.write(
    JSON.stringify(
      {
        ok: result.ok,
        recipe: recipe.name,
        outputs: result.outputs,
        logPath: result.logPath,
        failedStep: result.failedStep,
      },
      null,
      2
    ) + '\n'
  );
  await registry.dispose().catch(() => undefined);
  return result.ok ? 0 : 1;
}
