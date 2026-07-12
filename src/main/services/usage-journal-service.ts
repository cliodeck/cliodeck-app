/**
 * Journal d'usage IA — service singleton (main process).
 *
 * Instrument réflexif (PAS de télémétrie), strictement séparé du *journal de
 * recherche* (`historyService`). Voir `docs/journal-usage-ia-reperage.md`.
 *
 * Responsabilités :
 *   - ouvrir/fermer `.cliodeck/journal.db` sur load/close du projet ;
 *   - enrichir chaque événement factuel avec le contexte ambiant (mode, workspace,
 *     corpus, recipe) et l'id de session (heuristique de fenêtre d'inactivité) ;
 *   - écrire de façon **non bloquante** (buffer + flush débouncé) — une panne du
 *     journal ne doit JAMAIS faire échouer un appel LLM ;
 *   - servir de sink pour les scopes d'indexation en masse (`embedding_batch`).
 *
 * Le hook providers (décorateur du registre) appelle `record(...)` en fire-and-forget.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { workspaceFiles } from '../../../backend/core/workspace/layout.js';
import { UsageJournalStore } from '../../../backend/core/usage-journal/UsageJournalStore.js';
import {
  getJournalContext,
  setBatchSink,
  type BatchAccumulator,
  type JournalContext,
} from '../../../backend/core/usage-journal/context.js';
import type {
  InferenceEvent,
  RecordInferenceInput,
  UsageMode,
} from '../../../backend/core/usage-journal/types.js';

/** Providers exécutés localement (le reste = cloud). */
const LOCAL_PROVIDERS = new Set(['ollama']);

const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000; // §7 : fenêtre par défaut 30 min
const FLUSH_INTERVAL_MS = 750;

interface SessionState {
  id: string;
  workspace: string;
  lastAtMs: number;
}

class UsageJournalService {
  private store: UsageJournalStore | null = null;
  private workspaceRoot: string | null = null;
  private activeMode: UsageMode = 'unknown';
  private inactivityMs = DEFAULT_INACTIVITY_MS;

  private session: SessionState | null = null;
  private buffer: InferenceEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  init(projectRoot: string): void {
    this.close();
    try {
      const dbPath = path.join(workspaceFiles(projectRoot).root, 'journal.db');
      this.store = new UsageJournalStore(dbPath);
      this.workspaceRoot = projectRoot;
      this.session = null;
      setBatchSink((acc, ctx) => this.recordBatch(acc, ctx));
      console.log('🧾 Usage journal initialized:', dbPath);
    } catch (err) {
      // Best-effort : l'app fonctionne sans journal.
      console.warn('🧾 Usage journal init failed (continuing without it):', err);
      this.store = null;
    }
  }

  close(): void {
    setBatchSink(undefined);
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.store) {
      try {
        this.store.close();
      } catch (err) {
        console.warn('🧾 Usage journal close error:', err);
      }
    }
    this.store = null;
    this.workspaceRoot = null;
    this.session = null;
    this.buffer = [];
  }

  /** Miroir du mode applicatif (poussé par le renderer sur changement de workspace-mode). */
  setActiveMode(mode: UsageMode): void {
    this.activeMode = mode;
  }

  /** Fenêtre d'inactivité de découpage des sessions (configurable, §7). */
  setInactivityWindowMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.inactivityMs = ms;
  }

  getStore(): UsageJournalStore | null {
    return this.store;
  }

  /**
   * Enregistre un événement factuel. Fire-and-forget : n'attend pas l'écriture et
   * n'échoue jamais l'appelant.
   */
  record(input: RecordInferenceInput): void {
    if (!this.store) return;
    try {
      const ctx = getJournalContext();
      const event = this.enrich(input, ctx);
      this.buffer.push(event);
      this.scheduleFlush();
    } catch (err) {
      console.warn('🧾 Usage journal record error (ignored):', err);
    }
  }

  /** Sink des scopes d'indexation en masse : un seul `embedding_batch` par scope. */
  private recordBatch(acc: BatchAccumulator, ctx: JournalContext): void {
    this.record({
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
    });
  }

  private enrich(
    input: RecordInferenceInput,
    ctx: JournalContext | undefined
  ): InferenceEvent {
    const nowMs = Date.now();
    const workspace =
      input.workspaceRoot ?? ctx?.workspaceRoot ?? this.workspaceRoot ?? '';
    const mode: UsageMode = input.mode ?? ctx?.mode ?? this.activeMode;
    const sessionId = this.resolveSession(workspace, nowMs);

    return {
      id: randomUUID(),
      sessionId,
      at: new Date(nowMs).toISOString(),
      durationMs: input.durationMs,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      isLocal: LOCAL_PROVIDERS.has(input.provider),
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      tokensEstimated: input.tokensEstimated,
      chunkCount: input.chunkCount,
      mode,
      workspace,
      corpus: input.corpus ?? ctx?.corpus,
      recipeId: input.recipeId ?? ctx?.recipeId,
      status: input.status,
      ref: input.ref,
    };
  }

  /**
   * Découpage en sessions (§7, purement cosmétique) : même session si même workspace
   * ET écart < fenêtre d'inactivité ; sinon nouvelle session. Le changement de mode
   * ne découpe pas.
   */
  private resolveSession(workspace: string, nowMs: number): string {
    const s = this.session;
    if (s && s.workspace === workspace && nowMs - s.lastAtMs <= this.inactivityMs) {
      s.lastAtMs = nowMs;
      return s.id;
    }
    const fresh: SessionState = { id: randomUUID(), workspace, lastAtMs: nowMs };
    this.session = fresh;
    return fresh.id;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    // Ne pas retenir le process pour un flush en attente.
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!this.store || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.store.insertEvents(batch);
    } catch (err) {
      console.warn('🧾 Usage journal flush error (events dropped):', err);
    }
  }
}

export const usageJournalService = new UsageJournalService();
