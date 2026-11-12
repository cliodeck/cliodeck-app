import { useEffect } from 'react';
import { create } from 'zustand';
import { projectLifecycle } from '../lifecycle/projectLifecycle';
import { useProjectStore } from './projectStore';

/**
 * L'index de recherche des PDF à reconstruire (J8), tel que le main le trouve à l'ouverture du
 * projet : une session précédente l'a laissé périmé (des PDF retirés ou réindexés) et s'est fermée
 * avant sa reconstruction. Proposé à l'historien, jamais reconstruit sans lui. Lu par le bandeau du
 * panneau Bibliographie et par la barre d'état, qui se voit même panneau fermé.
 */
interface PdfIndexState {
  /** Le main propose de reconstruire l'index du projet ouvert. */
  rebuildDue: boolean;
  /** L'historien a fermé le bandeau : il revient à la prochaine ouverture du projet. */
  dismissed: boolean;
  /** Relit l'état du main pour le projet à l'écran. */
  refresh: () => Promise<void>;
  /** « Reconstruire » : la progression est celle de toute reconstruction (`rebuildStore`). */
  rebuild: () => Promise<void>;
  dismiss: () => void;
}

export const usePdfIndexStore = create<PdfIndexState>((set, get) => ({
  rebuildDue: false,
  dismissed: false,

  refresh: async () => {
    // Absent hors d'Electron (tests de composants qui ne montent pas le preload).
    const getIndexState = window.electron?.pdf?.getIndexState;
    const handle = projectLifecycle.capture();
    if (!getIndexState || !handle) return;
    try {
      const result = await getIndexState(handle.path);
      // La réponse d'un projet quitté ne s'inscrit pas dans le suivant.
      if (!handle.isCurrent() || !result?.success) return;
      set({ rebuildDue: result.rebuildDue === true });
    } catch (error) {
      console.warn('Index des PDF : état illisible', error);
    }
  },

  rebuild: async () => {
    const rebuildIndex = window.electron?.pdf?.rebuildIndex;
    const handle = projectLifecycle.capture();
    if (!rebuildIndex || !handle) return;
    // Le voile de la reconstruction prend le relais ; sa fin relit l'état (ci-dessous).
    set({ rebuildDue: false });
    try {
      const result = await rebuildIndex(handle.path);
      if (handle.isCurrent() && !result?.started) await get().refresh();
    } catch (error) {
      console.warn('Index des PDF : reconstruction non lancée', error);
      if (handle.isCurrent()) await get().refresh();
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

projectLifecycle.onReset('pdfIndex', () => usePdfIndexStore.setState({ rebuildDue: false, dismissed: false }));

// Une reconstruction finie, réussie ou non, celle du bandeau comme celle qui suit une suppression :
// l'état du main fait foi. Réussie, plus rien n'est proposé ; échouée, son message promet la
// prochaine ouverture.
if (typeof window !== 'undefined') {
  window.electron?.project?.onRebuildProgress?.((progress) => {
    if (progress.phase !== 'running') void usePdfIndexStore.getState().refresh();
  });
}

/** La reconstruction proposée pour le projet ouvert, relue à chaque changement de projet. */
export function usePdfIndexRebuildDue(): { due: boolean; rebuild: () => Promise<void>; dismiss: () => void } {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  useEffect(() => {
    if (projectPath) void usePdfIndexStore.getState().refresh();
  }, [projectPath]);
  const due = usePdfIndexStore((s) => s.rebuildDue && !s.dismissed);
  const rebuild = usePdfIndexStore((s) => s.rebuild);
  const dismiss = usePdfIndexStore((s) => s.dismiss);
  return { due, rebuild, dismiss };
}
