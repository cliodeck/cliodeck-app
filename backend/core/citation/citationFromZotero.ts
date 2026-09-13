import type { Citation } from '../../types/citation';
import type { CSLItem } from './CitationEngine';

/**
 * Map BibTeX / BibLaTeX entry types (from {@link Citation.type}) to CSL types.
 * Aligné sur la lecture qu'en fait pandoc, pour que le moteur interne et
 * l'export par pandoc rendent une même entrée de la même façon.
 * Unknowns default to 'document'.
 */
const BIB_TO_CSL_TYPE: Record<string, string> = {
  article: 'article-journal',
  book: 'book',
  booklet: 'book',
  incollection: 'chapter',
  inbook: 'chapter',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  inreference: 'entry-encyclopedia',
  manual: 'book',
  thesis: 'thesis',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  report: 'report',
  techreport: 'report',
  unpublished: 'manuscript',
  letter: 'letter',
  misc: 'document',
  online: 'webpage',
  software: 'software',
  video: 'motion_picture',
  movie: 'motion_picture',
  audio: 'song',
  dataset: 'dataset',
  patent: 'patent',
  artwork: 'graphic',
};

/** `@article` + `entrysubtype` : presse et magazine ne sont pas des revues. */
const ARTICLE_SUBTYPES: Record<string, string> = {
  newspaper: 'article-newspaper',
  magazine: 'article-magazine',
};

/** Date BibLaTeX `AAAA[-MM[-JJ]]` → `date-parts` CSL. */
function dateParts(raw: string | undefined): number[] | undefined {
  const match = raw?.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!match) return undefined;
  return match.slice(1).filter(Boolean).map((part) => parseInt(part, 10));
}

/**
 * Parse a BibTeX author field ("Last, First and Last2, First2" or "First Last")
 * into CSL author objects.
 */
export function parseBibTeXAuthors(raw: string): Array<{ family?: string; given?: string; literal?: string }> {
  if (!raw) return [];
  return raw
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.includes(',')) {
        const [family, given] = name.split(',', 2).map((s) => s.trim());
        return { family, given };
      }
      const parts = name.split(/\s+/);
      if (parts.length === 1) return { literal: parts[0] };
      return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
    });
}

/**
 * Convert a ClioDeck {@link Citation} (BibTeX-derived) into a CSL-JSON item
 * consumable by {@link CitationEngine}.
 */
export function citationToCSL(c: Citation): CSLItem {
  const entryType = c.type?.toLowerCase?.() ?? '';
  const subtype = c.customFields?.entrysubtype?.toLowerCase();
  const cslType =
    (entryType === 'article' && subtype && ARTICLE_SUBTYPES[subtype]) ||
    BIB_TO_CSL_TYPE[entryType] ||
    'document';
  const item: CSLItem = {
    id: c.id,
    type: cslType,
  };
  if (c.title) item.title = c.title;
  // `title-short` alimente les notes abrégées des styles à notes : sans
  // lui, citeproc répète le titre entier à chaque rappel.
  if (c.shortTitle) item['title-short'] = c.shortTitle;
  if (c.author) item.author = parseBibTeXAuthors(c.author);
  // Un ouvrage dirigé n'a pas d'auteur : c'est `editor` qui porte les
  // noms, et le style CSL sait en tirer « (dir.) » ou « (ed.) ».
  if (c.editor) item.editor = parseBibTeXAuthors(c.editor);
  // Une date complète (article de presse, billet) l'emporte sur l'année.
  const fullDate = dateParts(c.customFields?.date);
  if (fullDate) {
    item.issued = { 'date-parts': [fullDate] };
  } else if (c.year && /^\d{3,4}$/.test(c.year)) {
    item.issued = { 'date-parts': [[parseInt(c.year, 10)]] };
  } else if (c.year) {
    item.issued = { literal: c.year };
  }
  if (c.journal) item['container-title'] = c.journal;
  else if (c.booktitle) item['container-title'] = c.booktitle;
  if (c.publisher) item.publisher = c.publisher;
  if (c.customFields) {
    if (c.customFields.volume) item.volume = c.customFields.volume;
    // `number` est le numéro d'un fascicule pour un périodique, mais le
    // numéro d'un rapport ou l'identifiant d'un preprint ailleurs.
    const periodical = entryType === 'article';
    if (c.customFields.issue || (periodical && c.customFields.number)) {
      item.issue = c.customFields.issue ?? c.customFields.number;
    } else if (c.customFields.number) {
      item.number = c.customFields.number;
    }
    if (c.customFields.type) item.genre = c.customFields.type;
    const accessed = dateParts(c.customFields.urldate);
    if (accessed) item.accessed = { 'date-parts': [accessed] };
    if (c.customFields.pages) item.page = c.customFields.pages;
    if (c.customFields.doi) item.DOI = c.customFields.doi;
    if (c.customFields.url) item.URL = c.customFields.url;
    const place = c.customFields.address ?? c.customFields.location;
    if (place) item['publisher-place'] = place;
    if (c.customFields.isbn) item.ISBN = c.customFields.isbn;
  }
  return item;
}

/** Bulk conversion helper. */
export function citationsToCSL(list: Citation[]): CSLItem[] {
  return list.map(citationToCSL);
}
