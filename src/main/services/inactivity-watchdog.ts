/**
 * Délai d'inactivité d'un tour de chat.
 *
 * Consommateur du curseur « Timeout » du panneau de chat, qui n'en avait
 * plus depuis la fusion (l'ancien `chat-service` l'appliquait au fetch).
 * Sémantique choisie : un délai *sans activité*, pas une durée totale. Une
 * réponse qui continue d'arriver n'est jamais coupée, même longue ; un tour
 * dont plus rien ne vient — modèle en chargement sans fin, outil MCP
 * bloqué, connexion morte — est interrompu. `touch()` à chaque signe de
 * vie (chunk, statut, source, événement d'outil) réarme le compteur.
 */

export interface InactivityWatchdog {
  /** Réarme le compteur. Sans effet une fois le délai écoulé, ou sans délai. */
  touch(): void;
  /** Arrête le compteur (fin de tour). */
  disarm(): void;
  /** Vrai si `onTimeout` a été appelé. */
  readonly timedOut: boolean;
}

export function createInactivityWatchdog(opts: {
  timeoutMs?: number;
  onTimeout: () => void;
}): InactivityWatchdog {
  const timeoutMs =
    typeof opts.timeoutMs === 'number' &&
    Number.isFinite(opts.timeoutMs) &&
    opts.timeoutMs > 0
      ? opts.timeoutMs
      : undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    get timedOut() {
      return timedOut;
    },
    touch() {
      if (timeoutMs === undefined || timedOut) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        timedOut = true;
        opts.onTimeout();
      }, timeoutMs);
    },
    disarm: clear,
  };
}
