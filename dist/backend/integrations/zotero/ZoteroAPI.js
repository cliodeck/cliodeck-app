// Zotero Web API v3 Client
// Documentation: https://www.zotero.org/support/dev/web_api/v3/start
export class ZoteroAPI {
    constructor(config) {
        this.config = config;
        this.baseURL = config.baseURL || 'https://api.zotero.org';
    }
    /**
     * Returns the library prefix for API calls
     * Uses /groups/{groupId} if groupId is set, otherwise /users/{userId}
     */
    getLibraryPrefix() {
        if (this.config.groupId) {
            return `${this.baseURL}/groups/${this.config.groupId}`;
        }
        return `${this.baseURL}/users/${this.config.userId}`;
    }
    // MARK: - Collections
    /**
     * Liste toutes les collections de l'utilisateur (avec pagination)
     */
    async listCollections() {
        const allCollections = [];
        const pageSize = 100; // Zotero max per request
        let start = 0;
        let hasMore = true;
        while (hasMore) {
            const params = new URLSearchParams();
            params.append('limit', pageSize.toString());
            params.append('start', start.toString());
            const url = `${this.getLibraryPrefix()}/collections?${params.toString()}`;
            const collections = (await this.makeRequest(url));
            allCollections.push(...collections);
            console.log(`📥 Fetched ${collections.length} collections (start: ${start}, total so far: ${allCollections.length})`);
            // Check if there are more collections
            if (collections.length < pageSize) {
                hasMore = false;
            }
            else {
                start += pageSize;
            }
        }
        return allCollections;
    }
    /**
     * Liste les sous-collections d'une collection
     */
    async listSubcollections(collectionKey) {
        const allCollections = await this.listCollections();
        return allCollections.filter(c => c.data.parentCollection === collectionKey);
    }
    /**
     * Obtient une collection spécifique
     */
    async getCollection(collectionKey) {
        const url = `${this.getLibraryPrefix()}/collections/${collectionKey}`;
        const response = await this.makeRequest(url);
        return response;
    }
    // MARK: - Items
    /**
     * Liste tous les items de l'utilisateur
     */
    async listItems(options) {
        const allItems = [];
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
            if (options?.itemType)
                params.append('itemType', options.itemType);
            url += `?${params.toString()}`;
            const items = (await this.makeRequest(url));
            allItems.push(...items);
            console.log(`📥 Fetched ${items.length} items (start: ${start}, total so far: ${allItems.length})`);
            // Check if there are more items
            if (items.length < pageSize) {
                hasMore = false;
            }
            else {
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
    async getItem(itemKey) {
        const url = `${this.getLibraryPrefix()}/items/${itemKey}`;
        console.log(`🔍 getItem URL: ${url}`);
        console.log(`   Config: userId=${this.config.userId}, groupId=${this.config.groupId || 'none'}`);
        const response = await this.makeRequest(url);
        return response;
    }
    /**
     * Liste les enfants d'un item (attachements, notes)
     */
    async getItemChildren(itemKey) {
        const url = `${this.getLibraryPrefix()}/items/${itemKey}/children`;
        const response = await this.makeRequest(url);
        return response;
    }
    // MARK: - Export
    /**
     * Exporte une collection en BibTeX (inclut récursivement les sous-collections)
     * Déduplique les entrées pour éviter les doublons quand un item est dans plusieurs collections
     */
    async exportCollectionAsBibTeX(collectionKey, includeSubcollections = true) {
        // Use a Map to store unique entries by their BibTeX key
        const uniqueEntries = new Map();
        // Helper function to extract entries from BibTeX string and add to map
        const addEntriesToMap = (bibtex) => {
            // Split by @ to get individual entries
            const entries = bibtex.split(/(?=@\w+\{)/);
            for (const entry of entries) {
                const trimmed = entry.trim();
                if (!trimmed || !trimmed.startsWith('@'))
                    continue;
                // Extract the BibTeX key (e.g., @article{smith2020, -> smith2020)
                const keyMatch = trimmed.match(/@\w+\{([^,]+),/);
                if (keyMatch && keyMatch[1]) {
                    const bibKey = keyMatch[1].trim();
                    // Only add if not already present (keep first occurrence)
                    if (!uniqueEntries.has(bibKey)) {
                        uniqueEntries.set(bibKey, trimmed);
                    }
                }
            }
        };
        // Export main collection
        const mainBibTeX = await this.exportSingleCollectionAsBibTeX(collectionKey);
        addEntriesToMap(mainBibTeX);
        console.log(`📚 Collection principale: ${uniqueEntries.size} entrées uniques`);
        // Export subcollections if requested
        if (includeSubcollections) {
            const subcollections = await this.listSubcollections(collectionKey);
            console.log(`🔍 ${subcollections.length} sous-collections trouvées`);
            for (const subcol of subcollections) {
                const beforeCount = uniqueEntries.size;
                const subBibTeX = await this.exportCollectionAsBibTeX(subcol.key, true); // Recursive
                // Parse and add entries (deduplication happens in addEntriesToMap)
                addEntriesToMap(subBibTeX);
                const newEntries = uniqueEntries.size - beforeCount;
                console.log(`  📁 Sous-collection "${subcol.data.name}": ${newEntries} nouvelles entrées`);
            }
        }
        console.log(`📚 Total BibTeX entries (deduplicated): ${uniqueEntries.size}`);
        return Array.from(uniqueEntries.values()).join('\n\n');
    }
    /**
     * Exporte une seule collection (sans sous-collections)
     */
    async exportSingleCollectionAsBibTeX(collectionKey) {
        const allBibTeX = [];
        const pageSize = 100; // Zotero max per request
        let start = 0;
        let hasMore = true;
        while (hasMore) {
            const params = new URLSearchParams();
            params.append('format', 'bibtex');
            params.append('limit', pageSize.toString());
            params.append('start', start.toString());
            const url = `${this.getLibraryPrefix()}/collections/${collectionKey}/items?${params.toString()}`;
            const response = await this.makeRequest(url, { headers: { Accept: 'text/plain' } });
            const bibtex = response;
            // Count entries in this chunk
            const entryCount = (bibtex.match(/@\w+\{/g) || []).length;
            // Only add if we got content
            if (bibtex && bibtex.trim().length > 0 && entryCount > 0) {
                allBibTeX.push(bibtex);
            }
            // Stop if we got no entries (empty response)
            if (entryCount === 0) {
                hasMore = false;
            }
            else {
                // Continue to next page
                start += pageSize;
            }
        }
        return allBibTeX.join('\n\n');
    }
    /**
     * Exporte tous les items en BibTeX
     */
    async exportAllAsBibTeX() {
        const allBibTeX = [];
        const pageSize = 100; // Zotero max per request
        let start = 0;
        let hasMore = true;
        let totalEntries = 0;
        while (hasMore) {
            const params = new URLSearchParams();
            params.append('format', 'bibtex');
            params.append('limit', pageSize.toString());
            params.append('start', start.toString());
            const url = `${this.getLibraryPrefix()}/items?${params.toString()}`;
            const response = await this.makeRequest(url, { headers: { Accept: 'text/plain' } });
            const bibtex = response;
            // Count entries in this chunk
            const entryCount = (bibtex.match(/@\w+\{/g) || []).length;
            console.log(`📥 Fetched BibTeX chunk (start: ${start}, entries: ${entryCount})`);
            // Only add if we got content
            if (bibtex && bibtex.trim().length > 0 && entryCount > 0) {
                allBibTeX.push(bibtex);
                totalEntries += entryCount;
            }
            // Stop if we got no entries (empty response)
            if (entryCount === 0) {
                hasMore = false;
            }
            else {
                // Continue to next page
                start += pageSize;
            }
        }
        console.log(`📚 Total BibTeX entries fetched: ${totalEntries}`);
        return allBibTeX.join('\n\n');
    }
    // MARK: - Files
    /**
     * Récupère les attachments PDF d'un item
     */
    async getItemAttachments(itemKey) {
        const children = await this.getItemChildren(itemKey);
        // Filter only PDF attachments and cast to ZoteroAttachment
        const attachments = children.filter((child) => {
            return child.data.itemType === 'attachment';
        });
        // Log attachment info for debugging
        for (const att of attachments) {
            console.log(`📎 Attachment: key=${att.key}, linkMode=${att.data.linkMode}, filename=${att.data.filename}`);
        }
        return attachments;
    }
    /**
     * Vérifie si un item a des PDFs attachés
     */
    async hasAttachments(itemKey) {
        const attachments = await this.getItemAttachments(itemKey);
        return attachments.length > 0;
    }
    /**
     * Télécharge un fichier attaché (PDF)
     * @param itemKey - Clé de l'attachment (pas de l'item parent)
     * @param savePath - Chemin où sauvegarder le fichier
     * @returns Métadonnées du fichier téléchargé
     */
    async downloadFile(itemKey, savePath) {
        // First, get attachment info to check linkMode
        const attachmentInfo = await this.getItem(itemKey);
        const linkMode = attachmentInfo.data.linkMode;
        console.log(`📎 Attachment ${itemKey} linkMode: ${linkMode}`);
        // Only imported_file and imported_url can be downloaded via API
        if (linkMode === 'linked_file') {
            throw new Error(`Cannot download linked_file attachment via API. File is only available locally at: ${attachmentInfo.data.path}`);
        }
        if (linkMode === 'linked_url') {
            throw new Error(`Cannot download linked_url attachment via API. URL: ${attachmentInfo.data.url}`);
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
    async makeRequest(url, options) {
        const headers = {
            'Zotero-API-Key': this.config.apiKey,
            'Zotero-API-Version': '3',
            ...options?.headers,
        };
        const response = await fetch(url, { headers });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Zotero API error: ${response.status} ${response.statusText}\n${errorText}`);
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
    async testConnection() {
        try {
            await this.listCollections();
            return true;
        }
        catch (error) {
            console.error('Zotero connection failed:', error);
            return false;
        }
    }
    /**
     * Obtient les métadonnées de base d'un item
     */
    getItemMetadata(item) {
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
    extractYear(dateString) {
        const match = dateString.match(/\d{4}/);
        return match ? match[0] : '';
    }
}
