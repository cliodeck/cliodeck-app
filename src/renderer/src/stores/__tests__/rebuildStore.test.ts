// @vitest-environment jsdom
/**
 * L'état de la reconstruction se lit sur la phase, jamais sur le pourcentage.
 *
 * `isRebuilding = percentage < 100` prenait un échec pour un début : l'événement
 * d'erreur arrivait à 0 %, et le voile restait sans plus jamais se fermer. Passe par
 * l'abonnement réel du magasin, posé à son chargement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RebuildProgressEvent } from '@backend/types/rebuild-progress';

const h = vi.hoisted(() => {
  const state: { listener: ((event: unknown) => void) | null } = { listener: null };
  (window as unknown as { electron: unknown }).electron = {
    project: {
      onRebuildProgress: (listener: (event: unknown) => void) => {
        state.listener = listener;
        return () => undefined;
      },
    },
  };
  return state;
});

import { useRebuildStore } from '../rebuildStore';

const rebuild = () => useRebuildStore.getState();

const event = (over: Partial<RebuildProgressEvent>): RebuildProgressEvent => ({
  current: 20,
  total: 100,
  status: 'Building…',
  percentage: 20,
  phase: 'running',
  ...over,
});

/** Tel qu'il arrive du main, par l'abonnement du magasin. */
const receive = (over: Partial<RebuildProgressEvent>) => h.listener?.(event(over));

beforeEach(() => {
  useRebuildStore.setState({
    isRebuilding: false,
    failure: null,
    progress: { current: 0, total: 100, status: '', percentage: 0, phase: 'done' },
  });
});

describe('rebuildStore', () => {
  it('un échec à 0 % n’est pas une reconstruction en cours : il pose sa cause', () => {
    receive({ phase: 'failed', current: 0, percentage: 0, status: 'Error: disque', error: 'disque plein' });

    expect(rebuild().isRebuilding).toBe(false);
    expect(rebuild().failure).toBe('disque plein');
  });

  it('un échec à 90 % non plus', () => {
    receive({ phase: 'failed', current: 90, percentage: 90, error: 'disque plein' });

    expect(rebuild().isRebuilding).toBe(false);
    expect(rebuild().failure).toBe('disque plein');
    expect(rebuild().progress.percentage).toBe(90);
  });

  it('un échec sans message garde au moins son libellé : le voile a de quoi s’afficher', () => {
    receive({ phase: 'failed', status: 'Error: inconnue', error: undefined });

    expect(rebuild().failure).toBe('Error: inconnue');
  });

  it('en cours, même à 100 % ; terminé, même à 20 %', () => {
    receive({ phase: 'running', current: 100, percentage: 100 });
    expect(rebuild().isRebuilding).toBe(true);

    receive({ phase: 'done', current: 20, percentage: 20 });
    expect(rebuild().isRebuilding).toBe(false);
    expect(rebuild().failure).toBeNull();
  });

  it('une nouvelle reconstruction efface l’échec précédent', () => {
    receive({ phase: 'failed', error: 'disque plein' });
    expect(rebuild().failure).toBe('disque plein');

    receive({ phase: 'running' });

    expect(rebuild().isRebuilding).toBe(true);
    expect(rebuild().failure).toBeNull();
  });

  it('resetProgress efface les deux', () => {
    receive({ phase: 'failed', error: 'disque plein' });
    expect(rebuild().failure).toBe('disque plein');
    rebuild().resetProgress();
    expect(rebuild().failure).toBeNull();
    expect(rebuild().isRebuilding).toBe(false);

    receive({ phase: 'running' });
    rebuild().resetProgress();
    expect(rebuild().failure).toBeNull();
    expect(rebuild().isRebuilding).toBe(false);
    expect(rebuild().progress.percentage).toBe(0);
  });
});
