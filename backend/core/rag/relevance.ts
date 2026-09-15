/**
 * Contrat de score commun aux quatre corpus (Path A′, amendement de l'ADR 0001).
 *
 * Chaque corpus a sa propre recherche hybride — HNSW + BM25 en mémoire pour
 * les PDF et Tropy, cosinus exhaustif + FTS5 pour le vault et le manuscrit —
 * et c'est voulu : bibliographie, archives, notes et manuscrit sont de nature
 * différente. Mais leurs extraits finissent triés ENSEMBLE dans
 * `RetrievalService`, puis coupés à `topK`. Un tri commun n'a de sens que si
 * tous parlent la même échelle.
 *
 * Ce n'était pas le cas. Le vault publiait un score RRF (maximum 1/61 ≈ 0,016)
 * face aux cosinus des autres (0,3 à 0,8) : ses notes passaient après tout le
 * reste et n'obtenaient une place que s'il en restait. Le manuscrit a eu le
 * même défaut jusqu'en rc.4. Et un extrait trouvé seulement par mot-clé —
 * typiquement un nom propre dans un OCR, que le modèle d'embedding ne
 * connaît pas — portait un cosinus de 0 dans Tropy, donc se classait dernier.
 *
 * Le contrat, désormais :
 *
 *   - **Le RRF choisit** quels extraits un corpus renvoie, et dans quel ordre
 *     il les considère. C'est son rôle, il le fait bien.
 *   - **La pertinence publiée** (`similarity`) est sur l'échelle du cosinus :
 *     `max(cosinus, pertinence lexicale)`, où la pertinence lexicale est
 *     dérivée du RANG BM25 (les scores BM25 bruts ne sont pas comparables
 *     d'un index à l'autre, les rangs si).
 *
 * Les constantes sont celles que `HybridSearch` (PDF) appliquait déjà — ce
 * module les rend communes au lieu d'en inventer de nouvelles. Elles ne sont
 * pas calibrées sur un jeu de référence : c'est le rôle du benchmark
 * (`docs/path-a-readiness.md`), qui pourra ensuite régler un seuil par corpus.
 */

/** Pertinence d'un extrait classé premier par la recherche lexicale. */
export const SPARSE_BASE = 0.7;
/** Perte de pertinence par rang lexical. */
export const SPARSE_DECAY = 0.02;
/**
 * Plancher : un extrait bien classé en lexical reste au-dessus du seuil
 * cosinus par défaut (0,12) — il n'a pas à être jugé sur une mesure
 * sémantique qui ne le voit pas.
 */
export const SPARSE_FLOOR = 0.15;
/** Au-delà de ce rang lexical, le mot-clé n'apporte plus de preuve. */
export const SPARSE_BOOST_RANK = 50;

/**
 * Nombre d'extraits gardés malgré le seuil quand AUCUN ne le franchit, pour
 * les corpus où une requête peut légitimement changer de langue (bibliographie
 * anglophone, archives multilingues). Mieux vaut trois extraits limites
 * qu'une réponse vide.
 */
export const CROSS_LANGUAGE_FALLBACK = 3;

/**
 * Pertinence dérivée d'un rang lexical (1 = meilleur). `null` ou un rang au-delà
 * de `SPARSE_BOOST_RANK` ne rapportent rien.
 */
export function sparseRankRelevance(rank: number | null | undefined): number {
  if (rank === null || rank === undefined || rank < 1 || rank > SPARSE_BOOST_RANK) {
    return 0;
  }
  return Math.max(SPARSE_FLOOR, SPARSE_BASE - SPARSE_DECAY * (rank - 1));
}

/** Signaux bruts d'un extrait, tels qu'un store hybride les connaît. */
export interface RelevanceSignals {
  /** Cosinus avec la requête ; 0 quand il n'a pas été calculé. */
  dense: number;
  /** Rang dans la recherche lexicale (1 = meilleur), `null` si absent. */
  sparseRank: number | null;
}

/** Pertinence publiée : la meilleure des deux preuves. */
export function relevanceScore(signals: RelevanceSignals): number {
  return Math.max(signals.dense, sparseRankRelevance(signals.sparseRank));
}

/**
 * Applique le seuil de pertinence à des extraits DÉJÀ triés et coupés à `topK`.
 *
 * @param fallback Nombre d'extraits gardés quand aucun ne franchit le seuil
 *   (0 = aucun repli : le corpus se tait quand il n'a rien de pertinent).
 */
export function applyThreshold<T extends { similarity: number }>(
  sorted: T[],
  threshold: number,
  fallback: number
): T[] {
  const kept = sorted.filter((r) => r.similarity >= threshold);
  if (kept.length === 0 && sorted.length > 0 && fallback > 0) {
    return sorted.slice(0, Math.min(fallback, sorted.length));
  }
  return kept;
}
