import type { TFunction } from 'i18next';
import type { TropyReindexStatus } from '@backend/types/tropy-reindex';

/**
 * Le message de la réindexation complète des sources primaires (H7), dans la
 * langue de l'interface : ce qui se passe, pourquoi, et ce que cela coûte.
 * `null` quand il n'y a rien à dire. Les nombres suivent la langue
 * (« 40 648 »).
 *
 * Celle qu'un changement de modèle d'embeddings fait proposer (`cause:
 * 'model-change'`, Q29) a ses propres textes : elle n'a lieu qu'une fois
 * confirmée, l'assistant ne retrouve d'ici sa fin les sources pas encore
 * refaites que par leurs mots, et, interrompue, elle ne reprend pas seule à la
 * prochaine ouverture : elle y est proposée de nouveau.
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
      const counts = { done: n(status.done), total: n(status.total), chunks: n(status.chunks) };
      const modelChange = status.cause === 'model-change';
      // Des clés écrites en entier : le test des clés appelées les voit.
      const text =
        status.done === status.total
          ? modelChange
            ? t('primarySources.reembed.finishing', counts)
            : t('primarySources.reindexAll.finishing', counts)
          : modelChange
            ? t('primarySources.reembed.running', counts)
            : t('primarySources.reindexAll.running', counts);
      return status.waitingForSync ? `${text} ${t('primarySources.reindexAll.waitingForSync')}` : text;
    }
    case 'stopped': {
      const remaining = { remaining: n(status.remaining) };
      if (status.cause === 'model-change') {
        return status.reason === 'no-embedding-provider'
          ? t('primarySources.reembed.stoppedNoProvider', remaining)
          : t('primarySources.reembed.stoppedFailed', remaining);
      }
      return status.reason === 'no-embedding-provider'
        ? t('primarySources.reindexAll.stoppedNoProvider', remaining)
        : t('primarySources.reindexAll.stoppedFailed', remaining);
    }
    case 'done':
      return status.cause === 'model-change'
        ? t('primarySources.reembed.done', { total: n(status.total) })
        : t('primarySources.reindexAll.done', { total: n(status.total) });
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
