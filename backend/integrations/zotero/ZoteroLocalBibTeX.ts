// BibTeX generation from Zotero local SQLite database
// Detects Better BibTeX and uses its cache when available

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ZoteroItem } from './ZoteroAPI';
import { createCitation } from '../../types/citation';
import { BibTeXExporter } from '../../core/bibliography/BibTeXExporter';

export class ZoteroLocalBibTeX {
  private dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = dataDirectory;
  }

  /**
   * Check if Better BibTeX addon is installed
   */
  hasBetterBibTeX(): boolean {
    const bbtDbPath = path.join(this.dataDirectory, 'better-bibtex-search.sqlite');
    return fs.existsSync(bbtDbPath);
  }

  /**
   * Export BibTeX from Better BibTeX cache
   * BBT stores cached BibTeX entries with stable citation keys
   */
  exportFromBBT(libraryID: number | undefined, itemKeys?: string[]): string {
    const bbtDbPath = path.join(this.dataDirectory, 'better-bibtex-search.sqlite');
    if (!fs.existsSync(bbtDbPath)) {
      throw new Error('Better BibTeX database not found');
    }

    const bbtDb = new Database(bbtDbPath, { readonly: true });
    try {
      // BBT stores entries in the 'cache' table with bibtex field
      const tableCheck = bbtDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cache'"
      ).get();

      if (!tableCheck) {
        throw new Error('Better BibTeX cache table not found');
      }

      let rows: any[];
      if (itemKeys && itemKeys.length > 0) {
        const placeholders = itemKeys.map(() => '?').join(',');
        if (libraryID !== undefined) {
          rows = bbtDb.prepare(
            `SELECT itemKey, entry FROM cache WHERE libraryID = ? AND itemKey IN (${placeholders})`
          ).all(libraryID, ...itemKeys);
        } else {
          rows = bbtDb.prepare(
            `SELECT itemKey, entry FROM cache WHERE itemKey IN (${placeholders})`
          ).all(...itemKeys);
        }
      } else if (libraryID !== undefined) {
        rows = bbtDb.prepare(
          'SELECT itemKey, entry FROM cache WHERE libraryID = ?'
        ).all(libraryID);
      } else {
        rows = bbtDb.prepare(
          'SELECT itemKey, entry FROM cache'
        ).all();
      }

      if (rows.length === 0) {
        throw new Error('No BibTeX entries found in Better BibTeX cache');
      }

      return rows.map((row: any) => row.entry).join('\n\n');
    } finally {
      bbtDb.close();
    }
  }

  /**
   * Generate BibTeX from ZoteroItem array using BibTeXExporter
   */
  generateBibTeX(items: ZoteroItem[]): string {
    const citations = items.map((item) => this.zoteroItemToCitation(item));
    const exporter = new BibTeXExporter();
    return exporter.exportToString(citations);
  }

  /**
   * Convert a ZoteroItem to a Citation for BibTeX export
   * Mirrors ZoteroDiffEngine.zoteroItemToCitation logic
   */
  private zoteroItemToCitation(item: ZoteroItem) {
    const data = item.data;

    const authors = data.creators
      ?.filter((c) => c.creatorType === 'author')
      .map((c) => {
        if (c.lastName && c.firstName) {
          return `${c.lastName}, ${c.firstName}`;
        } else if (c.name) {
          return c.name;
        } else if (c.lastName) {
          return c.lastName;
        }
        return 'Unknown';
      })
      .join(' and ') || 'Unknown';

    const year = data.date ? this.extractYear(data.date) : '';

    const firstAuthor = authors.split(' and ')[0].split(',')[0].trim();
    const bibtexKey = `${firstAuthor.replace(/\s+/g, '')}_${year}`;

    return createCitation({
      id: bibtexKey,
      type: this.mapZoteroTypeToRef(data.itemType),
      author: authors,
      year,
      title: data.title || 'Untitled',
      shortTitle: data.title && data.title.length > 50 ? data.title.substring(0, 47) + '...' : undefined,
      journal: data.publicationTitle,
      publisher: data.publisher,
      booktitle: (data as any).bookTitle,
      zoteroKey: item.key,
      tags: data.tags?.map((t) => t.tag),
    });
  }

  private extractYear(dateString: string): string {
    const yearMatch = dateString.match(/\d{4}/);
    return yearMatch ? yearMatch[0] : '';
  }

  private mapZoteroTypeToRef(zoteroType: string): string {
    const mapping: Record<string, string> = {
      journalArticle: 'article',
      book: 'book',
      bookSection: 'incollection',
      conferencePaper: 'inproceedings',
      thesis: 'phdthesis',
      report: 'techreport',
      manuscript: 'unpublished',
      webpage: 'misc',
      document: 'misc',
    };
    return mapping[zoteroType] || 'misc';
  }
}
