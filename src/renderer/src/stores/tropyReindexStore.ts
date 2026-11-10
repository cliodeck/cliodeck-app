import { useEffect } from 'react';
import { create } from 'zustand';
import type { TropyReindexStatus } from '@backend/types/tropy-reindex';
import { useProjectStore } from './projectStore';

/**
 * La réindexation complète des sources primaires (H7), telle que le main la dit
 * (`tropy:reindex-progress`). Lue par le panneau Sources primaires et par la
 * barre d'état : une passe de plusieurs heures se voit même panneau fermé.
 */

/** Combien de temps « Réindexation … terminée » (ou « Index … reconstruit ») reste affiché avant de s'effacer. */
export const REINDEX_DONE_NOTICE_MS = 10_000;

interface TropyReindexState {
  status: TropyReindexStatus;
  /** Un état reçu du main. */
  receive: (status: TropyReindexStatus) => void;
  /**
   * Relit l'état du main : un panneau ouvert après le départ de la passe n'a
   * pas reçu les événements déjà envoyés.
   */
  refresh: () => Promise<void>;
  /** Plus rien à dire (projet fermé ou changé). */
  clear: () => void;
}

let doneTimer: ReturnType<typeof setTimeout> | null = null;
/** Avance à chaque état reçu : une relecture partie avant ne l'écrase pas. */
let revision = 0;

function cancelDoneTimer(): void {
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = null;
}

export const useTropyReindexStore = create<TropyReindexState>((set, get) => ({
  status: { phase: 'idle' },

  receive: (status) => {
    revision += 1;
    cancelDoneTimer();
    set({ status });
    // La fin se dit brièvement, puis s'efface d'elle-même : celle d'une passe,
    // comme celle de la reconstruction de l'index à l'ouverture.
    if (status.phase === 'done' || status.phase === 'index-rebuilt') {
      doneTimer = setTimeout(() => {
        doneTimer = null;
        if (get().status === status) set({ status: { phase: 'idle' } });
      }, REINDEX_DONE_NOTICE_MS);
    }
  },

  refresh: async () => {
    // Absent hors d'Electron (tests de composants qui ne montent pas le preload).
    const getReindexStatus = window.electron?.tropy?.getReindexStatus;
    if (!getReindexStatus) return;
    const startedAt = revision;
    try {
      const result = await getReindexStatus();
      if (startedAt !== revision || !result?.success || !result.status) return;
      // Le main oublie la fin dès qu'il l'a dite : la relire (le panneau qui
      // s'ouvre) n'efface pas avant son heure le message que la barre d'état
      // affiche encore. Un changement de projet l'efface (`clear`).
      const shown = get().status.phase;
      if (result.status.phase === 'idle' && (shown === 'done' || shown === 'index-rebuilt')) return;
      get().receive(result.status);
    } catch (error) {
      console.warn('Réindexation des sources primaires : état illisible', error);
    }
  },

  clear: () => {
    revision += 1;
    cancelDoneTimer();
    set({ status: { phase: 'idle' } });
  },
}));

let subscribed = false;
/** Le projet dont l'état est affiché : un changement de projet efface celui du précédent. */
let shownFor: string | null = null;

function subscribe(): void {
  if (subscribed) return;
  const onReindexProgress = window.electron?.tropy?.onReindexProgress;
  if (!onReindexProgress) return;
  subscribed = true;
  onReindexProgress((status) => useTropyReindexStore.getState().receive(status));
}

/** L'état de la réindexation complète du projet ouvert, relu à chaque changement de projet. */
export function useTropyReindexStatus(): TropyReindexStatus {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  useEffect(() => {
    subscribe();
    const store = useTropyReindexStore.getState();
    if (projectPath !== shownFor) {
      shownFor = projectPath;
      store.clear();
    }
    if (projectPath) void store.refresh();
  }, [projectPath]);
  return useTropyReindexStore((s) => s.status);
}
