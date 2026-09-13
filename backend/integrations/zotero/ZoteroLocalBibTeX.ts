// BibTeX generation from Zotero local SQLite database
// Detects Better BibTeX and uses its cache when available

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ZoteroItem } from './ZoteroAPI';
import { BibTeXExporter } from '../../core/bibliography/BibTeXExporter';
import { assignCiteKeys } from '../../core/bibliography/citekey';
import { zoteroItemToCitation } from './toCitation';

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
   *
   * Les clés sont attribuées en un seul passage sur la liste : c'est la
   * seule façon de garantir leur unicité (cf. {@link assignCiteKeys}).
   */
  generateBibTeX(items: ZoteroItem[], preservedKeys?: Readonly<Record<string, string>>): string {
    const keys = assignCiteKeys(items, new Set(), preservedKeys);
    const citations = items.map((item) => zoteroItemToCitation(item, keys.get(item.key)!));
    const exporter = new BibTeXExporter();
    return exporter.exportToString(citations);
  }
}
