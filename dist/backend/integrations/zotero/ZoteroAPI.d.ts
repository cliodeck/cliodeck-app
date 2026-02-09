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
        tags?: Array<{
            tag: string;
        }>;
        collections?: string[];
        relations?: Record<string, unknown>;
        dateAdded?: string;
        dateModified?: string;
        attachments?: ZoteroAttachment[];
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
        tags?: Array<{
            tag: string;
        }>;
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
export declare class ZoteroAPI {
    private config;
    private baseURL;
    constructor(config: ZoteroConfig);
    /**
     * Returns the library prefix for API calls
     * Uses /groups/{groupId} if groupId is set, otherwise /users/{userId}
     */
    private getLibraryPrefix;
    /**
     * Liste toutes les collections de l'utilisateur (avec pagination)
     */
    listCollections(): Promise<ZoteroCollection[]>;
    /**
     * Liste les sous-collections d'une collection
     */
    listSubcollections(collectionKey: string): Promise<ZoteroCollection[]>;
    /**
     * Obtient une collection spécifique
     */
    getCollection(collectionKey: string): Promise<ZoteroCollection>;
    /**
     * Liste tous les items de l'utilisateur
     */
    listItems(options?: {
        collectionKey?: string;
        limit?: number;
        start?: number;
        itemType?: string;
    }): Promise<ZoteroItem[]>;
    /**
     * Obtient un item spécifique
     */
    getItem(itemKey: string): Promise<ZoteroItem>;
    /**
     * Liste les enfants d'un item (attachements, notes)
     */
    getItemChildren(itemKey: string): Promise<ZoteroItem[]>;
    /**
     * Exporte une collection en BibTeX (inclut récursivement les sous-collections)
     * Déduplique les entrées pour éviter les doublons quand un item est dans plusieurs collections
     */
    exportCollectionAsBibTeX(collectionKey: string, includeSubcollections?: boolean): Promise<string>;
    /**
     * Exporte une seule collection (sans sous-collections)
     */
    private exportSingleCollectionAsBibTeX;
    /**
     * Exporte tous les items en BibTeX
     */
    exportAllAsBibTeX(): Promise<string>;
    /**
     * Récupère les attachments PDF d'un item
     */
    getItemAttachments(itemKey: string): Promise<ZoteroAttachment[]>;
    /**
     * Vérifie si un item a des PDFs attachés
     */
    hasAttachments(itemKey: string): Promise<boolean>;
    /**
     * Télécharge un fichier attaché (PDF)
     * @param itemKey - Clé de l'attachment (pas de l'item parent)
     * @param savePath - Chemin où sauvegarder le fichier
     * @returns Métadonnées du fichier téléchargé
     */
    downloadFile(itemKey: string, savePath: string): Promise<{
        filename: string;
        size: number;
    }>;
    private makeRequest;
    /**
     * Teste la connexion à l'API Zotero
     */
    testConnection(): Promise<boolean>;
    /**
     * Obtient les métadonnées de base d'un item
     */
    getItemMetadata(item: ZoteroItem): {
        title: string;
        authors: string;
        year: string;
        type: string;
    };
    private extractYear;
}
