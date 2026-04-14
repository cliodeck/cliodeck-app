import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RecipeRunner, type RunEvent } from '../runner.js';
import { parseRecipe } from '../schema.js';
import type { ProviderRegistry } from '../../core/llm/providers/registry.js';
import type { LLMProvider, ChatChunk } from '../../core/llm/providers/base.js';

function fakeLLM(canned: string): LLMProvider {
  return {
    id: 'fake',
    name: 'fake',
    capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
    getStatus: () => ({ state: 'ready', lastReadyAt: 'now' }),
    healthCheck: async () => ({ state: 'ready', lastReadyAt: 'now' }),
    chat: async function* (): AsyncIterable<ChatChunk> {
      yield { delta: canned, done: true, finishReason: 'stop' };
    },
    complete: async () => canned,
    dispose: async () => undefined,
  };
}

function fakeRegistry(canned: string): ProviderRegistry {
  const llm = fakeLLM(canned);
  return {
    getLLM: () => llm,
  } as unknown as ProviderRegistry;
}

let tmpRoot = '';
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-recipe-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readLog(logPath: string): Promise<RunEvent[]> {
  const raw = await fs.readFile(logPath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l)
    .map((l) => JSON.parse(l) as RunEvent);
}

describe('RecipeRunner (4.3.2)', () => {
  it('runs an LLM step and writes a typed event log', async () => {
    const recipe = parseRecipe(`
name: demo
version: 0.1.0
steps:
  - id: think
    kind: brainstorm
    with:
      prompt: "say hi"
`);
    const runner = new RecipeRunner({
      registry: fakeRegistry('SUMMARY_OK'),
      workspaceRoot: tmpRoot,
    });
    const res = await runner.run(recipe, {});
    expect(res.ok).toBe(true);
    expect(res.outputs.think).toBe('SUMMARY_OK');

    const events = await readLog(res.logPath);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'run_started',
      'step_start',
      'step_ok',
      'run_completed',
    ]);
    const okEvent = events.find((e) => e.kind === 'step_ok');
    expect(okEvent && 'stub' in okEvent ? okEvent.stub : undefined).toBeFalsy();
  });

  it('stub handlers for search/graph/export emit stub:true', async () => {
    const recipe = parseRecipe(`
name: stubs
version: 1
steps:
  - id: s1
    kind: search
    with: { q: foo }
  - id: s2
    kind: graph
    with: { algo: louvain }
  - id: s3
    kind: export
    with: { format: pdf }
`);
    const runner = new RecipeRunner({
      registry: fakeRegistry('unused'),
      workspaceRoot: tmpRoot,
    });
    const res = await runner.run(recipe, {});
    expect(res.ok).toBe(true);
    const events = await readLog(res.logPath);
    const okEvents = events.filter((e) => e.kind === 'step_ok');
    expect(okEvents).toHaveLength(3);
    for (const e of okEvents) {
      expect('stub' in e && e.stub).toBe(true);
    }
  });

  it('fails fast with no auto-retry on step error', async () => {
    const recipe = parseRecipe(`
name: bad
version: 1
steps:
  - id: boom
    kind: brainstorm
    with: {}
`);
    const runner = new RecipeRunner({
      registry: fakeRegistry('x'),
      workspaceRoot: tmpRoot,
    });
    const res = await runner.run(recipe, {});
    expect(res.ok).toBe(false);
    expect(res.failedStep?.stepId).toBe('boom');
    const events = await readLog(res.logPath);
    expect(events.some((e) => e.kind === 'step_failed')).toBe(true);
    expect(events.some((e) => e.kind === 'run_failed')).toBe(true);
  });

  it('rejects input validation violations before running any step', async () => {
    const recipe = parseRecipe(`
name: needs-input
version: 1
inputs:
  collection:
    type: string
    required: true
steps:
  - id: s
    kind: search
    with: {}
`);
    const runner = new RecipeRunner({
      registry: fakeRegistry('x'),
      workspaceRoot: tmpRoot,
    });
    const res = await runner.run(recipe, {});
    expect(res.ok).toBe(false);
    const events = await readLog(res.logPath);
    expect(events.map((e) => e.kind)).toEqual([
      'run_started',
      'run_failed',
    ]);
    const fail = events[1] as Extract<RunEvent, { kind: 'run_failed' }>;
    expect(fail.error.code).toBe('input_validation');
  });

  it('renders object outputs with a `markdown` field via {{ stepId }}', async () => {
    let capturedPrompt = '';
    const recipe = parseRecipe(`
name: md-render
version: 1
steps:
  - id: lookup
    kind: search
    with: { q: unused }
  - id: think
    kind: brainstorm
    with: { prompt: "items: {{ lookup }}" }
`);
    const registry = {
      getLLM: () => ({
        id: 'f',
        name: 'f',
        capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
        getStatus: () => ({ state: 'ready' as const }),
        healthCheck: async () => ({ state: 'ready' as const }),
        chat: async function* () {
          yield { delta: '', done: true, finishReason: 'stop' as const };
        },
        complete: async (prompt: string) => {
          capturedPrompt = prompt;
          return 'OK';
        },
        dispose: async () => undefined,
      }),
    } as unknown as ProviderRegistry;

    const runner = new RecipeRunner({
      registry,
      workspaceRoot: tmpRoot,
      stepHandlers: {
        search: async () => ({
          output: { markdown: 'rendered', other: 'data' },
        }),
      },
    });
    const res = await runner.run(recipe, {});
    expect(res.ok).toBe(true);
    expect(capturedPrompt).toContain('items: rendered');
    expect(capturedPrompt).not.toContain('[object Object]');
  });

  it('interpolates prior step outputs into later prompts', async () => {
    let capturedPrompt = '';
    const recipe = parseRecipe(`
name: chain
version: 1
steps:
  - id: first
    kind: brainstorm
    with: { prompt: "first" }
  - id: second
    kind: write
    with: { prompt: "using: {{ first }}" }
`);
    const registry = {
      getLLM: () => ({
        id: 'f',
        name: 'f',
        capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
        getStatus: () => ({ state: 'ready' as const }),
        healthCheck: async () => ({ state: 'ready' as const }),
        chat: async function* () {
          yield { delta: '', done: true, finishReason: 'stop' as const };
        },
        complete: async (prompt: string) => {
          capturedPrompt = prompt;
          return capturedPrompt.includes('using:') ? 'FINAL' : 'FIRST_OUT';
        },
        dispose: async () => undefined,
      }),
    } as unknown as ProviderRegistry;

    const runner = new RecipeRunner({ registry, workspaceRoot: tmpRoot });
    const res = await runner.run(recipe, {});
    expect(res.ok).toBe(true);
    expect(capturedPrompt).toContain('using: FIRST_OUT');
    expect(res.outputs.second).toBe('FINAL');
  });
});
