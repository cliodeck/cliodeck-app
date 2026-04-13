import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { parseRecipe, validateInputs, RecipeParseError } from '../schema.js';

const builtinDir = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'builtin'
);

describe('Recipe schema (4.3.1)', () => {
  it('parses a minimal valid recipe', () => {
    const r = parseRecipe(`
name: demo
version: 0.1.0
description: demo
steps:
  - id: s1
    kind: brainstorm
    with:
      prompt: hi
`);
    expect(r.name).toBe('demo');
    expect(r.steps[0].kind).toBe('brainstorm');
  });

  it('rejects missing required fields with useful errors', () => {
    try {
      parseRecipe('name: demo\nversion: 1\n');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RecipeParseError);
      expect((e as RecipeParseError).message).toMatch(/steps/);
    }
  });

  it('rejects unknown step kinds', () => {
    expect(() =>
      parseRecipe(`
name: bad
version: 1
steps:
  - id: s1
    kind: dance
    with: {}
`)
    ).toThrow(/kind/);
  });

  it('rejects YAML syntax errors with a clear message', () => {
    expect(() => parseRecipe('name: demo\nversion: 1\nsteps: [')).toThrow(
      /YAML syntax error/
    );
  });

  it.each([
    'revue-zotero.yaml',
    'analyse-corpus-tropy.yaml',
    'brainstorm-chapitre.yaml',
    'export-chapitre-chicago.yaml',
  ])('builtin recipe %s parses', async (file) => {
    const yaml = await fs.readFile(path.join(builtinDir, file), 'utf8');
    const r = parseRecipe(yaml);
    expect(r.steps.length).toBeGreaterThan(0);
  });
});

describe('validateInputs', () => {
  const recipe = parseRecipe(`
name: t
version: 1
inputs:
  collection:
    type: string
    required: true
  limit:
    type: number
    required: false
steps:
  - id: s
    kind: search
    with: {}
`);

  it('passes when all required present with right types', () => {
    expect(validateInputs(recipe, { collection: 'ABC' })).toEqual([]);
  });

  it('flags missing required', () => {
    expect(validateInputs(recipe, {})).toEqual([
      'Missing required input: collection',
    ]);
  });

  it('flags type mismatch', () => {
    expect(
      validateInputs(recipe, { collection: 'x', limit: 'not-a-number' })
    ).toEqual(['Input limit: expected number, got string']);
  });
});
