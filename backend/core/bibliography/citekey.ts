import type { ZoteroItem } from '../../integrations/zotero/ZoteroAPI';

/**
 * Fabrique unique des clés BibTeX pour les items Zotero.
 *
 * Elle a existé en trois exemplaires divergents (ZoteroLocalBibTeX,
 * ZoteroDiffEngine, zotero-service) : `${nomPremierAuteur}_${année}`, sans
 * contrôle d'unicité ni d'alphabet. Mesuré sur une collection réelle de
 * 70 items, cela produisait :
 *
 * - `Unknown_2022` porté par **trois œuvres sans rapport** — un ouvrage
 *   dirigé n'a pas de créateur `author`, seulement des `editor` ;
 * - `Hughes‐Warrington_2025` avec un U+2010 recopié depuis le nom :
 *   pandoc refuse alors le fichier **entier** (« unexpected '\8208' »), donc
 *   plus aucune citation ne se résout à l'export ;
 * - `Certeau(de)_2010`, dont la clé est tronquée à la parenthèse ;
 * - `Makhortykh_` quand l'item n'a pas de date.
 *
 * Règles :
 * 1. **ASCII strict** — `[A-Za-z0-9_:-]`, diacritiques translittérés, tirets
 *    typographiques ramenés à `-`. Une clé que pandoc refuse casse tout.
 * 2. **Repli en cascade** sur le libellé : auteur → n'importe quel créateur
 *    (editor, programmer, director…) → premier mot du titre → `Anon`.
 *    Jamais `Unknown`, qui agrège des œuvres étrangères l'une à l'autre.
 * 3. **Unicité garantie** par un suffixe `a`/`b`/`c` à la Chicago.
 * 4. **Stabilité** : les homonymes sont triés par `dateAdded` (immuable)
 *    puis par clé Zotero, donc un item ajouté plus tard prend la lettre
 *    suivante sans déplacer les clés déjà citées dans le manuscrit.
 */

/** Caractères acceptés dans une clé BibTeX lisible par pandoc. */
const ALLOWED = /[^A-Za-z0-9_:-]/g;

/** Une clé utilisable telle quelle dans `[@clef]`. */
const SAFE_KEY = /^[A-Za-z0-9_:-]+$/;

/** Tirets et traits d'union typographiques ramenés au tiret ASCII. */
const DASHES = /[‐‑‒–—―−]/g;

/** Marque d'absence de date, préférée à un `_` final orphelin. */
export const NO_DATE = 'nd';

/**
 * Translittère une chaîne en ASCII utilisable dans une clé BibTeX.
 * Retourne '' si rien d'exploitable ne subsiste.
 */
