/**
 * Modèle + contexte tiennent-ils en mémoire ?
 *
 * Ordre de grandeur, pas mesure : Ollama réserve aussi des tampons de
 * calcul, et les architectures hybrides ont un cache KV bien plus petit
 * que la formule. Mais le piège qu'il faut signaler est grossier — le
 * 2026-09-08, une fenêtre de 256K sur un Mac de 24 Go avec un modèle de
 * 22 Go a repoussé 12 Go de poids sur le processeur et fait tomber la
 * lecture du prompt à dix jetons par seconde. Un avertissement approximatif
 * vaut mieux qu'une attente de dix minutes suivie d'une erreur.
 */

/** Coût KV par jeton quand les métadonnées manquent : un 8B dense (32 couches × 8 têtes KV × 128 × 2 × 2 octets). */
export const DEFAULT_KV_BYTES_PER_TOKEN = 128 * 1024;
/** Part de la mémoire physique qu'un modèle peut raisonnablement occuper (budget Metal sur Apple Silicon). */
export const USABLE_MEMORY_RATIO = 0.75;

export interface MemoryEstimateInput {
  modelBytes?: number;
  numCtx: number;
  kvBytesPerToken?: number;
  totalMemoryBytes?: number;
}

export interface MemoryEstimate {
  modelBytes: number;
  contextBytes: number;
  budgetBytes: number;
  /** `model` : le modèle seul dépasse déjà le budget ; `context` : c'est la fenêtre qui fait déborder. */
  level: 'ok' | 'context' | 'model';
}

export function estimateModelMemory(input: MemoryEstimateInput): MemoryEstimate | null {
  const { modelBytes, totalMemoryBytes, numCtx } = input;
  if (!modelBytes || !totalMemoryBytes || !(numCtx > 0)) return null;
  const contextBytes = numCtx * (input.kvBytesPerToken ?? DEFAULT_KV_BYTES_PER_TOKEN);
  const budgetBytes = totalMemoryBytes * USABLE_MEMORY_RATIO;
  const level =
    modelBytes > budgetBytes
      ? 'model'
      : modelBytes + contextBytes > budgetBytes
        ? 'context'
        : 'ok';
  return { modelBytes, contextBytes, budgetBytes, level };
}

/** `23 856 000 000` → `22.2` (gibioctets, une décimale ; l'unité vient de la locale). */
export function formatGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
