// Shared interface for Zotero data access (Web API or local SQLite)

import { ZoteroItem, ZoteroAttachment, ZoteroCollection } from './ZoteroAPI';

export interface ZoteroLibraryInfo {
  libraryID: number;
  type: 'user' | 'group';
  name: string;
  groupID?: number;
}

export interface IZoteroDataSource {
  // Collections
  listCollections(): Promise<ZoteroCollection[]>;
  listSubcollections(collectionKey: string): Promise<ZoteroCollection[]>;
  getCollection(collectionKey: string): Promise<ZoteroCollection>;

  // Items
  listItems(options?: {
    collectionKey?: string;
    limit?: number;
    start?: number;
    itemType?: string;
  }): Promise<ZoteroItem[]>;
  getItem(itemKey: string): Promise<ZoteroItem>;
  getItemChildren(itemKey: string): Promise<ZoteroItem[]>;

  // Attachments
  getItemAttachments(itemKey: string): Promise<ZoteroAttachment[]>;
  hasAttachments(itemKey: string): Promise<boolean>;

  // Export
  /**
   * @param preservedKeys clés BibTeX déjà écrites dans le manuscrit, par
   *   `zoteroKey` : elles sont reconduites quand elles restent valides, pour
   *   qu'un réimport ne déplace pas une citation en place. Ignoré par les
   *   sources qui ne fabriquent pas les clés (l'API Zotero les reçoit du
   *   serveur).
   */
  exportCollectionAsBibTeX(
    collectionKey: string,
    includeSubcollections?: boolean,
    preservedKeys?: Readonly<Record<string, string>>
  ): Promise<string>;
  exportAllAsBibTeX(): Promise<string>;

  // Files
  downloadFile(itemKey: string, savePath: string): Promise<{ filename: string; size: number }>;

  // Connection / health
  testConnection(): Promise<boolean>;

  // Metadata helper
  getItemMetadata(item: ZoteroItem): {
    title: string;
    authors: string;
    year: string;
    type: string;
  };
}
