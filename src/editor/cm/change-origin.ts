import { Annotation, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Origine des transactions (plan CM6, Phase 4a).
 *
 * Toute transaction qui modifie le document porte une origine : la frappe
 * est dérivée des userEvents CM6, toute API programmatique de ClioDeck
 * DOIT poser son annotation. La garde de dev signale les oublis.
 */

export type ChangeOrigin =
  | 'human-input'
  | 'paste'
  | 'ai-proposal-accepted'
  | 'ai-proposal-modified'
  | 'programmatic';

export const changeOrigin = Annotation.define<ChangeOrigin>();

/** Origines qui représentent une édition de la main de l'utilisateur. */
export function isHumanOrigin(origin: ChangeOrigin | null): boolean {
  return origin === 'human-input' || origin === 'paste';
}

/**
 * Origine d'une transaction : annotation explicite, sinon dérivation des
 * userEvents standard de CM6. `null` = origine irrésoluble (bug à corriger,
 * signalé par la garde de dev).
 */
export function resolveOrigin(tr: Transaction): ChangeOrigin | null {
  const explicit = tr.annotation(changeOrigin);
  if (explicit) return explicit;
  if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) {
    return 'paste';
  }
  if (
    tr.isUserEvent('input') ||
    tr.isUserEvent('delete') ||
    tr.isUserEvent('move')
  ) {
    return 'human-input';
  }
  // Undo/redo rejouent l'historique de l'utilisateur.
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) {
    return 'human-input';
  }
  return null;
}

function isDevBuild(): boolean {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

const WARN_THROTTLE_MS = 2000;

/**
 * Garde de dev : warning (au plus un par rafale) quand une transaction
 * modifie le document sans origine résoluble. No-op en production.
 */
export function changeOriginGuard() {
  if (!isDevBuild()) return [];
  let lastWarn = 0;
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged || resolveOrigin(tr) !== null) continue;
      const now = Date.now();
      if (now - lastWarn > WARN_THROTTLE_MS) {
        lastWarn = now;
        console.warn(
          '[cliodeck] Transaction sans changeOrigin — toute API ' +
            'programmatique doit annoter ses éditions (plan CM6, Phase 4a).',
          tr
        );
      }
    }
  });
}
