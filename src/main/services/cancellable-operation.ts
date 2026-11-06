/**
 * Opérations annulables du processus principal (L08-3).
 *
 * RÈGLE : aucun nouveau bouton « Annuler » sans passer par `operations`. Un
 * bouton qui n'atteint pas une `CancellableOperation` n'annule rien, ou
 * annule la mauvaise passe.
 *
 * Le piège que ce registre ferme (S13-1-0, S12-1-17) : un champ
 * `this.abortController` partagé, que le `finally` d'un ancien run remet à
 * `null` alors qu'un nouveau run l'a déjà remplacé — l'annulation du nouveau
 * run ne trouve plus rien. D'où trois règles :
 *
 * 1. L'appelant garde son opération dans une variable locale ; jamais dans
 *    un champ remis à `null`.
 * 2. `finish()` ne retire que cette opération-là, jamais celle d'un autre
 *    run du même `kind`.
 * 3. `abort()` sans raison personnalisée : `signal.reason` reste une
 *    `AbortError`, sinon `fetch` rejette avec la raison fournie et les tests
 *    `error.name === 'AbortError'` des fournisseurs cassent. La cause se lit
 *    sur `op.cancelReason`.
 *
 * Le backend ne reçoit que `op.signal`, jamais l'opération. Une opération de
 * portée `project` s'abonne à son `signal` : la fermeture du projet passe par
 * `cancelScope('project', 'project-closed')` puis `drain('project', …)`.
 * Pas d'import Electron ici.
 */
import { randomUUID } from 'crypto';

export type CancelReason = 'user' | 'timeout' | 'superseded' | 'project-closed' | 'app-quit';
export type OperationScope = 'project' | 'app';
/**
 * Que faire quand une opération du même `kind` tourne déjà :
 * `parallel` les laisse cohabiter, `reject` refuse la nouvelle
 * (`OperationBusyError`), `supersede` annule l'ancienne (`superseded`).
 */
export type OperationConcurrency = 'parallel' | 'reject' | 'supersede';

export interface CancellableOperation {
  readonly runId: string;
  readonly kind: string;
  readonly scope: OperationScope;
  readonly signal: AbortSignal;
  readonly state: 'running' | 'cancelling' | 'finished';
  readonly cancelReason: CancelReason | null;
  /** Se résout au `finish()` : une annulation demandée n'est pas une fin. */
  readonly finished: Promise<void>;
  /** Faux si l'opération est déjà annulée ou finie. */
  cancel(reason?: CancelReason): boolean;
  /** Lève `OperationCancelledError` si l'opération a été annulée. */
  throwIfCancelled(): void;
  /** Idempotent ; ne retire que cette opération du registre. */
  finish(): void;
}

export class OperationBusyError extends Error {
  constructor(
    readonly kind: string,
    readonly runId: string
  ) {
    super(`Operation "${kind}" already running (${runId})`);
    this.name = 'OperationBusyError';
  }
}

export class OperationCancelledError extends Error {
  constructor(readonly reason: CancelReason) {
    super(`Operation cancelled (${reason})`);
    this.name = 'OperationCancelledError';
  }
}

class Operation implements CancellableOperation {
  readonly signal: AbortSignal;
  readonly finished: Promise<void>;
  state: 'running' | 'cancelling' | 'finished' = 'running';
  cancelReason: CancelReason | null = null;
  private readonly controller = new AbortController();
  private resolveFinished!: () => void;

  constructor(
    readonly runId: string,
    readonly kind: string,
    readonly scope: OperationScope,
    private readonly onFinish: (op: Operation) => void
  ) {
    this.signal = this.controller.signal;
    this.finished = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  cancel(reason: CancelReason = 'user'): boolean {
    if (this.state !== 'running') return false;
    this.state = 'cancelling';
    this.cancelReason = reason;
    // Sans raison : voir la règle 3 en tête du fichier.
    this.controller.abort();
    return true;
  }

  throwIfCancelled(): void {
    if (this.cancelReason) throw new OperationCancelledError(this.cancelReason);
  }

  finish(): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.onFinish(this);
    this.resolveFinished();
  }
}

export class OperationRegistry {
  private readonly ops = new Map<string, Operation>();

  begin(
    kind: string,
    opts: { runId?: string; scope?: OperationScope; concurrency?: OperationConcurrency } = {}
  ): CancellableOperation {
    const runId = opts.runId ?? randomUUID();
    const concurrency = opts.concurrency ?? 'parallel';
    const sameKind = this.active(kind);
    if (concurrency === 'reject' && sameKind.length > 0) {
      throw new OperationBusyError(kind, sameKind[0].runId);
    }
    if (concurrency === 'supersede') {
      for (const op of sameKind) op.cancel('superseded');
    }
    const existing = this.ops.get(runId);
    if (existing) throw new OperationBusyError(existing.kind, runId);
    const op = new Operation(runId, kind, opts.scope ?? 'project', (done) => {
      // Règle 2 : ne retirer que soi-même.
      if (this.ops.get(done.runId) === done) this.ops.delete(done.runId);
    });
    this.ops.set(runId, op);
    return op;
  }

  cancel(runId: string, reason?: CancelReason): boolean {
    return this.ops.get(runId)?.cancel(reason) ?? false;
  }

  cancelKind(kind: string, reason?: CancelReason): number {
    return this.active(kind).filter((op) => op.cancel(reason)).length;
  }

  cancelScope(scope: OperationScope, reason: CancelReason): number {
    return this.active()
      .filter((op) => op.scope === scope)
      .filter((op) => op.cancel(reason)).length;
  }

  find(runId: string): CancellableOperation | null {
    return this.ops.get(runId) ?? null;
  }

  /** Les opérations pas encore finies (en cours ou en cours d'annulation). */
  active(kind?: string): CancellableOperation[] {
    return [...this.ops.values()].filter((op) => kind === undefined || op.kind === kind);
  }

  /**
   * Attend la fin des opérations de `scope` en cours à l'appel. Vrai si
   * toutes ont fini dans `timeoutMs`, faux sinon — l'appelant décide alors
   * s'il passe outre.
   */
  async drain(scope: OperationScope, timeoutMs: number): Promise<boolean> {
    const pending = this.active().filter((op) => op.scope === scope);
    if (pending.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.all(pending.map((op) => op.finished)).then(() => true as const),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Le registre du processus principal. */
export const operations = new OperationRegistry();
