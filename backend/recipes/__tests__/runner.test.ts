import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RecipeRunner, recipeCallsLLM, type RunEvent } from '../runner.js';
import { parseRecipe } from '../schema.js';
import type { ProviderRegistry } from '../../core/llm/providers/registry.js';
import type { LLMProvider, ChatChunk } from '../../core/llm/providers/base.js';

function fakeLLM(canned: string): LLMProvider {
  return {
    id: 'fake',
    name: 'fake',
    model: 'fake-model',
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

describe('interpolation des paramètres `with` (finitions post-CM6)', () => {
  it('résout {{ inputs.x }} dans les with des steps non-LLM avant le handler', async () => {
    const recipe = parseRecipe(`
name: export-doc
version: 0.1.0
inputs:
  document_id:
    type: string
    required: true
steps:
  - id: render
    kind: export
    with:
      document_id: "{{ inputs.document_id }}"
      format: pdf
`);
    let received: Record<string, unknown> | null = null;
    const runner = new RecipeRunner({
      registry: fakeRegistry('unused'),
      workspaceRoot: tmpRoot,
      stepHandlers: {
        export: async (step) => {
          received = step.with;
          return { output: { ok: true } };
        },
      },
    });
    const res = await runner.run(recipe, { document_id: 'chapitres/ch-03.md' });
    expect(res.ok).toBe(true);
    expect(received).not.toBeNull();
    expect(received!.document_id).toBe('chapitres/ch-03.md');
    expect(received!.format).toBe('pdf'); // les valeurs sans gabarit passent telles quelles
  });

  it("n'interpole PAS with.prompt dans le runner (llmHandler s'en charge, une seule passe)", async () => {
    const recipe = parseRecipe(`
name: prompt-passthrough
version: 0.1.0
inputs:
  sujet:
    type: string
    required: true
steps:
  - id: think
    kind: brainstorm
    with:
      prompt: "parle de {{ inputs.sujet }}"
`);
    let seenPrompt = '';
    const runner = new RecipeRunner({
      registry: fakeRegistry('ok'),
      workspaceRoot: tmpRoot,
      stepHandlers: {
        brainstorm: async (step) => {
          seenPrompt = String(step.with.prompt);
          return { output: 'ok' };
        },
      },
    });
    const res = await runner.run(recipe, { sujet: 'Danzig' });
    expect(res.ok).toBe(true);
    // Le gabarit arrive intact au handler : c'est llmHandler qui interpole,
    // et une double passe substituerait des {{ }} venus d'une sortie de step.
    expect(seenPrompt).toBe('parle de {{ inputs.sujet }}');
  });
});

describe('recipeCallsLLM — décide du consentement distant', () => {
  it('repère les étapes brainstorm et write', () => {
    expect(recipeCallsLLM({ steps: [{ id: 'a', kind: 'search', with: {} }, { id: 'b', kind: 'write', with: {} }] })).toBe(true);
    expect(recipeCallsLLM({ steps: [{ id: 'a', kind: 'brainstorm', with: {} }] })).toBe(true);
  });

  it('ne signale rien pour une recette de recherche et d’export', () => {
    expect(recipeCallsLLM({ steps: [{ id: 'a', kind: 'search', with: {} }, { id: 'b', kind: 'export', with: {} }] })).toBe(false);
  });

  it('couvre toutes les recettes intégrées qui contiennent une étape LLM', async () => {
    const dir = path.join(process.cwd(), 'backend', 'recipes', 'builtin');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.yaml'));
    for (const f of files) {
      const recipe = parseRecipe(await fs.readFile(path.join(dir, f), 'utf8'));
      const hasLLMStep = recipe.steps.some((s) => s.kind === 'brainstorm' || s.kind === 'write');
      expect(recipeCallsLLM(recipe), f).toBe(hasLLMStep);
    }
  });
});

/**
 * Fermer la fenêtre d'une recette l'annule (D20). Annuler, c'est : l'étape en cours ne
 * compte plus, aucune suivante ne démarre, et la passe se dit `cancelled`, jamais
 * `succeeded` ni `failed`. Une étape qui ignore le signal ne retient pas la passe.
 */
describe('annulation d’une passe (D20)', () => {
  const twoSteps = parseRecipe(`
name: longue
version: 1
steps:
  - id: lente
    kind: search
    with: {}
  - id: suivante
    kind: graph
    with: {}
`);

  async function runFiles(): Promise<string[]> {
    return fs.readdir(path.join(tmpRoot, '.cliodeck', 'recipes-runs')).catch(() => []);
  }

  it('une étape qui pend et ignore le signal : la passe se termine en cancelled, la suivante ne démarre pas', async () => {
    const next = vi.fn(async () => ({ output: 'ne doit pas tourner' }));
    let started: () => void = () => undefined;
    const stepStarted = new Promise<void>((resolve) => (started = resolve));
    const runner = new RecipeRunner({
      registry: fakeRegistry('x'),
      workspaceRoot: tmpRoot,
      stepHandlers: {
        search: () => {
          started();
          return new Promise(() => undefined);
        },
        graph: next,
      },
    });
    const controller = new AbortController();

    const running = runner.run(twoSteps, {}, controller.signal);
    await stepStarted;
    controller.abort();
    const res = await running;

    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(res.failedStep).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    const kinds = (await readLog(res.logPath)).map((e) => e.kind);
    expect(kinds).toEqual(['run_started', 'step_start', 'run_cancelled']);
  });

  it('un modèle interrompu qui rend une réponse partielle sans lever : ni succès, ni étape suivante', async () => {
    // Le fournisseur Ollama finit sur `finishReason: 'cancelled'` et `complete` rend ce qu'il a :
    // sans regard au signal, la passe continuait avec une réponse vide.
    const next = vi.fn(async () => ({ output: 'ne doit pas tourner' }));
    const controller = new AbortController();
    const llm: LLMProvider = {
      ...fakeLLM('x'),
      complete: (_prompt, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve(''));
          controller.abort();
        }),
    };
    const recipe = parseRecipe(`
name: modele
version: 1
steps:
  - id: pense
    kind: brainstorm
    with:
      prompt: "dis"
  - id: suivante
    kind: graph
    with: {}
`);
    const runner = new RecipeRunner({
      registry: { getLLM: () => llm } as unknown as ProviderRegistry,
      workspaceRoot: tmpRoot,
      stepHandlers: { graph: next },
    });

    const res = await runner.run(recipe, {}, controller.signal);

    expect(res.cancelled).toBe(true);
    expect(res.ok).toBe(false);
    expect(next).not.toHaveBeenCalled();
    const kinds = (await readLog(res.logPath)).map((e) => e.kind);
    expect(kinds).not.toContain('step_ok');
    expect(kinds).not.toContain('run_failed');
    expect(kinds.at(-1)).toBe('run_cancelled');
  });

  it('une étape qui lève parce qu’on l’a interrompue : cancelled, pas failed', async () => {
    const controller = new AbortController();
    const runner = new RecipeRunner({
      registry: fakeRegistry('x'),
      workspaceRoot: tmpRoot,
      stepHandlers: {
        search: async (_step, ctx) => {
          controller.abort();
          ctx.signal?.throwIfAborted();
          return { output: 'jamais' };
        },
      },
    });

    const res = await runner.run(twoSteps, {}, controller.signal);

    expect(res.cancelled).toBe(true);
    expect(res.failedStep).toBeUndefined();
    const kinds = (await readLog(res.logPath)).map((e) => e.kind);
    expect(kinds).not.toContain('step_failed');
    expect(kinds.at(-1)).toBe('run_cancelled');
  });

  it('une étape qui rend son résultat après l’annulation : rien n’est écrit', async () => {
    let finish: (value: { output: unknown }) => void = () => undefined;
    let started: () => void = () => undefined;
    const stepStarted = new Promise<void>((resolve) => (started = resolve));
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const running = new RecipeRunner({
      registry: fakeRegistry('x'),
      workspaceRoot: tmpRoot,
      stepHandlers: {
        search: () =>
          new Promise((resolve) => {
            finish = resolve;
            started();
          }),
      },
      onEvent: (e) => events.push(e),
    }).run(twoSteps, {}, controller.signal);
    await stepStarted;
    controller.abort();
    const res = await running;
    const logBefore = await fs.readFile(res.logPath, 'utf8');
    const eventsBefore = events.length;

    finish({ output: 'arrivé trop tard' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(res.outputs).toEqual({});
    expect(events).toHaveLength(eventsBefore);
    expect(await fs.readFile(res.logPath, 'utf8')).toBe(logBefore);
    expect(await runFiles()).toEqual([path.basename(res.logPath)]);
  });

  it('un signal déjà levé : aucune étape ne démarre', async () => {
    const lente = vi.fn(async () => ({ output: 'x' }));
    const runner = new RecipeRunner({
      registry: fakeRegistry('x'),
      workspaceRoot: tmpRoot,
      stepHandlers: { search: lente },
    });
    const controller = new AbortController();
    controller.abort();

    const res = await runner.run(twoSteps, {}, controller.signal);

    expect(res.cancelled).toBe(true);
    expect(lente).not.toHaveBeenCalled();
  });
});
