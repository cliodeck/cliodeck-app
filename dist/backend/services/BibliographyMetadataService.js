import * as fs from 'fs';
import * as path from 'path';
/**
 * Service for persisting bibliography metadata that can't be stored in BibTeX
 *
 * This includes Zotero attachment information (keys, filenames, MD5 hashes, etc.)
 * which is needed to:
 * - Display PDF download buttons
 * - Show indexing status
 * - Detect modified PDFs
 */
export class BibliographyMetadataService {
    /**
     * Get the path to the metadata file for a project
     */
    static getMetadataPath(projectPath) {
        return path.join(projectPath, '.cliodeck', BibliographyMetadataService.METADATA_FILENAME);
    }
    /**
     * Save metadata for citations
     * Only saves metadata that can't be stored in BibTeX (zoteroAttachments, etc.)
     */
    static async saveMetadata(projectPath, citations) {
        const metadataPath = this.getMetadataPath(projectPath);
        const metadataDir = path.dirname(metadataPath);
        // Ensure .cliodeck directory exists
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }
        // Extract metadata from citations
        const citationMetadata = {};
        for (const citation of citations) {
            // Only save if there's metadata worth saving
            if (citation.zoteroKey || citation.zoteroAttachments?.length) {
                citationMetadata[citation.id] = {
                    id: citation.id,
                    zoteroKey: citation.zoteroKey,
                    zoteroAttachments: citation.zoteroAttachments,
                    dateAdded: citation.dateAdded,
                    dateModified: citation.dateModified,
                };
            }
        }
        const metadataFile = {
            version: this.CURRENT_VERSION,
            lastUpdated: new Date().toISOString(),
            citations: citationMetadata,
        };
        // Write atomically (write to temp, then rename)
        const tempPath = metadataPath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(metadataFile, null, 2), 'utf-8');
        fs.renameSync(tempPath, metadataPath);
        console.log(`✅ Bibliography metadata saved: ${Object.keys(citationMetadata).length} citations with metadata`);
    }
    /**
     * Load metadata from file
     */
    static async loadMetadata(projectPath) {
        const metadataPath = this.getMetadataPath(projectPath);
        if (!fs.existsSync(metadataPath)) {
            console.log('📂 No bibliography metadata file found');
            return null;
        }
        try {
            const content = fs.readFileSync(metadataPath, 'utf-8');
            const metadata = JSON.parse(content);
            // Handle version migration if needed
            if (metadata.version !== this.CURRENT_VERSION) {
                console.log(`⚠️ Metadata version mismatch: ${metadata.version} vs ${this.CURRENT_VERSION}`);
                // For now, just use it as-is. Add migration logic here if needed.
            }
            console.log(`✅ Bibliography metadata loaded: ${Object.keys(metadata.citations).length} entries`);
            return metadata;
        }
        catch (error) {
            console.error('❌ Failed to load bibliography metadata:', error);
            return null;
        }
    }
    /**
     * Merge metadata into citations
     * This is called when loading a bibliography to restore Zotero-specific data
     */
    static mergeCitationsWithMetadata(citations, metadata) {
        if (!metadata || !metadata.citations) {
            return citations;
        }
        let mergedCount = 0;
        const mergedCitations = citations.map(citation => {
            const citationMeta = metadata.citations[citation.id];
            if (citationMeta) {
                mergedCount++;
                return {
                    ...citation,
                    zoteroKey: citationMeta.zoteroKey || citation.zoteroKey,
                    zoteroAttachments: citationMeta.zoteroAttachments || citation.zoteroAttachments,
                    dateAdded: citationMeta.dateAdded || citation.dateAdded,
                    dateModified: citationMeta.dateModified || citation.dateModified,
                };
            }
            return citation;
        });
        console.log(`🔗 Merged metadata into ${mergedCount} citations`);
        return mergedCitations;
    }
    /**
     * Update metadata for specific citations (partial update)
     * Useful when downloading a single PDF
     */
    static async updateCitationMetadata(projectPath, citationId, updates) {
        const existingMetadata = await this.loadMetadata(projectPath);
        const metadata = existingMetadata || {
            version: this.CURRENT_VERSION,
            lastUpdated: new Date().toISOString(),
            citations: {},
        };
        // Merge updates
        metadata.citations[citationId] = {
            ...metadata.citations[citationId],
            id: citationId,
            ...updates,
        };
        metadata.lastUpdated = new Date().toISOString();
        // Save
        const metadataPath = this.getMetadataPath(projectPath);
        const metadataDir = path.dirname(metadataPath);
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }
        const tempPath = metadataPath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), 'utf-8');
        fs.renameSync(tempPath, metadataPath);
        console.log(`✅ Updated metadata for citation: ${citationId}`);
    }
    /**
     * Check if metadata file exists for a project
     */
    static hasMetadata(projectPath) {
        return fs.existsSync(this.getMetadataPath(projectPath));
    }
}
BibliographyMetadataService.METADATA_FILENAME = 'bibliography-metadata.json';
BibliographyMetadataService.CURRENT_VERSION = 1;
