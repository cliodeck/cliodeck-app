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
 * bibliographie sature.
 *
 * **Une seule bande pour les deux** (décision de l'auteur du projet, le
 * 2026-10-28 : deux bandes de 20 % faisaient quatre places sur dix pour son
 * propre texte, trop). La voix de l'auteur, manuscrit et notes confondus,
 * obtient au plus la bande par défaut ; quand les deux corpus ont quelque
 * chose à dire et que la bande le permet, chacun garde au moins une place,
 * le reste se départage à la pertinence. Les largeurs par corpus
 * (`OwnTextBands`) restent les plafonds de chacun ; une largeur élargie par
 * l'appelant — question de rappel, portée « seul » — élargit d'autant la
 * bande commune, pour le corpus qu'on a nommé.
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
 * Largeur de la bande commune : la bande par défaut, élargie à la plus large
 * des bandes que l'appelant a lui-même élargies (une question de rappel sur
 * les notes porte la bande à six ; une portée « seul », à `topK`).
 */
export function sharedOwnTextSlots(topK: number, bands: OwnTextBands = {}): number {
  const base = manuscriptSlots(topK);
  const widened = OWN_TEXT_CORPORA.map((c) => bands[c] ?? 0).filter((b) => b > base);
  return Math.min(topK, Math.max(base, ...widened));
}

/**
 * Combine les résultats en accordant à la voix de l'auteur — manuscrit et
 * notes de lecture ensemble — une bande de places au plus, chaque corpus
 * restant sous son propre plafond ; les autres places vont aux extraits
 * externes, par pertinence décroissante.
 *
 * @param results Tous les extraits, tous corpus confondus.
 * @param topK Nombre de places disponibles.
 * @param bands Plafond par corpus (défaut : `manuscriptSlots(topK)` chacun).
 */
export function selectWithOwnTextBands<T extends Scored>(
  results: T[],
  topK: number,
  bands: OwnTextBands = {}
): T[] {
  if (topK <= 0) return [];

  const byScore = (a: T, b: T): number => b.similarity - a.similarity;
  const sharedCap = sharedOwnTextSlots(topK, bands);

  // Chaque corpus, sous son plafond, par pertinence.
  const pools = OWN_TEXT_CORPORA.map((corpus) => {
    const cap = Math.max(0, Math.min(bands[corpus] ?? manuscriptSlots(topK), topK));
    return results.filter((r) => r.sourceType === corpus).sort(byScore).slice(0, cap);
  }).filter((pool) => pool.length > 0);

  // Au moins une place par corpus présent quand la bande le permet, puis le
  // reste à la pertinence, tous corpus de l'auteur confondus.
  const picked: T[] = [];
  const floors = sharedCap >= pools.length;
  if (floors) for (const pool of pools) picked.push(pool[0]);
  const remaining = pools.flatMap((pool) => pool.slice(floors ? 1 : 0)).sort(byScore);
  for (const r of remaining) {
    if (picked.length >= sharedCap) break;
    picked.push(r);
  }
  const kept = picked.slice(0, sharedCap);

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
