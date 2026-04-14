/**
 * ClioRecipes runner (fusion step 4.3.2).
 *
 * Executes a Recipe's steps sequentially. The run log is a stream of typed
 * events (claw-code lesson 6.2 — *events over scraped prose*) persisted as
 * JSONL to `.cliodeck/v2/recipes-runs/<iso>-<name>.jsonl`, so dashboards,
 * tests, and recipe debugging consumers can reason over structured data.
 *
 * Step failures never trigger automatic retry (claw-code lesson 6.4 —
 * "auto-recovery : infra oui, contenu non"). Recipes mutate user content;
 * silently re-running a failed export or write would be dangerous.
 *
 * Unknown step kinds are not accepted — they're rejected at parse time by
 * the zod `StepKind` enum. Kinds whose real handler lives in a later phase
 * (search, graph, export) are serviced by a stub handler that logs params
 * and returns a placeholder output. Replace per-handler as the owning
 * phases land; no runner change needed.
 */

import fs from 'fs/promises';
import path from 'path';
import type { ProviderRegistry } from '../core/llm/providers/registry.js';
import { v2Paths, ensureV2Directories } from '../core/workspace/layout.js';
import { validateInputs, type Recipe, type StepKind } from './schema.js';

export type RunEvent =
  | { kind: 'run_started'; at: string; recipe: string; inputs: Record<string, unknown> }
  | { kind: 'step_start'; at: string; stepId: string; stepKind: StepKind }
  | {
      kind: 'step_ok';
      at: string;
      stepId: string;
      stepKind: StepKind;
      output: unknown;
      /** True when the step ran via the default stub handler (handler TBD). */
      stub?: boolean;
    }
  | {
      kind: 'step_failed';
      at: string;
      stepId: string;
      stepKind: StepKind;
      error: { code: string; message: string };
    }
  | {
      kind: 'run_completed';
      at: string;
      recipe: string;
      outputs: Record<string, unknown>;
    }
  | {
      kind: 'run_failed';
      at: string;
      recipe: string;
      error: { code: string; message: string };
    };

export interface StepContext {
  recipe: Recipe;
  inputs: Record<string, unknown>;
  /** Outputs of previously-executed steps, keyed by step id. */
  priorOutputs: Record<string, unknown>;
  registry: ProviderRegistry;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface StepResult {
  output: unknown;
  stub?: boolean;
}

export type StepHandler = (
  step: Recipe['steps'][number],
  ctx: StepContext
) => Promise<StepResult>;

export interface RunResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  logPath: string;
  failedStep?: { stepId: string; message: string };
}

export interface RunnerOptions {
  registry: ProviderRegistry;
  workspaceRoot: string;
  stepHandlers?: Partial<Record<StepKind, StepHandler>>;
  /** Invoked for every RunEvent as it is emitted (for UI streaming). */
  onEvent?: (event: RunEvent) => void;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * `{{ stepId.output }}` / `{{ inputs.name }}` substitution.
 * Deliberately minimalist — if recipes grow more expressive, swap in a real
 * template engine (handlebars, nunjucks) behind the same function signature.
 */
function interpolate(
  template: string,
  ctx: { priorOutputs: Record<string, unknown>; inputs: Record<string, unknown> }
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const parts = expr.split('.').map((p) => p.trim());
    if (parts[0] === 'inputs' && parts.length === 2) {
      const v = ctx.inputs[parts[1]];
      return v == null ? '' : String(v);
    }
    const scope = ctx.priorOutputs[parts[0]];
    if (scope == null) return '';
    if (parts.length === 1) return String(scope);
    if (typeof scope === 'object' && scope !== null) {
      const v = (scope as Record<string, unknown>)[parts[1]];
      return v == null ? '' : String(v);
    }
    return '';
  });
}

// MARK: - default handlers

