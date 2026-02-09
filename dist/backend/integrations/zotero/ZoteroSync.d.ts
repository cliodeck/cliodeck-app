import { ZoteroAPI, ZoteroItem, ZoteroCollection } from './ZoteroAPI';
import { Citation } from '../../types/citation';
import { SyncDiff } from './ZoteroDiffEngine';
import { ConflictStrategy, SyncResolution, MergeResult } from './ZoteroSyncResolver';
export interface SyncResult {
    collections: ZoteroCollection[];
    items: ZoteroItem[];
    bibtexPath: string;
    pdfPaths: string[];
    errors: string[];
}
export interface SyncOptions {
    collectionKey?: string;
    downloadPDFs?: boolean;
    exportBibTeX?: boolean;
    targetDirectory: string;
}
export declare class ZoteroSync {
    private api;
    private diffEngine;
    private resolver;
    constructor(api: ZoteroAPI);
    /**
     * Synchronise une collection Zotero vers le projet local
     */
    syncCollection(options: SyncOptions): Promise<SyncResult>;
    /**
     * Liste les collections disponibles
     */
    listAvailableCollections(): Promise<ZoteroCollection[]>;
    /**
     * Obtient un résumé d'une collection
     */
    getCollectionSummary(collectionKey: string): Promise<{
        name: string;
        itemCount: number;
        pdfCount: number;
    }>;
    /**
     * Enrichit les citations avec les informations sur les attachments Zotero
     * @param citations - Liste des citations à enrichir
     * @param items - Items Zotero correspondants
     */
    enrichCitationsWithAttachments(citations: Citation[], items: ZoteroItem[]): Promise<Citation[]>;
    /**
     * Télécharge un PDF depuis Zotero et met à jour la citation
     * @param citation - Citation contenant les infos Zotero
     * @param attachmentKey - Clé de l'attachment à télécharger
     * @param targetDirectory - Dossier de destination
     * @returns Chemin du fichier téléchargé
     */
    downloadPDFForCitation(citation: Citation, attachmentKey: string, targetDirectory: string): Promise<string>;
    /**
     * Vérifie les mises à jour disponibles depuis Zotero
     * Compare les citations locales avec celles de Zotero et détecte les différences
     */
    checkForUpdates(localCitations: Citation[], collectionKey?: string): Promise<SyncDiff>;
    /**
     * Applique les mises à jour de Zotero aux citations locales
     */
    applyUpdates(currentCitations: Citation[], diff: SyncDiff, strategy: ConflictStrategy, resolution?: SyncResolution): Promise<MergeResult>;
    /**
     * Synchronise complète: vérifie les mises à jour et les applique
     * Wrapper pratique pour un workflow complet
     */
    updateFromZotero(localCitations: Citation[], collectionKey: string | undefined, strategy?: ConflictStrategy): Promise<{
        diff: SyncDiff;
        result: MergeResult;
    }>;
    /**
     * Nettoie un nom de fichier pour le système de fichiers
     */
    private sanitizeFilename;
}
