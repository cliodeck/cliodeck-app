/**
 * Les clients du moteur embarqué qui tiennent un modèle, ou sont en train d'en charger un (L03-9, A16).
 *
 * Sortir du processus avec un modèle chargé sur Metal fait planter l'app à la fermeture (rapport
 * `.ips`, mesuré par les sondes llama). La sortie les libère donc tous, dans son échéance. Les
 * registres du projet (PDF, recherche, Tropy) libèrent les leurs en se fermant, mais pas toujours
 * à temps (le service PDF attend d'abord ses indexations) ; ceux d'un appel en cours hors du projet
 * (similarité, diapositives, un tour de chat qui ne s'est pas drainé) ne sont joignables que d'ici.
 *
 * Un client s'inscrit dès qu'un chargement commence, et se retire quand il ne tient plus rien et ne
 * charge plus rien. Un chargement en cours reste donc visible de la sortie, qui l'attend puis libère
 * son modèle : l'écriture du flush de sortie lance l'indexation du manuscrit, qui peut charger le
 * modèle d'embedding à ce moment-là. Une libération commencée ailleurs (un registre coupé par son
 * délai) reste visible elle aussi, et la sortie l'attend.
 *
 * Le partage d'un même GGUF entre clients (`acquireEmbeddedClient`) reste à venir (L08-16).
 */
import type { EmbeddedLLMClient } from './EmbeddedLLMClient.js';

const tracked = new Set<EmbeddedLLMClient>();

/** Vrai dès que la sortie libère les modèles : plus aucun ne se charge ensuite. */
let closing = false;

/** Un chargement commence : le client devient visible de la sortie. */
export function trackEmbeddedClient(client: EmbeddedLLMClient): void {
  tracked.add(client);
}

/** Le client ne tient plus aucun modèle et n'en charge aucun. */
export function forgetEmbeddedClient(client: EmbeddedLLMClient): void {
  tracked.delete(client);
}

/**
 * La sortie a commencé à libérer les modèles. Un chargement demandé ensuite (l'indexation relancée
 * par un registre libéré) est refusé : son modèle serait chargé au moment d'`app.exit`.
 */
export function isEmbeddedEngineClosing(): boolean {
  return closing;
}

/**
 * La sortie : libère tous les clients suivis, chacun ses contextes, puis ses modèles, jamais le
 * backend `llama` du processus. Un chargement en cours est attendu, puis libéré ; une libération
 * déjà en cours est attendue, pas refaite (`EmbeddedLLMClient.dispose` la partage). À n'appeler
 * qu'à la sortie : aucun modèle ne se charge plus après. Ne lève pas.
 */
export async function disposeAllEmbeddedClients(): Promise<void> {
  // Posé avant l'instantané : un chargement est soit déjà suivi, soit refusé.
  closing = true;
  const clients = [...tracked];
  if (clients.length === 0) return;
  console.log(`🧹 [EMBEDDED] Libération de ${clients.length} client(s) embarqué(s) encore suivi(s)`);
  const results = await Promise.allSettled(clients.map((client) => client.dispose()));
  for (const result of results) {
    if (result.status === 'rejected') console.warn('⚠️ [EMBEDDED] Libération impossible :', result.reason);
  }
}
