/**
 * Sélection finale des extraits, tous corpus confondus.
 *
 * Un simple `sort(similarity).slice(0, topK)` a un défaut structurel : le
 * corpus le plus « bruyant » rafle toutes les places. C'est ce qui rendait le
 * manuscrit inatteignable — dès que la bibliographie rendait `topK` extraits,
 * « qu'ai-je déjà écrit sur X ? » restait sans réponse, alors même que le
 * texte était indexé à chaque sauvegarde.
 *
 * Le manuscrit ne concourt donc plus à armes égales : quelques places lui
 * sont réservées quand il a quelque chose à dire. Il n'en prend jamais plus
 * que son quota, et n'en prend aucune quand il ne renvoie rien.
 */

/** Part des places réservée au manuscrit quand il renvoie des extraits. */
export const MANUSCRIPT_QUOTA_RATIO = 0.3;

interface Scored {
  similarity: number;
  sourceType?: string;
}

/**
 * Combine les résultats en réservant une part des places au manuscrit.
 *
 * @param results Tous les extraits, tous corpus confondus.
 * @param topK Nombre de places disponibles.
 * @param ratio Part réservée (0 = aucune réservation, comportement d'avant).
 */
export function selectWithManuscriptQuota<T extends Scored>(
  results: T[],
  topK: number,
  ratio: number = MANUSCRIPT_QUOTA_RATIO
): T[] {
  if (topK <= 0) return [];

  const byScore = (a: T, b: T): number => b.similarity - a.similarity;
  const manuscript = results.filter((r) => r.sourceType === 'manuscript').sort(byScore);
  const external = results.filter((r) => r.sourceType !== 'manuscript').sort(byScore);

  // Rien du manuscrit, ou pas de réservation : tri global, comme avant.
  if (manuscript.length === 0 || ratio <= 0) {
    return [...external, ...manuscript].sort(byScore).slice(0, topK);
  }

  // Au moins une place dès que le manuscrit a quelque chose, jamais plus
  // qu'il n'en a produit, et jamais toutes les places.
  const quota = Math.min(
    manuscript.length,
    Math.max(1, Math.min(topK - 1, Math.round(topK * ratio)))
  );

  const reserved = manuscript.slice(0, quota);
  const contenders = [...external, ...manuscript.slice(quota)].sort(byScore);
  const rest = contenders.slice(0, Math.max(0, topK - reserved.length));

  return [...reserved, ...rest].sort(byScore);
}