export function asciiFold(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // diacritiques décomposés
    .replace(DASHES, '-')
    .replace(/[‘’ʼ']/g, '') // apostrophes : O'Brien → OBrien
    .replace(/\s+/g, '')
    .replace(ALLOWED, '');
}

/** Extrait la première année d'une date Zotero (« 2024-03-12 », « mars 2024 »). */
export function extractYear(date: string | undefined): string {
  const match = date?.match(/\d{4}/);
  return match ? match[0] : '';
}

/**
 * Libellé d'un item : nom du premier créateur, quel que soit son rôle.
 * Un ouvrage dirigé n'a que des `editor` ; un logiciel, un `programmer`.
 */
function creatorLabel(item: ZoteroItem): string {
  const creators = item.data.creators ?? [];
  const preferred = creators.find((c) => c.creatorType === 'author') ?? creators[0];
  if (!preferred) return '';

  if (preferred.lastName) {
    // Le champ entier est le patronyme, particules comprises
    // (« Van Der Werf » → VanDerWerf). Les parenthèses sont retirées :
    // « Certeau (de) » donne Certeau, pas Certeaude.
    const cleaned = preferred.lastName.replace(/\([^)]*\)/g, ' ').trim();
    return asciiFold(cleaned || preferred.lastName);
  }

  if (preferred.name) {
    // Nom en un seul champ (« Atelier Ecopol ») : on garde le dernier mot,
    // qui fait office de patronyme dans l'usage bibliographique.
    const parts = preferred.name.trim().split(/\s+/);
    return asciiFold(parts[parts.length - 1]);
  }

  return '';
}

/** Repli ultime : le premier mot significatif du titre. */
function titleLabel(item: ZoteroItem): string {
  const title = item.data.title ?? '';
  const word = title.split(/[\s,:;.–—-]+/).find((w) => asciiFold(w).length > 2);
  return word ? asciiFold(word) : '';
}

/**
 * Clé de base, sans garantie d'unicité : `Libellé_Année`.
 * Exportée pour les tests et pour les appelants qui gèrent eux-mêmes
 * l'unicité via {@link uniqueCiteKey}.
 */
export function baseCiteKey(item: ZoteroItem): string {
  const label = creatorLabel(item) || titleLabel(item) || 'Anon';
  const year = extractYear(item.data.date) || NO_DATE;
  return `${label}_${year}`;
}

/**
 * Décline `base` jusqu'à trouver une clé libre : `Dupont_2024`,
 * `Dupont_2024a`, `Dupont_2024b`… `taken` est mis à jour au passage.
 *
 * Note : la première occurrence garde la clé nue. Suffixer tout le monde
 * (`2024a` dès qu'il y a un doublon) renommerait une référence déjà citée
 * dans le manuscrit le jour où un homonyme entre dans la collection.
 */
export function uniqueCiteKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  // a…z, puis aa, ab… : une collection ne dépasse jamais ça en pratique,
  // mais la boucle ne doit pas pouvoir sortir sans clé.
  for (let i = 0; ; i++) {
    const suffix = suffixFor(i);
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** 0 → 'a', 25 → 'z', 26 → 'aa' … */
function suffixFor(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Une clé existante peut-elle être reconduite telle quelle ?
 *
 * Non si pandoc la refuse, non si elle porte l'ancien repli `Unknown_` —
 * qui n'a jamais été un nom, seulement le marqueur d'un auteur non trouvé,
 * et que trois œuvres sans rapport pouvaient partager.
 */
export function isPreservableCiteKey(key: string | undefined): key is string {
  return !!key && SAFE_KEY.test(key) && !key.startsWith('Unknown_');
}

/**
 * Attribue une clé BibTeX unique à chaque item d'une liste.
 *
 * @param items items Zotero (bibliographiques : ni pièce jointe ni note)
 * @param taken clés déjà réservées (citations locales hors Zotero, autre
 *              collection…) ; enrichi par l'appel.
 * @param preserved clés déjà écrites dans le manuscrit, par `zoteroKey` :
 *              elles sont reconduites quand elles restent utilisables.
 *              Un réimport ne doit pas déplacer une citation en place —
 *              `[@Fickers_2022]` désignait le chapitre, il doit continuer,
 *              même si le livre du même directeur entre dans la collection.
 * @returns map `zoteroKey` → clé BibTeX
 */
export function assignCiteKeys(
  items: ZoteroItem[],
  taken: Set<string> = new Set(),
  preserved?: ReadonlyMap<string, string> | Readonly<Record<string, string>>
): Map<string, string> {
  // Tri par date d'ajout : un item entré plus tard dans la bibliothèque
  // prend le suffixe suivant, sans renommer ceux déjà cités.
  const ordered = [...items].sort((a, b) => {
    const da = a.data.dateAdded ?? '';
    const db = b.data.dateAdded ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const lookup = (zoteroKey: string): string | undefined =>
    preserved instanceof Map ? preserved.get(zoteroKey) : (preserved as Record<string, string>)?.[zoteroKey];

  const keys = new Map<string, string>();

  // Premier passage : les clés reconduites réservent leur place, sinon une
  // clé fraîchement calculée pourrait la leur prendre.
  for (const item of ordered) {
    const existing = preserved ? lookup(item.key) : undefined;
    if (isPreservableCiteKey(existing) && !taken.has(existing)) {
      taken.add(existing);
      keys.set(item.key, existing);
    }
  }

  for (const item of ordered) {
    if (keys.has(item.key)) continue;
    keys.set(item.key, uniqueCiteKey(baseCiteKey(item), taken));
  }

  return keys;
}
