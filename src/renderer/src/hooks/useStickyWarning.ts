import { useEffect, useRef } from 'react';
import { useNotificationStore } from '../stores/notificationStore';

export interface StickyWarning {
  title: string;
  message: string;
  details?: string;
}

/**
 * Affiche un avertissement de démarrage qui reste à l'écran jusqu'à ce qu'on
 * le ferme : un message qui s'efface seul au lancement passerait inaperçu.
 *
 * Trois règles, communes à tous ces avertissements :
 * - un seul exemplaire, quel que soit le nombre de rendus ;
 * - la langue enregistrée s'applique après le premier rendu : tant qu'il est
 *   à l'écran, il est réécrit dans la nouvelle langue ;
 * - une fois fermé par l'utilisateur, il ne revient pas — et `onDismissed`
 *   est appelé, une fois, pour qui veut s'en souvenir au-delà de la session.
 */
export function useStickyWarning(warning: StickyWarning | null, onDismissed?: () => void): void {
  const notify = useNotificationStore((s) => s.notify);
  const shownId = useRef<string | null>(null);
  const replacing = useRef(false);
  const reported = useRef(false);
  const dismissedCallback = useRef(onDismissed);
  dismissedCallback.current = onDismissed;

  const title = warning?.title;
  const message = warning?.message;
  const details = warning?.details;

  useEffect(() => {
    if (title === undefined || message === undefined) return;
    const store = useNotificationStore.getState();
    if (shownId.current && !store.notifications.some((n) => n.id === shownId.current)) return;
    // Remplacer n'est pas fermer : l'abonnement ci-dessous doit l'ignorer.
    replacing.current = true;
    if (shownId.current) store.dismiss(shownId.current);
    shownId.current = notify({ level: 'warning', title, message, details, duration: 0 });
    replacing.current = false;
  }, [title, message, details, notify]);

  useEffect(
    () =>
      useNotificationStore.subscribe((state) => {
        if (replacing.current || reported.current || !shownId.current) return;
        if (state.notifications.some((n) => n.id === shownId.current)) return;
        reported.current = true;
        dismissedCallback.current?.();
      }),
    []
  );
}
