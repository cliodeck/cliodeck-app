import { useEffect } from 'react';
import { create } from 'zustand';
import type { TropyReembedProposal } from '@backend/types/tropy-reindex';
import { projectLifecycle } from '../lifecycle/projectLifecycle';
import { useProjectStore } from './projectStore';

/**
 * La réindexation des sources primaires proposée après un changement de modèle d'embeddings (J7,
 * Q29), telle que le main la calcule pour le projet ouvert : des sources ont des extraits d'une
 * autre dimension que le nouveau modèle, que la recherche par le sens ne peut plus comparer aux
 * questions. Proposée, jamais faite d'office ; même patron que l'index des PDF à reconstruire (J8).
 * Lue par le bandeau du panneau Sources primaires et par la barre d'état, qui se voit même panneau
 * fermé.
 */
interface TropyReembedState {
  /** Ce que le main propose de réindexer pour le projet ouvert, `null` sans rien à proposer. */
  proposal: TropyReembedProposal | null;
  /** L'historien a fermé le bandeau : il revient à la prochaine ouverture du projet. */
  dismissed: boolean;
  /** Relit la proposition du main pour le projet à l'écran. */
  refresh: () => Promise<void>;
  /**
   * « Réindexer », une fois confirmé : la progression est celle de la réindexation des sources
   * primaires (`tropyReindexStore`). Rend `started` si la passe est partie, sinon ce qui l'en a
   * empêchée.
   */
  reembed: () => Promise<'started' | 'no-embedding-provider' | 'not-started'>;
  dismiss: () => void;
}

export const useTropyReembedStore = create<TropyReembedState>((set, get) => ({
  proposal: null,
  dismissed: false,

  refresh: async () => {
    // Absent hors d'Electron (tests de composants qui ne montent pas le preload).
    const getReembedProposal = window.electron?.tropy?.getReembedProposal;
    const handle = projectLifecycle.capture();
    if (!getReembedProposal || !handle) return;
    try {
      const result = await getReembedProposal(handle.path);
      // La réponse d'un projet quitté ne s'inscrit pas dans le suivant.
      if (!handle.isCurrent() || !result?.success) return;
      set({ proposal: result.proposal ?? null });
    } catch (error) {
      console.warn('Sources primaires : proposition de réindexation illisible', error);
    }
  },

  reembed: async () => {
    const reembed = window.electron?.tropy?.reembed;
    const handle = projectLifecycle.capture();
    if (!reembed || !handle) return 'not-started';
    // Le message de la passe prend le relais ; sa fin relit la proposition (signal du main).
    set({ proposal: null });
    try {
      const result = await reembed(handle.path);
      if (result?.started) return 'started';
      if (handle.isCurrent()) await get().refresh();
      return result?.reason === 'no-embedding-provider' ? 'no-embedding-provider' : 'not-started';
    } catch (error) {
      console.warn('Sources primaires : réindexation non lancée', error);
      if (handle.isCurrent()) await get().refresh();
      return 'not-started';
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

projectLifecycle.onReset('tropyReembed', () => useTropyReembedStore.setState({ proposal: null, dismissed: false }));

// Le main dit quand la proposition a pu changer : modèle d'embeddings changé, passe finie, arrêtée
// ou interrompue, base purgée. Il ne dit pas pour quel projet : la relecture passe par le projet à
// l'écran.
if (typeof window !== 'undefined') {
  window.electron?.tropy?.onReembedProposalChanged?.(() => {
    void useTropyReembedStore.getState().refresh();
  });
}

/** La réindexation proposée pour le projet ouvert, relue à chaque changement de projet. */
export function useTropyReembedProposal(): {
  proposal: TropyReembedProposal | null;
  reembed: () => Promise<'started' | 'no-embedding-provider' | 'not-started'>;
  dismiss: () => void;
} {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  useEffect(() => {
    if (projectPath) void useTropyReembedStore.getState().refresh();
  }, [projectPath]);
  const proposal = useTropyReembedStore((s) => (s.dismissed ? null : s.proposal));
  const reembed = useTropyReembedStore((s) => s.reembed);
  const dismiss = useTropyReembedStore((s) => s.dismiss);
  return { proposal, reembed, dismiss };
}
