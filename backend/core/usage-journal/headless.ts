/**
 * Journal d'usage IA — sink headless (CLI, hors Electron).
 *
 * Équivalent minimal de `usage-journal-service.ts` pour les process courts :
 * une session unique par process (pas de fenêtre d'inactivité), écriture
 * synchrone (better-sqlite3 est sync et les volumes CLI sont minuscules — pas
 * de buffer débouncé à flusher avant `process.exit`). Best-effort comme le
 * service : une panne du journal ne fait jamais échouer la commande.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { workspaceFiles } from '../workspace/layout.js';
import { UsageJournalStore } from './UsageJournalStore.js';
import {
  getJournalContext,
  setBatchSink,
  setInferenceSink,
  type JournalContext,
} from './context.js';
import { isLocalProvider } from './is-local.js';
import type { InferenceEvent, RecordInferenceInput, UsageMode } from './types.js';

export interface HeadlessJournal {
  close(): void;
}

/**
 * Ouvre `.cliodeck/journal.db` du workspace et enregistre les sinks du
 * décorateur providers. Retourne `null` (et continue sans journal) si la base
 * ne peut pas s'ouvrir. L'appelant doit poser le contexte (`mode: 'cli'`) via
 * `runWithJournalContext` et appeler `close()` en fin de commande.
 */
export function initHeadlessJournal(workspaceRoot: string): HeadlessJournal | null {
  let store: UsageJournalStore;
  try {
    const dbPath = path.join(workspaceFiles(workspaceRoot).root, 'journal.db');
    store = new UsageJournalStore(dbPath);
  } catch (err) {
    process.stderr.write(
      `[journal] init failed, continuing without it: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  const sessionId = randomUUID();

  const enrich = (
    input: RecordInferenceInput,
    ctx: JournalContext | undefined
  ): InferenceEvent => {
    const nowMs = Date.now();
    const mode: UsageMode = input.mode ?? ctx?.mode ?? 'cli';
    return {
      id: randomUUID(),
      sessionId,
      at: new Date(nowMs).toISOString(),
      durationMs: input.durationMs,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      isLocal: input.isLocal ?? isLocalProvider(input.provider),
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      tokensEstimated: input.tokensEstimated,
      chunkCount: input.chunkCount,
      mode,
      workspace: input.workspaceRoot ?? ctx?.workspaceRoot ?? workspaceRoot,
      corpus: input.corpus ?? ctx?.corpus,
      recipeId: input.recipeId ?? ctx?.recipeId,
      status: input.status,
      ref: input.ref,
    };
  };

  setInferenceSink((input) => {
    try {
      store.insertEvents([enrich(input, getJournalContext())]);
    } catch {
      // Best-effort : la journalisation n'échoue jamais l'appelant.
    }
  });

  setBatchSink((acc, ctx) => {
    try {
      store.insertEvents([
        enrich(
          {
            kind: 'embedding_batch',
            provider: acc.provider ?? 'unknown',
            model: acc.model ?? 'unknown',
            durationMs: Math.max(0, Date.now() - acc.startedAt),
            totalTokens: acc.totalTokens,
            tokensEstimated: acc.tokensEstimated,
            chunkCount: acc.chunkCount,
            status: acc.anyError ? 'error' : 'ok',
            corpus: ctx.corpus ?? acc.corpus,
            recipeId: ctx.recipeId,
            workspaceRoot: ctx.workspaceRoot,
            mode: ctx.mode,
            isLocal: acc.isLocal,
          },
          ctx
        ),
      ]);
    } catch {
      // Best-effort.
    }
  });

  return {
    close(): void {
      setInferenceSink(undefined);
      setBatchSink(undefined);
      try {
        store.close();
      } catch {
        // Best-effort.
      }
    },
  };
}
