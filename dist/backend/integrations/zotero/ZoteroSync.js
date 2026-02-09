import * as fs from 'fs';
import * as path from 'path';
import { ZoteroDiffEngine } from './ZoteroDiffEngine.js';
import { ZoteroSyncResolver } from './ZoteroSyncResolver.js';
export class ZoteroSync {
    constructor(api) {
        this.api = api;
        this.diffEngine = new ZoteroDiffEngine();
        this.resolver = new ZoteroSyncResolver();
    }
    /**
     * Synchronise une collection Zotero vers le projet local
     */
    async syncCollection(options) {
        const result = {
            collections: [],
            items: [],
            bibtexPath: '',
            pdfPaths: [],
            errors: [],
        };
        try {
            // 1. Créer le dossier de destination
            if (!fs.existsSync(options.targetDirectory)) {
                fs.mkdirSync(options.targetDirectory, { recursive: true });
            }
            // 2. Récupérer la collection (si spécifiée)
            if (options.collectionKey) {
                try {
                    const collection = await this.api.getCollection(options.collectionKey);
                    result.collections.push(collection);
                    console.log(`📚 Collection: ${collection.data.name}`);
                }
                catch (error) {
                    result.errors.push(`Failed to get collection: ${error}`);
                }
            }
            // 3. Récupérer les items
            try {
                const items = await this.api.listItems({
                    collectionKey: options.collectionKey,
                });
                result.items = items;
                // Count item types for debugging
                const typeCounts = {};
                items.forEach(item => {
                    const type = item.data.itemType;
                    typeCounts[type] = (typeCounts[type] || 0) + 1;
                });
                // Count bibliographic items (non-attachments, non-notes)
                const bibliographicItems = items.filter(item => item.data.itemType !== 'attachment' && item.data.itemType !== 'note');
                console.log(`📄 ${items.length} items trouvés (${bibliographicItems.length} bibliographiques)`);
                console.log('📊 Types d\'items:', typeCounts);
            }
            catch (error) {
                result.errors.push(`Failed to list items: ${error}`);
                return result;
            }
            // 4. Exporter en BibTeX
            if (options.exportBibTeX) {
                try {
                    const bibtexPath = path.join(options.targetDirectory, 'bibliography.bib');
                    const bibtexContent = options.collectionKey
                        ? await this.api.exportCollectionAsBibTeX(options.collectionKey)
                        : await this.api.exportAllAsBibTeX();
                    fs.writeFileSync(bibtexPath, bibtexContent, 'utf-8');
                    result.bibtexPath = bibtexPath;
                    console.log(`✅ BibTeX exporté: ${bibtexPath}`);
                }
                catch (error) {
                    result.errors.push(`Failed to export BibTeX: ${error}`);
                }
            }
            // 5. Télécharger les PDFs
            if (options.downloadPDFs) {
                const pdfDir = path.join(options.targetDirectory, 'pdfs');
                if (!fs.existsSync(pdfDir)) {
                    fs.mkdirSync(pdfDir, { recursive: true });
                }
                for (const item of result.items) {
                    try {
                        // Récupérer les attachments
                        const children = await this.api.getItemChildren(item.key);
                        const pdfAttachments = children.filter((child) => child.data.itemType === 'attachment' &&
                            child.data.contentType === 'application/pdf');
                        for (const attachment of pdfAttachments) {
                            try {
                                const filename = this.sanitizeFilename(attachment.data.filename || `${item.data.title}.pdf`);
                                const savePath = path.join(pdfDir, filename);
                                await this.api.downloadFile(attachment.key, savePath);
                                result.pdfPaths.push(savePath);
                                console.log(`📥 PDF téléchargé: ${filename}`);
                            }
                            catch (error) {
                                result.errors.push(`Failed to download PDF for ${item.data.title}: ${error}`);
                            }
                        }
                    }
                    catch (error) {
                        result.errors.push(`Failed to get attachments for ${item.data.title}: ${error}`);
                    }
                }
            }
            console.log(`\n✅ Sync terminé:`);
            console.log(`   - ${result.items.length} items`);
            console.log(`   - ${result.pdfPaths.length} PDFs`);
            console.log(`   - ${result.errors.length} erreurs`);
            return result;
        }
        catch (error) {
            result.errors.push(`Sync failed: ${error}`);
            return result;
        }
    }
    /**
     * Liste les collections disponibles
     */
    async listAvailableCollections() {
        try {
            return await this.api.listCollections();
        }
        catch (error) {
            console.error('Failed to list collections:', error);
            return [];
        }
    }
    /**
     * Obtient un résumé d'une collection
     */
    async getCollectionSummary(collectionKey) {
        try {
            const collection = await this.api.getCollection(collectionKey);
            const items = await this.api.listItems({ collectionKey });
            let pdfCount = 0;
            for (const item of items) {
                const children = await this.api.getItemChildren(item.key);
                const pdfs = children.filter((child) => child.data.itemType === 'attachment' &&
                    child.data.contentType === 'application/pdf');
                pdfCount += pdfs.length;
            }
            return {
                name: collection.data.name,
                itemCount: items.length,
                pdfCount,
            };
        }
        catch (error) {
            console.error('Failed to get collection summary:', error);
            throw error;
        }
    }
    /**
     * Enrichit les citations avec les informations sur les attachments Zotero
     * @param citations - Liste des citations à enrichir
     * @param items - Items Zotero correspondants
     */
    async enrichCitationsWithAttachments(citations, items) {
        const enrichedCitations = [];
        for (const citation of citations) {
            // Find corresponding Zotero item by matching title or BibTeX key
            const zoteroItem = items.find((item) => {
                const itemTitle = item.data.title?.toLowerCase();
                const citationTitle = citation.title?.toLowerCase();
                return itemTitle === citationTitle || item.key === citation.zoteroKey;
            });
            if (zoteroItem) {
                try {
                    // Get PDF attachments
                    const pdfAttachments = await this.api.getItemAttachments(zoteroItem.key);
                    const attachmentInfos = pdfAttachments.map((att) => ({
                        key: att.key,
                        filename: att.data.filename || 'unknown.pdf',
                        contentType: att.data.contentType || 'application/pdf',
                        downloaded: false, // Will be updated when PDF is downloaded
                        dateModified: att.data.dateModified,
                        md5: att.data.md5,
                    }));
                    enrichedCitations.push({
                        ...citation,
                        zoteroKey: zoteroItem.key,
                        zoteroAttachments: attachmentInfos,
                    });
                }
                catch (error) {
                    console.error(`Failed to get attachments for ${citation.title}:`, error);
                    enrichedCitations.push(citation);
                }
            }
            else {
                enrichedCitations.push(citation);
            }
        }
        return enrichedCitations;
    }
    /**
     * Télécharge un PDF depuis Zotero et met à jour la citation
     * @param citation - Citation contenant les infos Zotero
     * @param attachmentKey - Clé de l'attachment à télécharger
     * @param targetDirectory - Dossier de destination
     * @returns Chemin du fichier téléchargé
     */
    async downloadPDFForCitation(citation, attachmentKey, targetDirectory) {
        const pdfDir = path.join(targetDirectory, 'PDFs');
        if (!fs.existsSync(pdfDir)) {
            fs.mkdirSync(pdfDir, { recursive: true });
        }
        // Find attachment info
        const attachmentInfo = citation.zoteroAttachments?.find((att) => att.key === attachmentKey);
        if (!attachmentInfo) {
            throw new Error(`Attachment ${attachmentKey} not found in citation`);
        }
        // Sanitize filename
        const filename = this.sanitizeFilename(attachmentInfo.filename);
        const savePath = path.join(pdfDir, filename);
        // Download file
        await this.api.downloadFile(attachmentKey, savePath);
        console.log(`📥 PDF téléchargé: ${filename}`);
        return savePath;
    }
    /**
     * Vérifie les mises à jour disponibles depuis Zotero
     * Compare les citations locales avec celles de Zotero et détecte les différences
     */
    async checkForUpdates(localCitations, collectionKey) {
        try {
            // Récupérer les items depuis Zotero
            const remoteItems = await this.api.listItems({ collectionKey });
            // Filter bibliographic items only
            const bibliographicItems = remoteItems.filter((item) => item.data.itemType !== 'attachment' && item.data.itemType !== 'note');
            // Enrichir avec les attachments
            const enrichedItems = [];
            for (const item of bibliographicItems) {
                try {
                    const attachments = await this.api.getItemAttachments(item.key);
                    enrichedItems.push({
                        ...item,
                        data: {
                            ...item.data,
                            attachments,
                        },
                    });
                }
                catch (error) {
                    console.error(`Failed to get attachments for item ${item.key}:`, error);
                    enrichedItems.push(item);
                }
            }
            // Comparer avec les citations locales
            const diff = await this.diffEngine.detectChanges(localCitations, enrichedItems, {
                compareAttachments: true,
            });
            console.log('📊 Update check completed:');
            console.log(`   - Added: ${diff.added.length}`);
            console.log(`   - Modified: ${diff.modified.length}`);
            console.log(`   - Deleted: ${diff.deleted.length}`);
            console.log(`   - Unchanged: ${diff.unchanged.length}`);
            return diff;
        }
        catch (error) {
            console.error('Failed to check for updates:', error);
            throw error;
        }
    }
    /**
     * Applique les mises à jour de Zotero aux citations locales
     */
    async applyUpdates(currentCitations, diff, strategy, resolution) {
        try {
            // Create backup before applying changes
            const backup = this.resolver.createBackup(currentCitations);
            console.log('📦 Backup created');
            // Resolve conflicts and merge
            const result = await this.resolver.resolveConflicts(diff, currentCitations, strategy, resolution);
            // Generate report
            const report = this.resolver.generateSyncReport(result);
            console.log(report);
            return result;
        }
        catch (error) {
            console.error('Failed to apply updates:', error);
            throw error;
        }
    }
    /**
     * Synchronise complète: vérifie les mises à jour et les applique
     * Wrapper pratique pour un workflow complet
     */
    async updateFromZotero(localCitations, collectionKey, strategy = 'remote') {
        // 1. Vérifier les mises à jour
        const diff = await this.checkForUpdates(localCitations, collectionKey);
        // 2. Si pas de changements, retourner
        if (!this.diffEngine.hasChanges(diff)) {
            console.log('✅ No updates available');
            return {
                diff,
                result: {
                    finalCitations: localCitations,
                    addedCount: 0,
                    modifiedCount: 0,
                    deletedCount: 0,
                    skippedCount: 0,
                },
            };
        }
        // 3. Appliquer les mises à jour
        const result = await this.applyUpdates(localCitations, diff, strategy);
        return { diff, result };
    }
    /**
     * Nettoie un nom de fichier pour le système de fichiers
     */
    sanitizeFilename(filename) {
        return filename
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .substring(0, 200);
    }
}
