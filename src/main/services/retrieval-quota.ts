/**
 * Sélection finale des extraits, tous corpus confondus.
 *
 * Un simple `sort(similarity).slice(0, topK)` a un défaut structurel : le
 * corpus le plus « bruyant » rafle toutes les places. En rc.4, c'était la
 * bibliographie qui saturait et le manuscrit — indexé à chaque sauvegarde —
 * n'atteignait jamais l'assistant : des places lui ont été réservées.
 *
 * Cette réserve était un plancher sans plafond : le reste du manuscrit
 * concourait au mérite pour les autres places et, écrit dans la langue de la
 * question, les gagnait. Trois sources faibles contre dix extraits du
 * manuscrit donnaient dix extraits du manuscrit, puis l'en-tête « aucun
 * extrait des sources » — et l'assistant brainstormait sur le seul texte de
 * l'auteur (`docs/poids-du-manuscrit.md`).
 *
 * Depuis le palier 1, la réserve est une **bande** : le manuscrit obtient au
 * plus `slots` places, jamais une de plus au mérite, et n'en prend aucune
 * quand il ne renvoie rien. Les sources ne lui cèdent donc jamais plus que
 * la bande, et il ne remplit pas les places qu'elles laissent vides : mieux
 * vaut trois sources faibles et deux passages du manuscrit que dix passages
 * du manuscrit. La largeur par défaut vient de `manuscriptSlots(topK)` ;
 * l'appelant l'élargit pour une question de rappel ou la portée « manuscrit
 * seul », ou la réduit à zéro pour l'écarter.
 */

/** Part des places accordée au manuscrit quand il renvoie des extraits. */
export const MANUSCRIPT_QUOTA_RATIO = 0.2;

interface Scored {
  similarity: number;
  sourceType?: string;
}

/**
 * Largeur de la bande du manuscrit pour `topK` places : au moins une dès que
 * deux places existent, jamais toutes. Zéro quand il n'y a qu'une place — la
 * seule place va aux sources — ou quand le ratio est nul.
 */
export function manuscriptSlots(topK: number, ratio: number = MANUSCRIPT_QUOTA_RATIO): number {
  if (topK <= 1 || ratio <= 0) return 0;
  return Math.max(1, Math.min(topK - 1, Math.round(topK * ratio)));
}

/**
 * Combine les résultats en accordant au manuscrit une bande de `slots`
 * places au plus ; les autres places vont aux extraits externes, par
 * pertinence décroissante.
 *
 * @param results Tous les extraits, tous corpus confondus.
 * @param topK Nombre de places disponibles.
 * @param slots Largeur de la bande (défaut : `manuscriptSlots(topK)`).
 */
export function selectWithManuscriptQuota<T extends Scored>(
  results: T[],
  topK: number,
  slots: number = manuscriptSlots(topK)
): T[] {
  if (topK <= 0) return [];

  const byScore = (a: T, b: T): number => b.similarity - a.similarity;
  const manuscript = results.filter((r) => r.sourceType === 'manuscript').sort(byScore);
  const external = results.filter((r) => r.sourceType !== 'manuscript').sort(byScore);

  const own = manuscript.slice(0, Math.max(0, Math.min(slots, topK)));
  const rest = external.slice(0, Math.max(0, topK - own.length));

  return [...own, ...rest].sort(byScore);
}
