/**
 * Registre des opérations annulables (L08-3).
 *
 * Le piège visé est celui de S13-1-0 et S12-1-17 : un champ
 * `this.abortController` que le `finally` d'un ancien run remet à `null`
 * alors qu'un nouveau run l'a déjà remplacé — le bouton « Annuler » du
 * nouveau run n'annule plus rien.
 */
import { describe, expect, it } from 'vitest';
import {
  OperationBusyError,
  OperationCancelledError,
  OperationRegistry,
} from '../cancellable-operation.js';

describe('OperationRegistry', () => {
  it("finish() d'un ancien run n'efface pas le suivant du même kind", () => {
    const registry = new OperationRegistry();
    const first = registry.begin('slides', { concurrency: 'supersede' });
    const second = registry.begin('slides', { concurrency: 'supersede' });
    // Le `finally` de la première génération arrive après le début de la seconde.
    first.finish();
    expect(registry.active('slides')).toEqual([second]);
    expect(registry.find(second.runId)).toBe(second);
    expect(registry.cancel(second.runId)).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it('finish() est idempotent et ne retire que cette opération', () => {
    const registry = new OperationRegistry();
    const a = registry.begin('chat', { runId: 'a' });
    const b = registry.begin('chat', { runId: 'b' });
    a.finish();
    a.finish();
    expect(a.state).toBe('finished');
    expect(registry.active('chat').map((op) => op.runId)).toEqual(['b']);
    expect(b.state).toBe('running');
  });

  it('supersede annule le précédent avec la raison superseded', () => {
    const registry = new OperationRegistry();
    const first = registry.begin('similarity', { concurrency: 'supersede' });
    const second = registry.begin('similarity', { concurrency: 'supersede' });
    expect(first.signal.aborted).toBe(true);
    expect(first.cancelReason).toBe('superseded');
    expect(first.state).toBe('cancelling');
    expect(second.signal.aborted).toBe(false);
    expect(second.state).toBe('running');
  });

  it('reject lève OperationBusyError tant que la précédente tourne', () => {
    const registry = new OperationRegistry();
    const first = registry.begin('tropy-sync', { concurrency: 'reject' });
    let thrown: unknown;
    try {
      registry.begin('tropy-sync', { concurrency: 'reject' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OperationBusyError);
    expect((thrown as OperationBusyError).kind).toBe('tropy-sync');
    expect((thrown as OperationBusyError).runId).toBe(first.runId);
    // Une annulation en cours n'est pas une fin : l'opération écrit peut-être encore.
    first.cancel();
    expect(() => registry.begin('tropy-sync', { concurrency: 'reject' })).toThrow(OperationBusyError);
    first.finish();
    expect(registry.begin('tropy-sync', { concurrency: 'reject' }).state).toBe('running');
  });

  it('un runId déjà en cours est refusé', () => {
    const registry = new OperationRegistry();
    registry.begin('chat', { runId: 'session-1' });
    expect(() => registry.begin('chat', { runId: 'session-1' })).toThrow(OperationBusyError);
  });

  it('cancelScope ne touche que sa portée', () => {
    const registry = new OperationRegistry();
    const chat = registry.begin('chat', { scope: 'project' });
    const sync = registry.begin('tropy-sync', { scope: 'project' });
    const download = registry.begin('model-download', { scope: 'app' });
    expect(registry.cancelScope('project', 'project-closed')).toBe(2);
    expect(chat.cancelReason).toBe('project-closed');
    expect(sync.signal.aborted).toBe(true);
    expect(download.signal.aborted).toBe(false);
    expect(download.cancelReason).toBeNull();
    // Déjà annulées : un second appel ne compte plus rien.
    expect(registry.cancelScope('project', 'project-closed')).toBe(0);
  });

  it('cancelKind ne touche que son kind', () => {
    const registry = new OperationRegistry();
    const sync = registry.begin('tropy-sync');
    const chat = registry.begin('chat');
    expect(registry.cancelKind('tropy-sync')).toBe(1);
    expect(sync.cancelReason).toBe('user');
    expect(chat.signal.aborted).toBe(false);
  });

  it('signal.reason.name vaut toujours AbortError, quelle que soit la raison', () => {
    const registry = new OperationRegistry();
    for (const reason of ['user', 'timeout', 'superseded', 'project-closed', 'app-quit'] as const) {
      const op = registry.begin('chat');
      op.cancel(reason);
      expect((op.signal.reason as Error).name).toBe('AbortError');
      expect(op.cancelReason).toBe(reason);
      op.finish();
    }
  });

  it('cancel après finish rend false et ne touche pas le signal', () => {
    const registry = new OperationRegistry();
    const op = registry.begin('chat', { runId: 's' });
    op.finish();
    expect(op.cancel()).toBe(false);
    expect(registry.cancel('s')).toBe(false);
    expect(op.signal.aborted).toBe(false);
    expect(op.cancelReason).toBeNull();
  });

  it('un second cancel rend false et garde la première raison', () => {
    const registry = new OperationRegistry();
    const op = registry.begin('chat');
    expect(op.cancel('timeout')).toBe(true);
    expect(op.cancel('user')).toBe(false);
    expect(op.cancelReason).toBe('timeout');
  });

  it('throwIfCancelled lève OperationCancelledError avec la raison', () => {
    const registry = new OperationRegistry();
    const op = registry.begin('slides');
    expect(() => op.throwIfCancelled()).not.toThrow();
    op.cancel('superseded');
    let thrown: unknown;
    try {
      op.throwIfCancelled();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OperationCancelledError);
    expect((thrown as OperationCancelledError).reason).toBe('superseded');
  });

  it('finished se résout au finish()', async () => {
    const registry = new OperationRegistry();
    const op = registry.begin('chat');
    let resolved = false;
    void op.finished.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    op.finish();
    await op.finished;
    expect(resolved).toBe(true);
  });

  it('drain attend la fin des opérations de sa portée, pas des autres', async () => {
    const registry = new OperationRegistry();
    const chat = registry.begin('chat', { scope: 'project' });
    registry.begin('model-download', { scope: 'app' });
    registry.cancelScope('project', 'project-closed');
    const drained = registry.drain('project', 10_000);
    // Le pump rend la main un peu plus tard.
    setTimeout(() => chat.finish(), 5);
    await expect(drained).resolves.toBe(true);
  });

  it("drain rend false quand une opération ne finit pas dans le délai", async () => {
    const registry = new OperationRegistry();
    registry.begin('tropy-sync', { scope: 'project' });
    await expect(registry.drain('project', 5)).resolves.toBe(false);
  });

  it('drain sans opération se résout aussitôt', async () => {
    const registry = new OperationRegistry();
    await expect(registry.drain('project', 0)).resolves.toBe(true);
  });
});
