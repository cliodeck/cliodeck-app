// Zotero Web API v3 Client
// Documentation: https://www.zotero.org/support/dev/web_api/v3/start

import { IZoteroDataSource } from './IZoteroDataSource';

export interface ZoteroConfig {
  userId: string;
  apiKey: string;
  baseURL?: string;
  /** If set, use group library instead of user library */
  groupId?: string;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library: {
    type: string;
    id: number;
    name: string;
  };
  data: {
    key: string;
    version: number;
    itemType: string;
    title?: string;
    /** Titre court saisi dans Zotero (jamais un titre tronqué à la main). */
    shortTitle?: string;
    /** Titre de l'ouvrage pour un chapitre (`bookSection`). */
    bookTitle?: string;
    creators?: Array<{
      creatorType: string;
      firstName?: string;
      lastName?: string;
      name?: string;
    }>;
    date?: string;
    publicationTitle?: string;
    publisher?: string;
    DOI?: string;
    ISBN?: string;
    url?: string;
    abstractNote?: string;
    /** `type` 1 : tag automatique (posé par Zotero), 0 ou absent : manuel. */
    tags?: Array<{ tag: string; type?: number }>;
    collections?: string[];
    relations?: Record<string, unknown>;
    dateAdded?: string;
    dateModified?: string;
    attachments?: ZoteroAttachment[];
    /**
     * Tous les autres champs Zotero, sous leur nom propre au type de notice
     * (`blogTitle`, `websiteTitle`, `university`, `archiveID`, `pages`…).
     * L'API web les renvoie ainsi ; la base locale les expose de même.
     */
    [field: string]: unknown;
  };
}

export interface ZoteroAttachment {
  key: string;
  version: number;
  library?: {
    type: string;
    id: number;
    name: string;
  };
  data: {
    key: string;
    version: number;
    itemType: 'attachment';
    linkMode: string;
    contentType?: string;
    filename?: string;
    path?: string;
    title?: string;
    note?: string;
    tags?: Array<{ tag: string }>;
    dateAdded?: string;
    dateModified?: string;
    md5?: string;
    mtime?: number;
  };
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: {
    key: string;
    version: number;
    name: string;
    parentCollection?: string;
  };
}

export class ZoteroAPI implements IZoteroDataSource {
  private config: ZoteroConfig;
  private baseURL: string;

  constructor(config: ZoteroConfig) {
    this.config = config;
    this.baseURL = config.baseURL || 'https://api.zotero.org';
  }

  /**
   * Returns the library prefix for API calls
   * Uses /groups/{groupId} if groupId is set, otherwise /users/{userId}
   */
  private getLibraryPrefix(): string {
    if (this.config.groupId) {
      return `${this.baseURL}/groups/${this.config.groupId}`;
    }
    return `${this.baseURL}/users/${this.config.userId}`;
  }

  // MARK: - Collections

  /**
   * Liste toutes les collections de l'utilisateur (avec pagination)
   */
  async listCollections(): Promise<ZoteroCollection[]> {
    const allCollections: ZoteroCollection[] = [];
    const pageSize = 100; // Zotero max per request
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams();
      params.append('limit', pageSize.toString());
      params.append('start', start.toString());

      const url = `${this.getLibraryPrefix()}/collections?${params.toString()}`;

      const collections = (await this.makeRequest(url)) as ZoteroCollection[];
      allCollections.push(...collections);

      console.log(`📥 Fetched ${collections.length} collections (start: ${start}, total so far: ${allCollections.length})`);

      // Check if there are more collections
      if (collections.length < pageSize) {
        hasMore = false;
      } else {
        start += pageSize;
      }
    }