function llmHandler(roleHint: 'brainstorm' | 'write'): StepHandler {
  return async (step, ctx) => {
    const promptTemplate = String(step.with.prompt ?? '');
    if (!promptTemplate) {
      throw new Error(
        `Step "${step.id}" (${step.kind}): missing "with.prompt"`
      );
    }
    const prompt = interpolate(promptTemplate, ctx);
    const llm = ctx.registry.getLLM();
    const sysPrefix =
      roleHint === 'brainstorm'
        ? '[Mode Brainstorm — libre association, pistes de recherche]\n'
        : '[Mode Write — prose académique publiable, voix historienne]\n';
    const out = await llm.complete(sysPrefix + prompt, {
      maxTokens:
        typeof step.with.maxTokens === 'number'
          ? step.with.maxTokens
          : undefined,
      temperature:
        typeof step.with.temperature === 'number'
          ? step.with.temperature
          : undefined,
      signal: ctx.signal,
    });
    return { output: out };
  };
}

const stubHandler: StepHandler = async (step) => {
  return {
    output: { stub: true, kind: step.kind, params: step.with },
    stub: true,
  };
};

const defaultHandlers: Record<StepKind, StepHandler> = {
  brainstorm: llmHandler('brainstorm'),
  write: llmHandler('write'),
  search: stubHandler,
  graph: stubHandler,
  export: stubHandler,
};

// MARK: - Runner

export class RecipeRunner {
  private readonly registry: ProviderRegistry;
  private readonly workspaceRoot: string;
  private readonly handlers: Record<StepKind, StepHandler>;
  private readonly onEvent?: (event: RunEvent) => void;

  constructor(opts: RunnerOptions) {
    this.registry = opts.registry;
    this.workspaceRoot = opts.workspaceRoot;
    this.handlers = { ...defaultHandlers, ...opts.stepHandlers };
    this.onEvent = opts.onEvent;
  }

  async run(
    recipe: Recipe,
    inputs: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<RunResult> {
    const violations = validateInputs(recipe, inputs);
    const paths = v2Paths(this.workspaceRoot);
    await ensureV2Directories(this.workspaceRoot);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = recipe.name.replace(/[^\w.-]/g, '_');
    const logPath = path.join(paths.recipesRunsDir, `${stamp}-${safeName}.jsonl`);
    const events: RunEvent[] = [];

    const emit = (e: RunEvent): void => {
      events.push(e);
      try {
        this.onEvent?.(e);
      } catch {
        // Subscriber threw — ignore to avoid breaking the run.
      }
    };

    emit({ kind: 'run_started', at: now(), recipe: recipe.name, inputs });

    if (violations.length) {
      emit({
        kind: 'run_failed',
        at: now(),
        recipe: recipe.name,
        error: { code: 'input_validation', message: violations.join('; ') },
      });
      await this.flush(logPath, events);
      return {
        ok: false,
        outputs: {},
        logPath,
        failedStep: { stepId: '(input_validation)', message: violations.join('; ') },
      };
    }

    const priorOutputs: Record<string, unknown> = {};

    for (const step of recipe.steps) {
      emit({ kind: 'step_start', at: now(), stepId: step.id, stepKind: step.kind });
      const handler = this.handlers[step.kind];
      try {
        const { output, stub } = await handler(step, {
          recipe,
          inputs,
          priorOutputs,
          registry: this.registry,
          workspaceRoot: this.workspaceRoot,
          signal,
        });
        priorOutputs[step.id] = output;
        emit({
          kind: 'step_ok',
          at: now(),
          stepId: step.id,
          stepKind: step.kind,
          output,
          stub,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({
          kind: 'step_failed',
          at: now(),
          stepId: step.id,
          stepKind: step.kind,
          error: { code: 'step_error', message: msg },
        });
        emit({
          kind: 'run_failed',
          at: now(),
          recipe: recipe.name,
          error: { code: 'step_error', message: `Step ${step.id}: ${msg}` },
        });
        await this.flush(logPath, events);
        return {
          ok: false,
          outputs: priorOutputs,
          logPath,
          failedStep: { stepId: step.id, message: msg },
        };
      }
    }

    emit({
      kind: 'run_completed',
      at: now(),
      recipe: recipe.name,
      outputs: priorOutputs,
    });
    await this.flush(logPath, events);
    return { ok: true, outputs: priorOutputs, logPath };
  }

  private async flush(logPath: string, events: RunEvent[]): Promise<void> {
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(logPath, body, 'utf8');
  }
}
