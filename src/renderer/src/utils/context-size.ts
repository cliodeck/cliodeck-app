/**
 * Affichage et saisie de la fenêtre de contexte (`num_ctx`).
 * Partagé entre le panneau du chat et les réglages de l'application, qui
 * éditent la même valeur (`llm.ollamaNumCtx`).
 */
import { NUM_CTX_MAX, NUM_CTX_MIN } from '../../../../backend/core/llm/context-windows';

/** `4096` → `4K`, `262144` → `256K`, `1048576` → `1M`, `1572864` → `1.5M`. */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1_048_576) {
    const m = tokens / 1_048_576;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1024) {
    return `${Math.round(tokens / 1024)}K`;
  }
  return tokens.toString();
}

/**
 * Ramène une saisie libre dans les bornes que le main accepte
 * (`clampNumCtx`) ; `null` quand ce n'est pas un nombre. On borne plutôt
 * que de rejeter : l'utilisateur qui tape « 3000000 » veut « le plus
 * possible », pas un message d'erreur.
 */
export function normalizeNumCtxInput(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(NUM_CTX_MAX, Math.max(NUM_CTX_MIN, n));
}
