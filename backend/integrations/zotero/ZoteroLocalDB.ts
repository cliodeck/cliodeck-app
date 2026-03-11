// Zotero Local SQLite Database Reader
// Reads zotero.sqlite in read-only mode to extract items, collections, attachments

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { IZoteroDataSource, ZoteroLibraryInfo } from './IZoteroDataSource';
import { ZoteroItem, ZoteroAttachment, ZoteroCollection } from './ZoteroAPI';
import { ZoteroLocalBibTeX } from './ZoteroLocalBibTeX';

export interface ZoteroLocalConfig {
  dataDirectory: string;
  libraryID?: number;
}

export class ZoteroLocalDB implements IZoteroDataSource {
  private db: Database.Database | null = null;
  private config: ZoteroLocalConfig;
  private libraryID: number | undefined;
  private tempDbPath: string | null = null;

  constructor(config: ZoteroLocalConfig) {
    this.config = config;
    this.libraryID = config.libraryID; // undefined = all libraries
  }

  // MARK: - Connection management

  open(): void {
    if (this.db) return;
    const dbPath = path.join(this.config.dataDirectory, 'zotero.sqlite');
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Zotero database not found: ${dbPath}`);
    }

    // Copy to a temp file to avoid lock conflicts with a running Zotero.
    // This also copies the WAL file so we see the latest data.
    const tmpDir = os.tmpdir();
    const tempName = `cliodeck-zotero-${Date.now()}.sqlite`;
    this.tempDbPath = path.join(tmpDir, tempName);
    fs.copyFileSync(dbPath, this.tempDbPath);

    // Copy WAL file if it exists (contains uncommitted Zotero writes)
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, this.tempDbPath + '-wal');
    }

    this.db = new Database(this.tempDbPath, { readonly: true });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    // Clean up temp files
    if (this.tempDbPath) {
      try { fs.unlinkSync(this.tempDbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(this.tempDbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(this.tempDbPath + '-shm'); } catch { /* ignore */ }
      this.tempDbPath = null;
    }
  }

  private ensureOpen(): void {
    if (!this.db) {
      this.open();
    }
  }

  /** Returns a SQL WHERE clause fragment + params for filtering by libraryID (or empty if all libraries) */
  private libraryFilter(alias: string = 'i'): { clause: string; params: any[] } {
    if (this.libraryID !== undefined) {
      return { clause: `${alias}.libraryID = ?`, params: [this.libraryID] };
    }
    return { clause: '1=1', params: [] };
  }

  // MARK: - Libraries (local mode specific)

  /**
   * List all available libraries (personal + synced groups)
   */
  listLibraries(): ZoteroLibraryInfo[] {
    this.ensureOpen();
    const rows = this.db!.prepare(`
      SELECT l.libraryID, l.type, COALESCE(g.name, 'My Library') as name, g.groupID
      FROM libraries l
      LEFT JOIN groups g ON l.libraryID = g.libraryID
      WHERE l.type IN ('user', 'group')
      ORDER BY l.type ASC, g.name ASC
    `).all() as any[];

    return rows.map((row) => ({
      libraryID: row.libraryID,
      type: row.type as 'user' | 'group',
      name: row.name,
      groupID: row.groupID || undefined,
    }));
  }

  setLibrary(libraryID: number): void {
    this.libraryID = libraryID;
  }

  // MARK: - Collections

  async listCollections(): Promise<ZoteroCollection[]> {
    this.ensureOpen();

    if (this.libraryID !== undefined) {
      // Specific library selected
      const rows = this.db!.prepare(`
        SELECT c.collectionID, c.collectionName, c.key,
               pc.key as parentKey
        FROM collections c
        LEFT JOIN collections pc ON c.parentCollectionID = pc.collectionID
        WHERE c.libraryID = ?
        ORDER BY c.collectionName ASC
      `).all(this.libraryID) as any[];

      return rows.map((row) => ({
        key: row.key,
        version: 0,
        data: {
          key: row.key,
          version: 0,
          name: row.collectionName,
          parentCollection: row.parentKey || undefined,
        },
      }));
    }

    // No specific library: list collections from ALL libraries,
    // prefixing group names for disambiguation
    const rows = this.db!.prepare(`
      SELECT c.collectionID, c.collectionName, c.key,
             pc.key as parentKey,
             c.libraryID,
             l.type as libraryType,
             COALESCE(g.name, '') as groupName
      FROM collections c
      LEFT JOIN collections pc ON c.parentCollectionID = pc.collectionID
      LEFT JOIN libraries l ON c.libraryID = l.libraryID
      LEFT JOIN groups g ON c.libraryID = g.libraryID
      WHERE l.type IN ('user', 'group')
      ORDER BY l.type ASC, g.name ASC, c.collectionName ASC
    `).all() as any[];

    return rows.map((row) => {
      // Prefix group collections with the group name for clarity
      const prefix = row.libraryType === 'group' && row.groupName
        ? `[${row.groupName}] `
        : '';

      return {
        key: row.key,
        version: 0,
        data: {
          key: row.key,
          version: 0,
          name: prefix + row.collectionName,
          parentCollection: row.parentKey || undefined,
        },
      };
    });
  }

  async listSubcollections(collectionKey: string): Promise<ZoteroCollection[]> {
    const allCollections = await this.listCollections();
    return allCollections.filter((c) => c.data.parentCollection === collectionKey);
  }

  async getCollection(collectionKey: string): Promise<ZoteroCollection> {
    this.ensureOpen();
    const row = this.db!.prepare(`
      SELECT c.collectionID, c.collectionName, c.key,
             pc.key as parentKey
      FROM collections c
      LEFT JOIN collections pc ON c.parentCollectionID = pc.collectionID
      WHERE c.key = ?
    `).get(collectionKey) as any;

    if (!row) {
      throw new Error(`Collection not found: ${collectionKey}`);
    }

    return {
      key: row.key,
      version: 0,
      data: {
        key: row.key,
        version: 0,
        name: row.collectionName,
        parentCollection: row.parentKey || undefined,
      },
    };
  }

  // MARK: - Items

  async listItems(options?: {
    collectionKey?: string;
    limit?: number;
    start?: number;
    itemType?: string;
  }): Promise<ZoteroItem[]> {
    this.ensureOpen();

    // Resolve effective libraryID: use explicit setting, or derive from collection
    let effectiveLibraryID = this.libraryID;
    if (effectiveLibraryID === undefined && options?.collectionKey) {
      // Derive libraryID from the selected collection
      const colRow = this.db!.prepare(
        'SELECT libraryID FROM collections WHERE key = ?'
      ).get(options.collectionKey) as any;
      if (colRow) effectiveLibraryID = colRow.libraryID;
    }

    // Step 1: Get base items (with optional collection filter)
    let query: string;
    let params: any[];

    if (options?.collectionKey) {
      // Collection-scoped: the JOIN on collections already scopes the library
      query = `
        SELECT DISTINCT i.itemID, i.key, i.dateAdded, i.dateModified,
               it.typeName as itemType
        FROM items i
        JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
        JOIN collectionItems ci ON i.itemID = ci.itemID
        JOIN collections c ON ci.collectionID = c.collectionID
        WHERE c.key = ?
          AND it.typeName NOT IN ('attachment', 'note')
        ORDER BY i.dateAdded DESC
      `;
      params = [options.collectionKey];
    } else if (effectiveLibraryID !== undefined) {
      query = `
        SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
               it.typeName as itemType
        FROM items i
        JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
        WHERE i.libraryID = ?
          AND it.typeName NOT IN ('attachment', 'note')
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        ORDER BY i.dateAdded DESC
      `;
      params = [effectiveLibraryID];
    } else {
      // No library filter: all libraries
      query = `
        SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
               it.typeName as itemType
        FROM items i
        JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
        JOIN libraries l ON i.libraryID = l.libraryID
        WHERE l.type IN ('user', 'group')
          AND it.typeName NOT IN ('attachment', 'note')
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        ORDER BY i.dateAdded DESC
      `;
      params = [];
    }

    if (options?.itemType) {
      query = query.replace(
        'ORDER BY',
        `AND it.typeName = ? ORDER BY`
      );
      params.push(options.itemType);
    }

    if (options?.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options?.start) {
      query += ` OFFSET ?`;
      params.push(options.start);
    }

    const itemRows = this.db!.prepare(query).all(...params) as any[];

    if (itemRows.length === 0) {
      return [];
    }

    // Step 2: Batch fetch fields, creators, tags, collections for all items
    const itemIDs = itemRows.map((r) => r.itemID);
    const fieldsMap = this.batchFetchFields(itemIDs);
    const creatorsMap = this.batchFetchCreators(itemIDs);
    const tagsMap = this.batchFetchTags(itemIDs);
    const collectionsMap = this.batchFetchItemCollections(itemIDs);

    // Step 3: Build ZoteroItem objects
    return itemRows.map((row) => {
      const fields = fieldsMap.get(row.itemID) || {};
      const creators = creatorsMap.get(row.itemID) || [];
      const tags = tagsMap.get(row.itemID) || [];
      const collections = collectionsMap.get(row.itemID) || [];

      return {
        key: row.key,
        version: 0,
        library: {
          type: 'user',
          id: this.libraryID || 1,
          name: '',
        },
        data: {
          key: row.key,
          version: 0,
          itemType: row.itemType,
          title: fields['title'],
          creators: creators.map((c: any) => ({
            creatorType: c.creatorType,
            firstName: c.firstName || undefined,
            lastName: c.lastName || undefined,
            name: (!c.firstName && !c.lastName) ? 'Unknown' : undefined,
          })),
          date: fields['date'],
          publicationTitle: fields['publicationTitle'],
          publisher: fields['publisher'],
          DOI: fields['DOI'],
          ISBN: fields['ISBN'],
          url: fields['url'],
          abstractNote: fields['abstractNote'],
          tags: tags.map((t: string) => ({ tag: t })),
          collections,
          dateAdded: row.dateAdded,
          dateModified: row.dateModified,
        },
      } as ZoteroItem;
    });
  }

  async getItem(itemKey: string): Promise<ZoteroItem> {
    this.ensureOpen();
    const row = this.db!.prepare(`
      SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
             it.typeName as itemType
      FROM items i
      JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
      WHERE i.key = ?
    `).get(itemKey) as any;

    if (!row) {
      throw new Error(`Item not found: ${itemKey}`);
    }

    const fields = this.fetchItemFields(row.itemID);
    const creators = this.fetchItemCreators(row.itemID);
    const tags = this.fetchItemTags(row.itemID);
    const collections = this.fetchItemCollectionKeys(row.itemID);

    return {
      key: row.key,
      version: 0,
      library: {
        type: 'user',
        id: this.libraryID,
        name: '',
      },
      data: {
        key: row.key,
        version: 0,
        itemType: row.itemType,
        title: fields['title'],
        creators: creators.map((c: any) => ({
          creatorType: c.creatorType,
          firstName: c.firstName || undefined,
          lastName: c.lastName || undefined,
        })),
        date: fields['date'],
        publicationTitle: fields['publicationTitle'],
        publisher: fields['publisher'],
        DOI: fields['DOI'],
        ISBN: fields['ISBN'],
        url: fields['url'],
        abstractNote: fields['abstractNote'],
        tags: tags.map((t: string) => ({ tag: t })),
        collections,
        dateAdded: row.dateAdded,
        dateModified: row.dateModified,
      },
    } as ZoteroItem;
  }

  async getItemChildren(itemKey: string): Promise<ZoteroItem[]> {
    this.ensureOpen();

    // Get parent item ID
    const parent = this.db!.prepare(
      'SELECT itemID FROM items WHERE key = ?'
    ).get(itemKey) as any;

    if (!parent) return [];

    // Get child items (attachments + notes)
    const rows = this.db!.prepare(`
      SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
             it.typeName as itemType,
             ia.contentType, ia.path as attachmentPath, ia.linkMode,
             ia.charsetID
      FROM items i
      JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
      LEFT JOIN itemAttachments ia ON i.itemID = ia.itemID
      WHERE ia.parentItemID = ?
    `).all(parent.itemID) as any[];

    return rows.map((row) => {
      const fields = this.fetchItemFields(row.itemID);
      return {
        key: row.key,
        version: 0,
        library: {
          type: 'user',
          id: this.libraryID || 1,
          name: '',
        },
        data: {
          key: row.key,
          version: 0,
          itemType: row.itemType,
          linkMode: this.linkModeToString(row.linkMode),
          contentType: row.contentType,
          filename: row.attachmentPath ? row.attachmentPath.replace(/^storage:/, '') : undefined,
          path: row.attachmentPath,
          title: fields['title'],
          dateAdded: row.dateAdded,
          dateModified: row.dateModified,
        },
      } as any;
    });
  }

  // MARK: - Attachments

  async getItemAttachments(itemKey: string): Promise<ZoteroAttachment[]> {
    this.ensureOpen();

    const parent = this.db!.prepare(
      'SELECT itemID FROM items WHERE key = ?'
    ).get(itemKey) as any;

    if (!parent) return [];

    const rows = this.db!.prepare(`
      SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
             ia.contentType, ia.path, ia.linkMode
      FROM items i
      JOIN itemAttachments ia ON i.itemID = ia.itemID
      JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
      WHERE ia.parentItemID = ?
        AND it.typeName = 'attachment'
    `).all(parent.itemID) as any[];

    return rows.map((row) => {
      const fields = this.fetchItemFields(row.itemID);
      const filename = row.path ? row.path.replace(/^storage:/, '') : undefined;

      return {
        key: row.key,
        version: 0,
        data: {
          key: row.key,
          version: 0,
          itemType: 'attachment' as const,
          linkMode: this.linkModeToString(row.linkMode),
          contentType: row.contentType,
          filename,
          path: row.path,
          title: fields['title'] || filename,
          dateAdded: row.dateAdded,
          dateModified: row.dateModified,
        },
      };
    });
  }

  async hasAttachments(itemKey: string): Promise<boolean> {
    const attachments = await this.getItemAttachments(itemKey);
    return attachments.length > 0;
  }

  // MARK: - Export

  async exportCollectionAsBibTeX(collectionKey: string, includeSubcollections: boolean = true): Promise<string> {
    const bibtexHelper = new ZoteroLocalBibTeX(this.config.dataDirectory);

    // Try Better BibTeX first
    if (bibtexHelper.hasBetterBibTeX()) {
      try {
        // Get item keys for this collection
        const items = await this.listItems({ collectionKey });
        const itemKeys = items.map((i) => i.key);

        if (includeSubcollections) {
          const subcollections = await this.listSubcollections(collectionKey);
          for (const sub of subcollections) {
            const subItems = await this.listItems({ collectionKey: sub.key });
            itemKeys.push(...subItems.map((i) => i.key));
          }
        }

        const uniqueKeys = [...new Set(itemKeys)];
        if (uniqueKeys.length > 0) {
          const result = bibtexHelper.exportFromBBT(this.libraryID, uniqueKeys);
          if (result && result.trim().length > 0) {
            console.log(`📚 BibTeX exported via Better BibTeX (${uniqueKeys.length} items)`);
            return result;
          }
        }
      } catch (error) {
        console.warn('Better BibTeX export failed, falling back to generation:', error);
      }
    }

    // Fallback: generate from items
    let allItems = await this.listItems({ collectionKey });

    if (includeSubcollections) {
      const subcollections = await this.listSubcollections(collectionKey);
      for (const sub of subcollections) {
        const subItems = await this.listItems({ collectionKey: sub.key });
        allItems.push(...subItems);
      }
      // Deduplicate by key
      const seen = new Set<string>();
      allItems = allItems.filter((item) => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      });
    }

    console.log(`📚 Generating BibTeX from ${allItems.length} items`);
    return bibtexHelper.generateBibTeX(allItems);
  }

  async exportAllAsBibTeX(): Promise<string> {
    const bibtexHelper = new ZoteroLocalBibTeX(this.config.dataDirectory);

    // Try Better BibTeX first
    if (bibtexHelper.hasBetterBibTeX()) {
      try {
        const result = bibtexHelper.exportFromBBT(this.libraryID);
        if (result && result.trim().length > 0) {
          console.log(`📚 BibTeX exported via Better BibTeX (all items)`);
          return result;
        }
      } catch (error) {
        console.warn('Better BibTeX export failed, falling back to generation:', error);
      }
    }

    // Fallback
    const items = await this.listItems();
    console.log(`📚 Generating BibTeX from ${items.length} items`);
    return bibtexHelper.generateBibTeX(items);
  }

  // MARK: - Files

  async downloadFile(itemKey: string, savePath: string): Promise<{ filename: string; size: number }> {
    this.ensureOpen();

    const att = this.db!.prepare(`
      SELECT ia.path, ia.linkMode, i.key, ia.contentType
      FROM itemAttachments ia
      JOIN items i ON ia.itemID = i.itemID
      WHERE i.key = ?
    `).get(itemKey) as any;

    if (!att) {
      throw new Error(`Attachment not found: ${itemKey}`);
    }

    const linkMode = att.linkMode;

    // linkMode: 0=imported_file, 1=imported_url, 2=linked_file, 3=linked_url
    let sourcePath: string;
    let filename: string;

    if (linkMode === 2) {
      // linked_file: path is the absolute path to the file
      sourcePath = att.path;
      filename = path.basename(sourcePath);
    } else if (linkMode === 0 || linkMode === 1) {
      // imported_file or imported_url: file is in storage/<key>/
      filename = att.path ? att.path.replace(/^storage:/, '') : '';
      sourcePath = path.join(this.config.dataDirectory, 'storage', att.key, filename);
    } else {
      throw new Error(`Cannot copy linked_url attachment (linkMode=${linkMode})`);
    }

    if (!filename) {
      throw new Error(`No filename found for attachment: ${itemKey}`);
    }

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`File not found in Zotero storage: ${sourcePath}`);
    }

    // Ensure target directory exists
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Copy file
    fs.copyFileSync(sourcePath, savePath);
    const stats = fs.statSync(savePath);

    console.log(`📋 Copied from Zotero storage: ${filename} (${stats.size} bytes)`);

    return {
      filename,
      size: stats.size,
    };
  }

  // MARK: - Connection

  async testConnection(): Promise<boolean> {
    this.open();
    const result = this.db!.prepare('SELECT COUNT(*) as cnt FROM items').get() as any;
    return result.cnt >= 0;
  }

  // MARK: - Metadata helper

  getItemMetadata(item: ZoteroItem): {
    title: string;
    authors: string;
    year: string;
    type: string;
  } {
    const data = item.data;
    const title = data.title || 'Sans titre';

    const authors = data.creators
      ?.filter((c) => c.creatorType === 'author')
      .map((c) => {
        if (c.lastName && c.firstName) {
          return `${c.lastName}, ${c.firstName}`;
        }
        return c.name || c.lastName || '';
      })
      .join('; ');

    const year = data.date ? (data.date.match(/\d{4}/)?.[0] || '') : '';

    return {
      title,
      authors: authors || '',
      year,
      type: data.itemType,
    };
  }

  // MARK: - Private helpers: single-item queries

  private fetchItemFields(itemID: number): Record<string, string> {
    const rows = this.db!.prepare(`
      SELECT f.fieldName, idv.value
      FROM itemData id
      JOIN fields f ON id.fieldID = f.fieldID
      JOIN itemDataValues idv ON id.valueID = idv.valueID
      WHERE id.itemID = ?
    `).all(itemID) as any[];

    const fields: Record<string, string> = {};
    for (const row of rows) {
      fields[row.fieldName] = row.value;
    }
    return fields;
  }

  private fetchItemCreators(itemID: number): Array<{ firstName: string; lastName: string; creatorType: string }> {
    return this.db!.prepare(`
      SELECT c.firstName, c.lastName, ct.creatorType
      FROM itemCreators ic
      JOIN creators c ON ic.creatorID = c.creatorID
      JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
      WHERE ic.itemID = ?
      ORDER BY ic.orderIndex
    `).all(itemID) as any[];
  }

  private fetchItemTags(itemID: number): string[] {
    const rows = this.db!.prepare(`
      SELECT t.name
      FROM itemTags it
      JOIN tags t ON it.tagID = t.tagID
      WHERE it.itemID = ?
    `).all(itemID) as any[];

    return rows.map((r) => r.name);
  }

  private fetchItemCollectionKeys(itemID: number): string[] {
    const rows = this.db!.prepare(`
      SELECT c.key
      FROM collectionItems ci
      JOIN collections c ON ci.collectionID = c.collectionID
      WHERE ci.itemID = ?
    `).all(itemID) as any[];

    return rows.map((r) => r.key);
  }

  // MARK: - Private helpers: batch queries

  private batchFetchFields(itemIDs: number[]): Map<number, Record<string, string>> {
    const result = new Map<number, Record<string, string>>();
    if (itemIDs.length === 0) return result;

    // Process in chunks to avoid SQLite variable limits
    const chunkSize = 500;
    for (let i = 0; i < itemIDs.length; i += chunkSize) {
      const chunk = itemIDs.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      const rows = this.db!.prepare(`
        SELECT id.itemID, f.fieldName, idv.value
        FROM itemData id
        JOIN fields f ON id.fieldID = f.fieldID
        JOIN itemDataValues idv ON id.valueID = idv.valueID
        WHERE id.itemID IN (${placeholders})
      `).all(...chunk) as any[];

      for (const row of rows) {
        if (!result.has(row.itemID)) {
          result.set(row.itemID, {});
        }
        result.get(row.itemID)![row.fieldName] = row.value;
      }
    }

    return result;
  }

  private batchFetchCreators(itemIDs: number[]): Map<number, Array<{ firstName: string; lastName: string; creatorType: string }>> {
    const result = new Map<number, Array<any>>();
    if (itemIDs.length === 0) return result;

    const chunkSize = 500;
    for (let i = 0; i < itemIDs.length; i += chunkSize) {
      const chunk = itemIDs.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      const rows = this.db!.prepare(`
        SELECT ic.itemID, c.firstName, c.lastName, ct.creatorType
        FROM itemCreators ic
        JOIN creators c ON ic.creatorID = c.creatorID
        JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
        WHERE ic.itemID IN (${placeholders})
        ORDER BY ic.itemID, ic.orderIndex
      `).all(...chunk) as any[];

      for (const row of rows) {
        if (!result.has(row.itemID)) {
          result.set(row.itemID, []);
        }
        result.get(row.itemID)!.push({
          firstName: row.firstName,
          lastName: row.lastName,
          creatorType: row.creatorType,
        });
      }
    }

    return result;
  }

  private batchFetchTags(itemIDs: number[]): Map<number, string[]> {
    const result = new Map<number, string[]>();
    if (itemIDs.length === 0) return result;

    const chunkSize = 500;
    for (let i = 0; i < itemIDs.length; i += chunkSize) {
      const chunk = itemIDs.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      const rows = this.db!.prepare(`
        SELECT it.itemID, t.name
        FROM itemTags it
        JOIN tags t ON it.tagID = t.tagID
        WHERE it.itemID IN (${placeholders})
      `).all(...chunk) as any[];

      for (const row of rows) {
        if (!result.has(row.itemID)) {
          result.set(row.itemID, []);
        }
        result.get(row.itemID)!.push(row.name);
      }
    }

    return result;
  }

  private batchFetchItemCollections(itemIDs: number[]): Map<number, string[]> {
    const result = new Map<number, string[]>();
    if (itemIDs.length === 0) return result;

    const chunkSize = 500;
    for (let i = 0; i < itemIDs.length; i += chunkSize) {
      const chunk = itemIDs.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      const rows = this.db!.prepare(`
        SELECT ci.itemID, c.key
        FROM collectionItems ci
        JOIN collections c ON ci.collectionID = c.collectionID
        WHERE ci.itemID IN (${placeholders})
      `).all(...chunk) as any[];

      for (const row of rows) {
        if (!result.has(row.itemID)) {
          result.set(row.itemID, []);
        }
        result.get(row.itemID)!.push(row.key);
      }
    }

    return result;
  }

  // MARK: - Link mode conversion

  private linkModeToString(linkMode: number): string {
    switch (linkMode) {
      case 0: return 'imported_file';
      case 1: return 'imported_url';
      case 2: return 'linked_file';
      case 3: return 'linked_url';
      default: return 'imported_file';
    }
  }
}
