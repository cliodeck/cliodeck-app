import type { ZoteroItem } from '../../integrations/zotero/ZoteroAPI';

/**
 * Détection des œuvres en double dans une collection Zotero.
 *
 * L'application exporte fidèlement ce que Zotero contient : si la même
 * œuvre y a été saisie deux fois, elle sort deux fois. Mesuré sur une
 * collection réelle de 70 items : trois doublons — deux saisies d'un même
 * article, une même contribution enregistrée comme chapitre et comme
 * article, et un article dont une copie porte un titre abîmé par une
 * ligature (« In℡ligent »).
 *
 * On signale, on ne fusionne pas : c'est dans Zotero que la correction a
 * du sens, et deux notices proches peuvent être deux éditions distinctes.
 */

/** Ce qui a rapproché deux notices. */
export type DuplicateReason = 'doi' | 'title-year';

export interface DuplicateWork {
  reason: DuplicateReason;
  /** Titre de la première notice du groupe, pour l'affichage. */
  title: string;
  /** Clés Zotero du groupe (au moins deux). */
  keys: string[];
}

/** En deçà, un titre ne dit rien : on ne compare même pas. */
const MIN_TITLE_LENGTH = 8;

/**
 * Longueur à partir de laquelle un titre suffit à lui seul, faute de
 * créateur pour corroborer. « Introduction », « Préface » ou
 * « Avant-propos » se répètent d'un ouvrage à l'autre sans que ce soit la
 * même œuvre.
 */
const SELF_SUFFICIENT_TITLE_LENGTH = 16;

/**
 * Normalise un titre pour la comparaison : NFKD (qui rend « In℡ligent »
 * identique à « Intelligent »), sans diacritiques, sans ponctuation ni
 * espaces — les apostrophes droites et typographiques se confondent.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Normalise un DOI : casse, préfixe d'URL et espaces sont sans portée. */
export function normalizeDOI(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
}

function year(item: ZoteroItem): string {
  const match = item.data.date?.match(/\d{4}/);
  return match ? match[0] : '';
}

/** Patronyme du premier créateur, normalisé ; '' si la notice n'en a pas. */
function surname(item: ZoteroItem): string {
  const creator = item.data.creators?.[0];
  if (!creator) return '';
  if (creator.lastName) return normalizeTitle(creator.lastName);
  if (creator.name) {
    const parts = creator.name.trim().split(/\s+/);
    return normalizeTitle(parts[parts.length - 1]);
  }
  return '';
}

/**
 * Deux notices au titre identique désignent-elles la même œuvre ?
 *
 * Années incompatibles : non (deux éditions). Créateurs connus des deux
 * côtés : il faut qu'ils concordent — deux « Introduction » de plumes
 * différentes ne sont pas un doublon. Créateur manquant d'un côté : seul
 * un titre long fait indice.
 */
function mayBeSameWork(a: ZoteroItem, b: ZoteroItem, titleLength: number): boolean {
  const yearA = year(a);
  const yearB = year(b);
  if (yearA && yearB && yearA !== yearB) return false;

  const surnameA = surname(a);
  const surnameB = surname(b);
  if (surnameA && surnameB) return surnameA === surnameB;

  return titleLength >= SELF_SUFFICIENT_TITLE_LENGTH;
}

/** Union-find minimal : deux indices reliés appartiennent au même doublon. */
class Groups {
  private parent: number[];
  /**
   * Membres rapprochés par un DOI. On retient les membres, pas la racine :
   * une fusion ultérieure de deux groupes déplace la racine et perdrait
   * l'information.
   */
  private byDOI = new Set<number>();

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  union(a: number, b: number, viaDOI: boolean): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
    if (viaDOI) {
      this.byDOI.add(a);
      this.byDOI.add(b);
    }
  }

  /** Groupes d'au moins deux membres, avec l'origine du rapprochement. */
  components(): Array<{ members: number[]; viaDOI: boolean }> {
    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      const list = byRoot.get(root) ?? [];
      list.push(i);
      byRoot.set(root, list);
    }
    return [...byRoot.values()]
      .filter((members) => members.length > 1)
      .map((members) => ({ members, viaDOI: members.some((m) => this.byDOI.has(m)) }));
  }
}

/**
 * Repère les œuvres présentes plusieurs fois dans une liste d'items.
 *
 * Deux notices sont rapprochées si elles partagent un DOI, ou un titre
 * normalisé que le créateur et l'année corroborent (cf.
 * {@link mayBeSameWork}).
 */
export function findDuplicateWorks(items: ZoteroItem[]): DuplicateWork[] {
  const groups = new Groups(items.length);

  const byDOI = new Map<string, number>();
  const byTitle = new Map<string, number[]>();

  items.forEach((item, index) => {
    const doi = item.data.DOI ? normalizeDOI(item.data.DOI) : '';
    if (doi) {
      const seen = byDOI.get(doi);
      if (seen !== undefined) groups.union(seen, index, true);
      else byDOI.set(doi, index);
    }

    const title = normalizeTitle(item.data.title ?? '');
    if (title.length >= MIN_TITLE_LENGTH) {
      const seen = byTitle.get(title) ?? [];
      for (const other of seen) {
        if (mayBeSameWork(items[other], item, title.length)) groups.union(other, index, false);
      }
      seen.push(index);
      byTitle.set(title, seen);
    }
  });

  return groups.components().map(({ members, viaDOI }) => {
    const ordered = [...members].sort((a, b) => a - b);
    return {
      reason: viaDOI ? ('doi' as const) : ('title-year' as const),
      title: items[ordered[0]].data.title ?? '(sans titre)',
      keys: ordered.map((i) => items[i].key),
    };
  });
}
