/**
 * ClioRecipes schema (fusion step 4.3.1).
 *
 * A Recipe is a YAML-authored, parameterised workflow that chains steps
 * across the four historian modes (brainstorm / search / graph / write /
 * export). The schema is validated with zod so malformed recipes fail at
 * load time with precise errors, and the runner (4.3.2) can trust the
 * shape statically afterwards. Recipes are the matérialisation of the
 * Brainstorm ↔ Write bridge the fusion plan calls for — they're also the
 * extension surface the DH community will plug into (goose lesson: make
 * the extension holes explicit).
 */

import { z } from 'zod';
import yaml from 'js-yaml';

export const StepKind = z.enum([
  'brainstorm',
  'search',
  'graph',
  'write',
  'export',
]);
export type StepKind = z.infer<typeof StepKind>;

const InputType = z.enum(['string', 'number', 'boolean', 'path']);
export type InputType = z.infer<typeof InputType>;

export const RecipeInputSchema = z.object({
  type: InputType,
  required: z.boolean().default(false),
  description: z.string().optional(),
  default: z.unknown().optional(),
});
export type RecipeInput = z.infer<typeof RecipeInputSchema>;

export const RecipeStepSchema = z.object({
  id: z.string().min(1),
  kind: StepKind,
  with: z.record(z.string(), z.unknown()).default({}),
});
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeSchema = z.object({
  name: z.string().min(1),
  // YAML often parses bare versions as numbers (e.g. `version: 1`); coerce.
  version: z.coerce.string().min(1),
  description: z.string().default(''),
  inputs: z.record(z.string(), RecipeInputSchema).default({}),
  steps: z.array(RecipeStepSchema).min(1),
  outputs: z.record(z.string(), z.unknown()).default({}),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export class RecipeParseError extends Error {
  constructor(
    message: string,
    public readonly issues?: z.ZodIssue[]
  ) {
    super(message);
    this.name = 'RecipeParseError';
  }
}

export function parseRecipe(yamlString: string): Recipe {
  let raw: unknown;
  try {
    raw = yaml.load(yamlString);
  } catch (e) {
    throw new RecipeParseError(
      `YAML syntax error: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const res = RecipeSchema.safeParse(raw);
  if (!res.success) {
    const summary = res.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new RecipeParseError(
      `Recipe validation failed: ${summary}`,
      res.error.issues
    );
  }
  return res.data;
}

/**
 * Validate user-supplied inputs against the recipe's declared `inputs` shape.
 * Returns a list of human-readable violations; empty array = valid.
 */
export function validateInputs(
  recipe: Recipe,
  inputs: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  for (const [key, def] of Object.entries(recipe.inputs)) {
    const present = key in inputs && inputs[key] !== undefined;
    if (!present) {
      if (def.required) errors.push(`Missing required input: ${key}`);
      continue;
    }
    const v = inputs[key];
    const expected = def.type;
    const actual = typeof v;
    if (expected === 'string' && actual !== 'string')
      errors.push(`Input ${key}: expected string, got ${actual}`);
    if (expected === 'number' && actual !== 'number')
      errors.push(`Input ${key}: expected number, got ${actual}`);
    if (expected === 'boolean' && actual !== 'boolean')
      errors.push(`Input ${key}: expected boolean, got ${actual}`);
    if (expected === 'path' && actual !== 'string')
      errors.push(`Input ${key}: expected path (string), got ${actual}`);
  }
  return errors;
}
