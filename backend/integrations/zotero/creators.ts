import type { ZoteroItem } from './ZoteroAPI';

/**
 * Mise en forme BibTeX des créateurs d'un item Zotero.
 *
 * Partagée par les deux convertisseurs (export et diff) : ils en avaient
 * chacun une copie, et c'est de ce genre de doublon qu'était né
 * `author = {Unknown}` pour tout ouvrage dirigé. Un champ vide vaut mieux
 * qu'un faux nom : « Unknown » agrégeait des œuvres étrangères l'une à
 * l'autre.
 */

/**
 * Rôles qui tiennent lieu d'auteur, par type de notice, par ordre de
 * préférence. Le premier est le créateur principal du schéma Zotero
 * (`itemTypeCreatorTypes.primaryField`) ; les suivants sont les rôles que
 * les notices réelles utilisent à sa place. Mesuré : une vidéo YouTube dont
 * le créateur est saisi `director` alors que le schéma attend `creator`.
 *
 * Absent de la table : `author`, rôle principal de tous les autres types.
 * Ne lire que `author` faisait sortir sans aucun nom un entretien
 * (`interviewee`), une vidéo (`director`), un logiciel (`programmer`).
 */
const AUTHOR_ROLES: Record<string, readonly string[]> = {
  artwork: ['artist'],
  audioRecording: ['performer', 'composer', 'wordsBy'],
  bill: ['sponsor'],
  computerProgram: ['programmer'],
  film: ['director', 'scriptwriter', 'producer'],
  hearing: ['contributor'],
  interview: ['interviewee'],
  map: ['cartographer'],
  patent: ['inventor'],
  podcast: ['podcaster'],
  presentation: ['presenter'],
  radioBroadcast: ['creator', 'director'],
  tvBroadcast: ['director', 'creator'],
  videoRecording: ['creator', 'director'],
};

function format(creators: NonNullable<ZoteroItem['data']['creators']>): string {
  return creators
    .map((c) => {
      if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
      return c.name || c.lastName || '';
    })
    .filter(Boolean)
    .join(' and ');
}

/**
 * Créateurs d'un rôle donné, au format BibTeX (« Nom, Prénom and … »).
 *
 * `author` désigne le rôle qui tient lieu d'auteur pour ce type de notice
 * (cf. {@link AUTHOR_ROLES}) : le premier rôle de la liste présent dans la
 * notice l'emporte. `editor` désigne les directeurs d'ouvrage.
 */
export function formatCreators(item: ZoteroItem, role: 'author' | 'editor'): string {
  const creators = item.data.creators ?? [];

  if (role === 'editor') {
    return format(creators.filter((c) => c.creatorType === 'editor'));
  }

  const roles = AUTHOR_ROLES[item.data.itemType] ?? ['author'];
  for (const candidate of roles) {
    const matching = creators.filter((c) => c.creatorType === candidate);
    if (matching.length > 0) return format(matching);
  }
  // Un type absent de la table peut quand même porter des `author`.
  return format(creators.filter((c) => c.creatorType === 'author'));
}
