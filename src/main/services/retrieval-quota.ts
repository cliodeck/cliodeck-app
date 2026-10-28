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
 * du manuscrit.
 *
 * Les notes de lecture sont l'autre corpus « à la voix de l'auteur » : même
 * langue, même cosinus exhaustif, et jusqu'au chantier de 2026-10 ni plancher
 * ni plafond — « à armes égales », c'est-à-dire capables de rafler toutes les
 * places exactement comme le manuscrit, ou d'être invisibles dès que la
 * bibliographie sature. Elles ont désormais leur bande, du même calibre.
 * Les bandes se décident par corpus (`OwnTextBands`) ; l'appelant les élargit
 * pour une question de rappel ou une portée « seul », ou les réduit à zéro.
 */

/** Part des places accordée à un corpus à la voix de l'auteur quand il renvoie des extraits. */
export const MANUSCRIPT_QUOTA_RATIO = 0.2;

interface Scored {
  similarity: number;
  sourceType?: string;
}

/** Les corpus écrits par l'historien lui-même, chacun avec sa bande. */
export type OwnTextCorpus = 'manuscript' | 'readingNotes';
export const OWN_TEXT_CORPORA: readonly OwnTextCorpus[] = ['manuscript', 'readingNotes'];

/** Largeur de bande par corpus ; un corpus absent de la table reçoit la bande par défaut. */
export type OwnTextBands = Partial<Record<OwnTextCorpus, number>>;

/**
 * Largeur de bande par défaut pour `topK` places : au moins une dès que deux
 * places existent, jamais toutes. Zéro quand il n'y a qu'une place — la
 * seule place va aux sources — ou quand le ratio est nul.
 */
export function manuscriptSlots(topK: number, ratio: number = MANUSCRIPT_QUOTA_RATIO): number {
  if (topK <= 1 || ratio <= 0) return 0;
  return Math.max(1, Math.min(topK - 1, Math.round(topK * ratio)));
}

function isOwnText(sourceType: string | undefined): sourceType is OwnTextCorpus {
  return sourceType === 'manuscript' || sourceType === 'readingNotes';
}

/**
 * Combine les résultats en accordant à chaque corpus à la voix de l'auteur
 * une bande de places au plus ; les autres places vont aux extraits externes,
 * par pertinence décroissante. Quand les bandes à elles seules dépassent
 * `topK` (portée « seul » sur deux corpus), les passages les plus pertinents
 * l'emportent entre eux.
 *
 * @param results Tous les extraits, tous corpus confondus.
 * @param topK Nombre de places disponibles.
 * @param bands Largeur de bande par corpus (défaut : `manuscriptSlots(topK)` chacun).
 */
export function selectWithOwnTextBands<T extends Scored>(
  results: T[],
  topK: number,
  bands: OwnTextBands = {}
): T[] {
  if (topK <= 0) return [];

  const byScore = (a: T, b: T): number => b.similarity - a.similarity;
  const own: T[] = [];
  for (const corpus of OWN_TEXT_CORPORA) {
    const slots = Math.max(0, Math.min(bands[corpus] ?? manuscriptSlots(topK), topK));
    own.push(...results.filter((r) => r.sourceType === corpus).sort(byScore).slice(0, slots));
  }
  const kept = own.sort(byScore).slice(0, topK);
  const external = results.filter((r) => !isOwnText(r.sourceType)).sort(byScore);
  const rest = external.slice(0, Math.max(0, topK - kept.length));

  return [...kept, ...rest].sort(byScore);
}

/**
 * Forme historique : la bande du seul manuscrit. Les notes de lecture
 * reçoivent la bande par défaut.
 */
export function selectWithManuscriptQuota<T extends Scored>(
  results: T[],
  topK: number,
  slots: number = manuscriptSlots(topK)
): T[] {
  return selectWithOwnTextBands(results, topK, { manuscript: slots });
}
