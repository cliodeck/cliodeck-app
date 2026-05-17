import type { Citation } from '../../types/citation';
import type { CSLItem } from './CitationEngine';

/**
 * Map BibTeX entry types (from {@link Citation.type}) to CSL types.
 * Not exhaustive — covers the common humanities cases. Unknowns default to 'document'.
 */
const BIB_TO_CSL_TYPE: Record<string, string> = {
  article: 'article-journal',
  book: 'book',
  booklet: 'book',
  incollection: 'chapter',
  inbook: 'chapter',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  manual: 'book',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  misc: 'document',
  online: 'webpage',
  techreport: 'report',
  unpublished: 'manuscript',
};

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
  const cslType = BIB_TO_CSL_TYPE[c.type?.toLowerCase?.() ?? ''] ?? 'document';
  const item: CSLItem = {
    id: c.id,
    type: cslType,
  };
  if (c.title) item.title = c.title;
  if (c.author) item.author = parseBibTeXAuthors(c.author);
  if (c.year && /^\d{3,4}$/.test(c.year)) {
    item.issued = { 'date-parts': [[parseInt(c.year, 10)]] };
  } else if (c.year) {
    item.issued = { literal: c.year };
  }
  if (c.journal) item['container-title'] = c.journal;
  else if (c.booktitle) item['container-title'] = c.booktitle;
  if (c.publisher) item.publisher = c.publisher;
  if (c.customFields) {
    if (c.customFields.volume) item.volume = c.customFields.volume;
    if (c.customFields.issue || c.customFields.number) {
      item.issue = c.customFields.issue ?? c.customFields.number;
    }
    if (c.customFields.pages) item.page = c.customFields.pages;
    if (c.customFields.doi) item.DOI = c.customFields.doi;
    if (c.customFields.url) item.URL = c.customFields.url;
    if (c.customFields.address) item['publisher-place'] = c.customFields.address;
    if (c.customFields.isbn) item.ISBN = c.customFields.isbn;
  }
  return item;
}

/** Bulk conversion helper. */
export function citationsToCSL(list: Citation[]): CSLItem[] {
  return list.map(citationToCSL);
}
