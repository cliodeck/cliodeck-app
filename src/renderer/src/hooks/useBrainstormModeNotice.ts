import { useCallback, useEffect, useState } from 'react';
import { useModeStore } from '../stores/modeStore';

/** Le mode de chat livré avec l'app, actif au premier lancement. */
const DEFAULT_MODE_ID = 'default-assistant';
/** Le mode de chat « Brainstorming » (`backend/core/modes/built-in-modes.ts`). */
export const BRAINSTORMING_MODE_ID = 'brainstorming';
/** La clé de configuration qui retient le refus (`AppConfig`). */
export const BRAINSTORM_MODE_NOTICE_FLAG = 'brainstormModeNoticeDismissed';

export interface BrainstormModeNotice {
  /** La bannière a lieu d'être affichée. */
  visible: boolean;
  /** Bascule vers le mode « Brainstorming » ; ne retient rien. */
  activate: () => void;
  /** Refuse la proposition pour de bon. */
  dismiss: () => void;
}

/**
 * Propose le mode de chat « Brainstorming » dans l'espace Brainstorm.
 *
 * L'espace et le mode de chat sont deux magasins indépendants : on peut
 * brainstormer longtemps avec l'assistant par défaut sans savoir qu'un mode
 * cherche des idées dans les sources, avec vingt extraits et sans le
 * manuscrit (`docs/poids-du-manuscrit.md`, décision 2). La bannière le dit
 * tant que le mode actif est celui par défaut.
 *
 * Deux sorties, deux mémoires :
 *   - « Activer » change le mode ; la bannière disparaît parce que le mode
 *     n'est plus celui par défaut, et rien n'est écrit — qui revient plus
 *     tard à l'assistant par défaut mérite de revoir la proposition ;
 *   - « Ne plus proposer » écrit `brainstormModeNoticeDismissed` dans la
 *     configuration de l'app, et la bannière ne revient plus.
 *
 * Le drapeau se lit une fois au montage, par `config.get` : tant qu'il n'est
 * pas lu, la bannière reste cachée plutôt que d'apparaître une fraction de
 * seconde à qui l'a déjà refusée. Pas de `useStickyWarning` ici : les
 * notifications n'ont pas de bouton d'action et restent réservées aux
 * avertissements de démarrage.
 */
export function useBrainstormModeNotice(): BrainstormModeNotice {
  const activeModeId = useModeStore((s) => s.activeModeId);
  // null : pas encore lu (ou pas de pont IPC) — on n'affiche rien.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    const get = window.electron?.config?.get;
    if (!get) return;
    let cancelled = false;
    get(BRAINSTORM_MODE_NOTICE_FLAG)
      .then((value: unknown) => {
        if (!cancelled) setDismissed(value === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const activate = useCallback(() => {
    void useModeStore.getState().setActiveMode(BRAINSTORMING_MODE_ID);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    void window.electron?.config?.set(BRAINSTORM_MODE_NOTICE_FLAG, true);
  }, []);

  return {
    visible: dismissed === false && activeModeId === DEFAULT_MODE_ID,
    activate,
    dismiss,
  };
}
