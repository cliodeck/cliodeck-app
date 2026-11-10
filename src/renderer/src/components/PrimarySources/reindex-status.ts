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
      // Toutes les sources refaites : reste la reconstruction finale de l'index
      // de recherche, une centaine de secondes sur 40 000 extraits. Plus rien
      // n'est « à refaire », et les anciens extraits n'existent plus.
      const text =
        status.done === status.total
          ? t('primarySources.reindexAll.finishing', { total: n(status.total) })
          : t('primarySources.reindexAll.running', {
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
    case 'rebuilding-index':
      return t('primarySources.reindexAll.rebuildingIndex', { missing: n(status.missing) });
    case 'index-rebuilt':
      return t('primarySources.reindexAll.indexRebuilt');
  }
}

/**
 * Le libellé court de la barre d'état, le message entier allant en infobulle.
 * `null` quand il n'y a rien à dire.
 */
export function reindexStatusLabel(t: TFunction, status: TropyReindexStatus): string | null {
  switch (status.phase) {
    case 'idle':
      return null;
    case 'running':
      return t('statusBar.tropyReindex', { done: status.done, total: status.total });
    case 'stopped':
      return t('statusBar.tropyReindexStopped');
    case 'done':
      return t('statusBar.tropyReindexDone');
    case 'rebuilding-index':
      return t('statusBar.tropyIndexRebuilding');
    case 'index-rebuilt':
      return t('statusBar.tropyIndexRebuilt');
  }
}
