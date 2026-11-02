/**
 * Régression : une seule commande de menu « Vérifier les citations » demandait
 * deux clics sur OK. Les écouteurs de menu ne se retirent pas et se réabonnent
 * quand `t` change : la commande s'exécute deux fois. Tant qu'une alerte
 * écrasait la précédente, cela ne se voyait pas ; depuis la file des dialogues,
 * les deux rapports passent l'un après l'autre.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const fixture = vi.hoisted(() => ({
  isBook: false,
  live: 'Une affirmation [@absente].',
  readManuscript: vi.fn(),
}));

vi.mock('../../stores/editorStore', () => ({
  useEditorStore: { getState: () => ({ getLiveContent: () => fixture.live }) },
}));
vi.mock('../../stores/bibliographyStore', () => ({
  useBibliographyStore: { getState: () => ({ citations: [] }) },
}));
vi.mock('../../stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: { type: fixture.isBook ? 'book' : 'article' } }),
  },
}));
vi.mock('../../stores/manuscriptStore', () => ({
  useManuscriptStore: { getState: () => ({ readManuscript: fixture.readManuscript }) },
}));

import { runCitationCheck } from '../check-citations';
import { useDialogStore } from '../../stores/dialogStore';

const t = ((key: string) => key) as unknown as TFunction;
const dialogs = () => useDialogStore.getState();

/** Laisse s'exécuter les suites des promesses résolues. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Observe une promesse sans l'attendre : une alerte ouverte ne doit pas figer le test. */
function watch(promise: Promise<void>): { done: boolean } {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
}

describe('runCitationCheck', () => {
  beforeEach(async () => {
    for (let i = 0; i < 20 && dialogs().alertOpen; i += 1) dialogs().closeAlert();
    await flush(); // La garde ne se relâche qu'après la fermeture du rapport.
    fixture.isBook = false;
    fixture.live = 'Une affirmation [@absente].';
    fixture.readManuscript.mockReset();
    fixture.readManuscript.mockResolvedValue([
      { chapter: { title: 'Premier' }, content: 'Texte [@absente].' },
    ]);
  });

  it('deux commandes simultanées donnent un seul rapport, fermé par un seul OK', async () => {
    const first = watch(runCitationCheck(t));
    const second = watch(runCitationCheck(t));
    await flush();

    expect(dialogs().alertMessage).toContain('[@absente]');
    expect(dialogs().queue).toHaveLength(1);

    dialogs().closeAlert();
    await flush();

    expect(dialogs().alertOpen).toBe(false);
    expect(first.done).toBe(true);
    expect(second.done).toBe(true);
  });

  it('répéter la commande pendant que le rapport est à l’écran n’en empile pas d’autre', async () => {
    void runCitationCheck(t);
    await flush();
    void runCitationCheck(t);
    await flush();

    expect(dialogs().queue).toHaveLength(1);
  });

  it('le rapport fermé, une nouvelle commande vérifie à nouveau', async () => {
    void runCitationCheck(t);
    await flush();
    dialogs().closeAlert();
    await flush();
    expect(dialogs().alertOpen).toBe(false);

    fixture.live = 'Plus aucune citation.';
    void runCitationCheck(t);
    await flush();

    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertMessage).toBe('citations.allValid');
  });

  it('livre : deux commandes ne lisent le manuscrit qu’une fois', async () => {
    fixture.isBook = true;

    void runCitationCheck(t);
    void runCitationCheck(t);
    await flush();

    expect(fixture.readManuscript).toHaveBeenCalledTimes(1);
    expect(dialogs().alertMessage).toContain('Premier');
  });

  it('une lecture en échec dit l’erreur, et n’empêche pas la commande suivante', async () => {
    fixture.isBook = true;
    fixture.readManuscript.mockRejectedValueOnce(new Error('disque absent'));

    void runCitationCheck(t);
    await flush();
    expect(dialogs().alertMessage).toBe('citations.checkError');

    dialogs().closeAlert();
    await flush();

    void runCitationCheck(t);
    await flush();
    expect(dialogs().alertMessage).toContain('[@absente]');
  });
});
