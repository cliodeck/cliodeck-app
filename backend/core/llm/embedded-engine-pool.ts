/**
 * Les clients du moteur embarqué qui tiennent un modèle chargé (L03-9, A16).
 *
 * Sortir du processus avec un modèle chargé sur Metal fait planter l'app à la fermeture (rapport
 * `.ips`, mesuré par les sondes llama). La sortie les libère donc tous, dans son échéance. Les
 * registres du projet (PDF, recherche, Tropy) libèrent les leurs en se fermant, mais pas toujours
 * à temps (le service PDF attend d'abord ses indexations) ; ceux d'un appel en cours hors du projet
 * (similarité, diapositives, un tour de chat qui ne s'est pas drainé) ne sont joignables que d'ici.
 *
 * Un client s'inscrit quand un modèle est chargé, et se retire en se libérant. Le partage d'un même
 * GGUF entre clients (`acquireEmbeddedClient`) reste à venir (L08-16).
 */
import type { EmbeddedLLMClient } from './EmbeddedLLMClient.js';

const loaded = new Set<EmbeddedLLMClient>();

export function trackLoadedClient(client: EmbeddedLLMClient): void {
  loaded.add(client);
}

export function forgetLoadedClient(client: EmbeddedLLMClient): void {
  loaded.delete(client);
}

/**
 * Libère tous les clients qui tiennent encore un modèle : chacun ses contextes, puis ses modèles,
 * jamais le backend `llama` du processus. Ne lève pas.
 */
export async function disposeAllEmbeddedClients(): Promise<void> {
  const clients = [...loaded];
  if (clients.length === 0) return;
  console.log(`🧹 [EMBEDDED] Libération de ${clients.length} client(s) embarqué(s) encore chargé(s)`);
  const results = await Promise.allSettled(clients.map((client) => client.dispose()));
  for (const result of results) {
    if (result.status === 'rejected') console.warn('⚠️ [EMBEDDED] Libération impossible :', result.reason);
  }
}