    return allCollections;
  }

  /**
   * Liste les sous-collections d'une collection
   */
  async listSubcollections(collectionKey: string): Promise<ZoteroCollection[]> {
    const allCollections = await this.listCollections();
    return allCollections.filter(c => c.data.parentCollection === collectionKey);
  }

  /**
   * Obtient une collection spécifique
   */
  async getCollection(collectionKey: string): Promise<ZoteroCollection> {
    const url = `${this.getLibraryPrefix()}/collections/${collectionKey}`;
    const response = await this.makeRequest(url);
    return response as ZoteroCollection;
  }

  // MARK: - Items

  /**
   * Liste tous les items de l'utilisateur
   */
  async listItems(options?: {
    collectionKey?: string;
    limit?: number;
    start?: number;
    itemType?: string;
  }): Promise<ZoteroItem[]> {
    const allItems: ZoteroItem[] = [];
    const pageSize = 100; // Zotero max per request
    let start = options?.start || 0;
    let hasMore = true;

    while (hasMore) {
      let url = options?.collectionKey
        ? `${this.getLibraryPrefix()}/collections/${options.collectionKey}/items`
        : `${this.getLibraryPrefix()}/items`;

      const params = new URLSearchParams();
      params.append('limit', pageSize.toString());
      params.append('start', start.toString());
      if (options?.itemType) params.append('itemType', options.itemType);

      url += `?${params.toString()}`;

      const items = (await this.makeRequest(url)) as ZoteroItem[];
      allItems.push(...items);

      console.log(`📥 Fetched ${items.length} items (start: ${start}, total so far: ${allItems.length})`);

      // Check if there are more items
      if (items.length < pageSize) {
        hasMore = false;
      } else {
        start += pageSize;
      }

      // If user specified a limit, stop when reached
      if (options?.limit && allItems.length >= options.limit) {
        hasMore = false;
        return allItems.slice(0, options.limit);
      }
    }

    return allItems;
  }

  /**
   * Obtient un item spécifique
   */
  async getItem(itemKey: string): Promise<ZoteroItem> {
    const url = `${this.getLibraryPrefix()}/items/${itemKey}`;
    console.log(`🔍 getItem URL: ${url}`);
    console.log(`   Config: userId=${this.config.userId}, groupId=${this.config.groupId || 'none'}`);
    const response = await this.makeRequest(url);
    return response as ZoteroItem;
  }

  /**
   * Liste les enfants d'un item (attachements, notes)
   */
  async getItemChildren(itemKey: string): Promise<ZoteroItem[]> {
    const url = `${this.getLibraryPrefix()}/items/${itemKey}/children`;
    const response = await this.makeRequest(url);
    return response as ZoteroItem[];
  }

  async getItemNotes(itemKey: string): Promise<Array<{ key: string; note: string }>> {
    const children = await this.getItemChildren(itemKey);
    return children
      .filter((child) => child.data.itemType === 'note' && typeof child.data.note === 'string')
      .map((child) => ({ key: child.key, note: child.data.note as string }));
  }

  // MARK: - Export

  /**
   * Récupère les attachments PDF d'un item
   */
  async getItemAttachments(itemKey: string): Promise<ZoteroAttachment[]> {
    const children = await this.getItemChildren(itemKey);

    // Filter only PDF attachments and cast to ZoteroAttachment
    const attachments = children.filter((child) => {
      return child.data.itemType === 'attachment';
    }) as ZoteroAttachment[];

    // Log attachment info for debugging
    for (const att of attachments) {
      console.log(`📎 Attachment: key=${att.key}, linkMode=${att.data.linkMode}, filename=${att.data.filename}`);
    }

    return attachments;
  }

  /**
   * Vérifie si un item a des PDFs attachés
   */
  async hasAttachments(itemKey: string): Promise<boolean> {
    const attachments = await this.getItemAttachments(itemKey);
    return attachments.length > 0;
  }

  /**
   * Télécharge un fichier attaché (PDF)
   * @param itemKey - Clé de l'attachment (pas de l'item parent)
   * @param savePath - Chemin où sauvegarder le fichier
   * @returns Métadonnées du fichier téléchargé
   */
  async downloadFile(
    itemKey: string,
    savePath: string
  ): Promise<{ filename: string; size: number }> {
    // First, get attachment info to check linkMode
    const attachmentInfo = await this.getItem(itemKey);
    const linkMode = (attachmentInfo.data as any).linkMode;
    console.log(`📎 Attachment ${itemKey} linkMode: ${linkMode}`);

    // Only imported_file and imported_url can be downloaded via API
    if (linkMode === 'linked_file') {
      throw new Error(`Cannot download linked_file attachment via API. File is only available locally at: ${(attachmentInfo.data as any).path}`);
    }
    if (linkMode === 'linked_url') {
      throw new Error(`Cannot download linked_url attachment via API. URL: ${(attachmentInfo.data as any).url}`);
    }

    const url = `${this.getLibraryPrefix()}/items/${itemKey}/file`;
    console.log(`📥 Downloading from: ${url}`);

    const response = await fetch(url, {
      headers: {
        'Zotero-API-Key': this.config.apiKey,
      },
    });

    if (!response.ok) {
      console.error(`❌ Download failed: ${response.status} ${response.statusText}`);
      console.error(`   URL: ${url}`);
      console.error(`   Attachment linkMode: ${linkMode}`);
      throw new Error(`Zotero API error: ${response.status} ${response.statusText}`);
    }

    const fs = await import('fs');
    const path = await import('path');

    // Get filename from Content-Disposition header or use default
    const contentDisposition = response.headers.get('content-disposition');
    let filename = 'document.pdf';

    if (contentDisposition) {
      const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match && match[1]) {
        filename = match[1].replace(/['"]/g, '');
      }
    }

    // Ensure directory exists
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(savePath, Buffer.from(buffer));

    return {
      filename,
      size: buffer.byteLength,
    };
  }

  // MARK: - Request Helper

  private async makeRequest(
    url: string,
    options?: { headers?: Record<string, string> }
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'Zotero-API-Key': this.config.apiKey,
      'Zotero-API-Version': '3',
      ...options?.headers,
    };

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Zotero API error: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    // Si on demande du texte brut (BibTeX)
    if (headers.Accept === 'text/plain') {
      return await response.text();
    }

    // Sinon, JSON
    return await response.json();
  }

  // MARK: - Helpers

  /**
   * Teste la connexion à l'API Zotero
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.listCollections();
      return true;
    } catch (error) {
      console.error('Zotero connection failed:', error);
      return false;
    }
  }

  /**
   * Obtient les métadonnées de base d'un item
   */
  getItemMetadata(item: ZoteroItem): {
    title: string;
    authors: string;
    year: string;
    type: string;
  } {
    const data = item.data;

    // Titre
    const title = data.title || 'Sans titre';

    // Auteurs
    const authors = data.creators
      ?.filter((c) => c.creatorType === 'author')
      .map((c) => {
        if (c.lastName && c.firstName) {
          return `${c.lastName}, ${c.firstName}`;
        }
        return c.name || c.lastName || '';
      })
      .join('; ');

    // Année
    const year = data.date ? this.extractYear(data.date) : '';

    return {
      title,
      authors: authors || '',
      year,
      type: data.itemType,
    };
  }

  private extractYear(dateString: string): string {
    const match = dateString.match(/\d{4}/);
    return match ? match[0] : '';
  }
}
