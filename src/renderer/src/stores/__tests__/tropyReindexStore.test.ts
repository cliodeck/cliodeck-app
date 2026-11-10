// @vitest-environment jsdom
/**
 * La fin de la réindexation complète des sources primaires, ou de la reconstruction de l'index à
 * l'ouverture, se dit un moment, puis s'efface (H7, revue).
 *
 * Le main l'oublie dès qu'il l'a dite (`getReindexStatus` rend alors `idle`) : un panneau ouvert
 * plus tard n'a plus rien à annoncer. Mais ouvrir le panneau Sources primaires relit cet état, et la
 * relecture effaçait aussitôt le message de fin que la barre d'état affichait encore : mesuré dans
 * l'app réelle, « Index reconstruit » disparu une centaine de millisecondes après l'ouverture du
 * panneau, au lieu de dix secondes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TropyReindexStatus } from '@backend/types/tropy-reindex';

const h = vi.hoisted(() => {
  const state = { status: { phase: 'idle' } as unknown };
  (window as unknown as { electron: unknown }).electron = {
    // Abonnement posé au chargement de `rebuildStore`, que `projectStore` importe.
    project: { onRebuildProgress: () => () => undefined },
    tropy: {
      getReindexStatus: async () => ({ success: true, status: state.status }),
    },
  };
  return state;
});

import { REINDEX_DONE_NOTICE_MS, useTropyReindexStore } from '../tropyReindexStore';

const store = () => useTropyReindexStore.getState();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  h.status = { phase: 'idle' };
  store().clear();
});

afterEach(() => {
  store().clear();
  vi.useRealTimers();
});

describe('tropyReindexStore : la fin dite un moment, même relue entre-temps', () => {
  for (const end of [{ phase: 'done', total: 345 }, { phase: 'index-rebuilt' }] as TropyReindexStatus[]) {
    it(`« ${end.phase} » reçu, puis le panneau ouvert : le message reste, puis s’efface à son heure`, async () => {
      store().receive(end);
      // Le main a déjà tout oublié.
      h.status = { phase: 'idle' };

      await store().refresh();
      expect(store().status).toEqual(end);

      vi.advanceTimersByTime(REINDEX_DONE_NOTICE_MS);
      expect(store().status).toEqual({ phase: 'idle' });
    });
  }

  it('témoin : en cours, la relecture donne l’état du main', async () => {
    store().receive({ phase: 'running', done: 1, total: 3, chunks: 9, waitingForSync: false });
    h.status = { phase: 'running', done: 2, total: 3, chunks: 9, waitingForSync: false };

    await store().refresh();

    expect(store().status).toEqual(h.status);
  });

  it('témoin : un projet changé efface le message de fin du précédent', async () => {
    store().receive({ phase: 'index-rebuilt' });
    store().clear();
    await store().refresh();

    expect(store().status).toEqual({ phase: 'idle' });
  });
});
