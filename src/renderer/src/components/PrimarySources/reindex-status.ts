import type { TFunction } from 'i18next';
import type { TropyReindexStatus } from '@backend/types/tropy-reindex';

/**
 * Le message de la réindexation complète des sources primaires (H7), dans la
 * langue de l'interface : ce qui se passe, pourquoi, et ce que cela coûte.
 * `null` quand il n'y a rien à dire. Les nombres suivent la langue
 * (« 40 648 »).
 */
export function describeReindexStatus(
  t: TFunction,
  status: TropyReindexStatus,
  language: string
): string | null {
  const n = (value: number) => value.toLocaleString(language);
  switch (status.phase) {
    case 'idle':
      return null;
    case 'running': {
      const text = t('primarySources.reindexAll.running', {
        done: n(status.done),
        total: n(status.total),
        chunks: n(status.chunks),
      });
      return status.waitingForSync ? `${text} ${t('primarySources.reindexAll.waitingForSync')}` : text;
    }
    case 'stopped':
      // Des clés écrites en entier : le test des clés appelées les voit.
      return status.reason === 'no-embedding-provider'
        ? t('primarySources.reindexAll.stoppedNoProvider', { remaining: n(status.remaining) })
        : t('primarySources.reindexAll.stoppedFailed', { remaining: n(status.remaining) });
    case 'done':
      return t('primarySources.reindexAll.done', { total: n(status.total) });
  }
}
