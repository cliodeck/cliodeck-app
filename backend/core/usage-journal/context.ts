/**
 * Contexte ambiant du journal d'usage IA (main process).
 *
 * Le hook providers (décorateur du registre) ne connaît que provider/modèle/tokens.
 * Le contexte applicatif (mode, workspace, corpus, recipe) et l'agrégation des
 * indexations en masse (`embedding_batch`) transitent par cet `AsyncLocalStorage` :
 * chaque point d'émission (handler IPC, runner de recipes, commande CLI, appel MCP)
 * ouvre un scope, le décorateur lit le contexte courant au moment d'émettre.
 *
 * Ce module est volontairement sans dépendance (pas d'Electron, pas de SQLite) :
 * l'écriture réelle vit dans `usage-journal-service.ts`, qui s'enregistre comme sink.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BatchCorpus, UsageMode } from './types.js';

/**
 * Accumulateur d'un scope d'indexation en masse. Tant qu'il est présent dans le
 * contexte, le décorateur accumule au lieu d'émettre un événement par chunk ; un
 * seul `embedding_batch` est flush à la fermeture du scope.
 */
export interface BatchAccumulator {
  corpus: BatchCorpus;
  provider?: string;
  model?: string;
  chunkCount: number;
  totalTokens: number;
  tokensEstimated: boolean;
  startedAt: number;
  anyError: boolean;
}

export interface JournalContext {
  mode?: UsageMode;
  workspaceRoot?: string;
  corpus?: string;
  recipeId?: string;
  /** Présent uniquement à l'intérieur d'un `runBatch`. */
  batch?: BatchAccumulator;
}

const storage = new AsyncLocalStorage<JournalContext>();

/** Contexte courant (objet mutable) ou `undefined` hors de tout scope. */
export function getJournalContext(): JournalContext | undefined {
  return storage.getStore();
}

/**
 * Exécute `fn` avec un contexte journal. L'objet est mutable pour permettre à du
 * code imbriqué de préciser `corpus`/`recipeId` sans ré-ouvrir un scope.
 */
export function runWithJournalContext<T>(ctx: JournalContext, fn: () => T): T {
  // Fusionne avec un éventuel contexte parent (le scope enfant hérite du mode/workspace).
  const parent = storage.getStore();
  const merged: JournalContext = { ...parent, ...ctx };
  return storage.run(merged, fn);
}

/** Modifie le contexte courant en place (no-op hors scope). */
export function patchJournalContext(patch: Partial<JournalContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, patch);
}

/**
 * Sink appelé à la fermeture d'un scope de batch avec l'accumulateur final. Enregistré
 * par le service ; laissé à `undefined` si le journal n'est pas initialisé (l'app
 * doit fonctionner sans journal — la capture est best-effort).
 */
type BatchSink = (acc: BatchAccumulator, ctx: JournalContext) => void;
let batchSink: BatchSink | undefined;

export function setBatchSink(sink: BatchSink | undefined): void {
  batchSink = sink;
}

/**
 * Ouvre un scope d'indexation en masse pour `corpus`. Le décorateur accumule dans
 * l'accumulateur au lieu d'émettre par chunk ; à la fin, l'accumulateur est flush
 * vers le sink (un seul `embedding_batch`). Best-effort : n'échoue jamais l'appelant.
 */
export async function runBatch<T>(
  corpus: BatchCorpus,
  fn: () => Promise<T>
): Promise<T> {
  const acc: BatchAccumulator = {
    corpus,
    chunkCount: 0,
    totalTokens: 0,
    tokensEstimated: true,
    startedAt: nowMs(),
    anyError: false,
  };
  const ctx: JournalContext = { corpus, batch: acc };
  try {
    return await runWithJournalContext(ctx, fn);
  } catch (err) {
    acc.anyError = true;
    throw err;
  } finally {
    try {
      if (batchSink && acc.chunkCount > 0) {
        batchSink(acc, storage.getStore() ?? ctx);
      }
    } catch {
      // La journalisation ne doit jamais faire échouer l'indexation.
    }
  }
}

/**
 * Horloge indirecte : `Date.now()` est banni dans certains harness de replay ;
 * ici on est en runtime Electron/Node normal, mais on centralise pour testabilité.
 */
function nowMs(): number {
  return Date.now();
}
