import { useEffect } from 'react';
import { useWorkspaceModeStore } from '../stores/workspaceModeStore';
import { useUsageJournalStore } from '../stores/usageJournalStore';

/**
 * Miroir de mode pour le journal d'usage IA.
 *
 * Le mode applicatif (`explore|brainstorm|write|export`) vit dans le renderer
 * (localStorage), invisible du main. Ce hook le pousse vers le main via IPC à chaque
 * changement, pour que les événements d'inférence soient taggés avec le bon mode.
 * Best-effort : n'affecte jamais la navigation.
 */
export function useUsageModeMirror(): void {
  const active = useWorkspaceModeStore((s) => s.active);
  const setMode = useUsageJournalStore((s) => s.setMode);

  useEffect(() => {
    void setMode(active);
  }, [active, setMode]);
}
