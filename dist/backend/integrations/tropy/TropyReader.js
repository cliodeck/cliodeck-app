import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
// MARK: - TropyReader
/**
 * Lecteur de projets Tropy (.tropy package ou .tpy)
 * IMPORTANT: Ce lecteur ouvre les fichiers en mode LECTURE SEULE.
 * Il ne modifie JAMAIS le fichier .tpy.
 *
 * Supports two formats:
 * - .tropy package: A folder with .tropy extension containing project.tpy and assets/
 * - .tpy file: Direct SQLite database file
 */
export class TropyReader {
    constructor() {
        this.db = null;
        this.tpyPath = null;
        this.packagePath = null; // Path to .tropy package if applicable
        this.assetsPath = null; // Path to assets folder if in package
    }
    /**
     * Ouvre un projet Tropy (.tropy package ou .tpy) en mode lecture seule
     * @param projectPath Chemin vers le fichier .tropy ou .tpy
     * @throws Error si le fichier n'existe pas
     */
    openProject(projectPath) {
        if (!fs.existsSync(projectPath)) {
            throw new Error(`Tropy project not found: ${projectPath}`);
        }
        let tpyPath;
        // Check if it's a .tropy package (directory with .tropy extension)
        const stats = fs.statSync(projectPath);
        if (stats.isDirectory() && projectPath.endsWith('.tropy')) {
            // It's a .tropy package
            this.packagePath = projectPath;
            tpyPath = path.join(projectPath, 'project.tpy');
            this.assetsPath = path.join(projectPath, 'assets');
            if (!fs.existsSync(tpyPath)) {
                throw new Error(`project.tpy not found inside .tropy package: ${projectPath}`);
            }
            console.log(`📦 Opening Tropy package: ${projectPath}`);
            console.log(`   Database: ${tpyPath}`);
            console.log(`   Assets: ${this.assetsPath}`);
        }
        else if (projectPath.endsWith('.tpy')) {
            // It's a direct .tpy file
            tpyPath = projectPath;
            this.packagePath = null;
            this.assetsPath = null;
            console.log(`📄 Opening Tropy database: ${tpyPath}`);
        }
        else {
            throw new Error(`Invalid Tropy project path: ${projectPath}. Expected .tropy or .tpy`);
        }
        // IMPORTANT: Mode lecture seule - ne jamais modifier le fichier .tpy
        this.db = new Database(tpyPath, { readonly: true });
        this.tpyPath = tpyPath;
    }
    /**
     * Returns the path to the .tropy package, if applicable
     */
    getPackagePath() {
        return this.packagePath;
    }
    /**
     * Returns the path to the assets folder, if in a package
     */
    getAssetsPath() {
        return this.assetsPath;
    }
    /**
     * Resolves a photo path to an absolute path
     * Handles both absolute paths and relative paths within the package
     */
    resolvePhotoPath(photoPath) {
        // If it's already an absolute path and exists, return it
        if (path.isAbsolute(photoPath) && fs.existsSync(photoPath)) {
            return photoPath;
        }
        // If we have an assets folder, try to resolve relative to it
        if (this.assetsPath) {
            // Photo paths in Tropy packages are often stored as relative paths
            // or as paths relative to the assets folder
            const possiblePaths = [
                path.join(this.assetsPath, photoPath),
                path.join(this.assetsPath, path.basename(photoPath)),
                path.join(this.packagePath, photoPath),
            ];
            for (const possiblePath of possiblePaths) {
                if (fs.existsSync(possiblePath)) {
                    return possiblePath;
                }
            }
        }
        // If we have a tpy path, try relative to its directory
        if (this.tpyPath) {
            const tpyDir = path.dirname(this.tpyPath);
            const relativePath = path.join(tpyDir, photoPath);
            if (fs.existsSync(relativePath)) {
                return relativePath;
            }
        }
        // Return the original path as fallback
        return photoPath;
    }
    /**
     * Ferme le projet
     */
    closeProject() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.tpyPath = null;
        }
    }
    /**
     * Vérifie si un projet est ouvert
     */
    isOpen() {
        return this.db !== null;
    }
    /**
     * Retourne le chemin du projet ouvert
     */
    getProjectPath() {
        return this.tpyPath;
    }
    /**
     * Lit le nom du projet
     */
    getProjectName() {
        if (!this.db)
            throw new Error('No project opened');
        try {
            const result = this.db.prepare('SELECT name FROM project LIMIT 1').get();
            return result?.name || 'Unnamed Project';
        }
        catch {
            return 'Unnamed Project';
        }
    }
    /**
     * Retourne la date de dernière modification du fichier .tpy
     * Utilisé par le watcher pour détecter les changements
     */
    getLastModifiedTime() {
        if (!this.tpyPath)
            throw new Error('No project opened');
        const stats = fs.statSync(this.tpyPath);
        return stats.mtime;
    }
    /**
     * Returns the original project path (either .tropy package or .tpy file)
     */
    getOriginalProjectPath() {
        return this.packagePath || this.tpyPath;
    }
    /**
     * Retourne les informations générales du projet
     */
    getProjectInfo() {
        if (!this.db || !this.tpyPath)
            throw new Error('No project opened');
        return {
            name: this.getProjectName(),
            itemCount: this.getItemCount(),
            lastModified: this.getLastModifiedTime(),
        };
    }
    /**
     * Retourne le nombre d'items dans le projet
     */
    getItemCount() {
        if (!this.db)
            throw new Error('No project opened');
        try {
            const result = this.db.prepare('SELECT COUNT(*) as count FROM items').get();
            return result.count;
        }
        catch {
            return 0;
        }
    }
    /**
     * Liste tous les items du projet
     */
    listItems() {
        if (!this.db)
            throw new Error('No project opened');
        const items = [];
        try {
            // Join items with subjects to get template info
            const itemRows = this.db
                .prepare(`
          SELECT i.id, s.template, s.type
          FROM items i
          LEFT JOIN subjects s ON i.id = s.id
        `)
                .all();
            for (const itemRow of itemRows) {
                const item = {
                    id: itemRow.id,
                    template: itemRow.template || 'https://tropy.org/v1/templates/generic',
                    type: itemRow.type || undefined,
                    tags: [],
                    notes: [],
                    photos: [],
                };
                // Récupérer les métadonnées (title, date, creator, etc.)
                const metadata = this.getItemMetadata(itemRow.id);
                Object.assign(item, metadata);
                // Récupérer les tags
                item.tags = this.getItemTags(itemRow.id);
                // Récupérer les notes
                item.notes = this.getItemNotes(itemRow.id);
                // Récupérer les photos
                item.photos = this.getItemPhotos(itemRow.id);
                items.push(item);
            }
            return items;
        }
        catch (error) {
            console.error('Failed to list items:', error);
            return [];
        }
    }
    /**
     * Récupère un item par son ID
     */
    getItem(itemId) {
        if (!this.db)
            throw new Error('No project opened');
        try {
            const itemRow = this.db
                .prepare(`
          SELECT i.id, s.template, s.type
          FROM items i
          LEFT JOIN subjects s ON i.id = s.id
          WHERE i.id = ?
        `)
                .get(itemId);
            if (!itemRow)
                return null;
            const item = {
                id: itemRow.id,
                template: itemRow.template || 'https://tropy.org/v1/templates/generic',
                type: itemRow.type || undefined,
                tags: [],
                notes: [],
                photos: [],
            };
            const metadata = this.getItemMetadata(itemRow.id);
            Object.assign(item, metadata);
            item.tags = this.getItemTags(itemRow.id);
            item.notes = this.getItemNotes(itemRow.id);
            item.photos = this.getItemPhotos(itemRow.id);
            return item;
        }
        catch (error) {
            console.error('Failed to get item:', error);
            return null;
        }
    }
    /**
     * Extrait tout le texte d'un item (notes de l'item + notes des photos)
     * Utile pour l'indexation sans OCR
     */
    extractItemText(item) {
        const textParts = [];
        // Titre et métadonnées
        if (item.title)
            textParts.push(item.title);
        if (item.creator)
            textParts.push(`Créateur: ${item.creator}`);
        if (item.date)
            textParts.push(`Date: ${item.date}`);
        if (item.archive)
            textParts.push(`Archive: ${item.archive}`);
        if (item.collection)
            textParts.push(`Collection: ${item.collection}`);
        // Notes de l'item
        for (const note of item.notes) {
            if (note.text)
                textParts.push(note.text);
        }
        // Notes des photos et sélections
        for (const photo of item.photos) {
            for (const note of photo.notes) {
                if (note.text)
                    textParts.push(note.text);
            }
            for (const selection of photo.selections) {
                for (const note of selection.notes) {
                    if (note.text)
                        textParts.push(note.text);
                }
            }
        }
        return textParts.join('\n\n');
    }
    /**
     * Extrait SEULEMENT les notes (transcriptions) d'un item, sans les métadonnées
     * Utilisé pour déterminer si un item a des transcriptions réelles
     */
    extractItemNotesOnly(item) {
        const textParts = [];
        // Notes de l'item uniquement
        for (const note of item.notes) {
            if (note.text && note.text.trim()) {
                textParts.push(note.text.trim());
            }
        }
        // Notes des photos et sélections
        for (const photo of item.photos) {
            for (const note of photo.notes) {
                if (note.text && note.text.trim()) {
                    textParts.push(note.text.trim());
                }
            }
            for (const selection of photo.selections) {
                for (const note of selection.notes) {
                    if (note.text && note.text.trim()) {
                        textParts.push(note.text.trim());
                    }
                }
            }
        }
        return textParts.join('\n\n');
    }
    /**
     * Compte le nombre de notes (transcriptions) dans un item
     */
    countItemNotes(item) {
        const itemNotes = item.notes?.filter(n => n.text && n.text.trim()).length || 0;
        let photoNotes = 0;
        let selectionNotes = 0;
        for (const photo of item.photos || []) {
            photoNotes += photo.notes?.filter(n => n.text && n.text.trim()).length || 0;
            for (const selection of photo.selections || []) {
                selectionNotes += selection.notes?.filter(n => n.text && n.text.trim()).length || 0;
            }
        }
        return {
            itemNotes,
            photoNotes,
            selectionNotes,
            total: itemNotes + photoNotes + selectionNotes,
        };
    }
    /**
     * Liste toutes les photos du projet avec leurs chemins
     * Utile pour vérifier quelles photos existent et lesquelles nécessitent OCR
     */
    listAllPhotos() {
        if (!this.db)
            throw new Error('No project opened');
        const photos = [];
        try {
            // Join with images table to get width/height
            const photoRows = this.db
                .prepare(`
          SELECT p.id, p.item_id, p.path, p.filename, p.mimetype, i.width, i.height
          FROM photos p
          LEFT JOIN images i ON p.id = i.id
        `)
                .all();
            for (const row of photoRows) {
                // Resolve the photo path (handles package structure)
                const resolvedPath = this.resolvePhotoPath(row.path);
                const photo = {
                    id: row.id,
                    path: resolvedPath,
                    filename: row.filename || path.basename(row.path),
                    width: row.width,
                    height: row.height,
                    mimetype: row.mimetype,
                    notes: this.getPhotoNotes(row.id),
                    selections: this.getPhotoSelections(row.id),
                };
                photos.push({ itemId: row.item_id, photo });
            }
            return photos;
        }
        catch (error) {
            console.error('Failed to list photos:', error);
            return [];
        }
    }
    /**
     * Récupère tous les tags uniques du projet
     */
    getAllTags() {
        if (!this.db)
            throw new Error('No project opened');
        try {
            const tagRows = this.db.prepare('SELECT name FROM tags ORDER BY name').all();
            return tagRows.map((row) => row.name);
        }
        catch {
            return [];
        }
    }
    // MARK: - Private Methods
    getItemMetadata(itemId) {
        if (!this.db)
            return {};
        try {
            // Tropy stores metadata with value_id referencing metadata_values table
            const metadataRows = this.db
                .prepare(`
          SELECT m.property, mv.text as value
          FROM metadata m
          JOIN metadata_values mv ON m.value_id = mv.value_id
          WHERE m.id = ?
        `)
                .all(itemId);
            const metadata = {};
            for (const row of metadataRows) {
                const propertyName = this.extractPropertyName(row.property);
                if (propertyName && row.value) {
                    metadata[propertyName] = row.value;
                }
            }
            return metadata;
        }
        catch (error) {
            console.warn(`Failed to get metadata for item ${itemId}:`, error);
            return {};
        }
    }
    /**
     * Récupère toutes les métadonnées brutes d'un item (pour debug)
     */
    getAllItemMetadataRaw(itemId) {
        if (!this.db)
            return [];
        try {
            return this.db
                .prepare(`
          SELECT m.property, mv.text as value
          FROM metadata m
          JOIN metadata_values mv ON m.value_id = mv.value_id
          WHERE m.id = ?
        `)
                .all(itemId);
        }
        catch {
            return [];
        }
    }
    extractPropertyName(propertyURI) {
        // Extraire le nom de la propriété depuis l'URI
        // Ex: "http://purl.org/dc/elements/1.1/title" → "title"
        const match = propertyURI.match(/[/#]([^/#]+)$/);
        return match ? match[1] : null;
    }
    getItemTags(itemId) {
        if (!this.db)
            return [];
        try {
            // taggings links subjects (items) to tags via tag_id and id
            const tagRows = this.db
                .prepare(`
          SELECT t.name
          FROM tags t
          JOIN taggings tg ON t.tag_id = tg.tag_id
          WHERE tg.id = ?
        `)
                .all(itemId);
            return tagRows.map((row) => row.name);
        }
        catch {
            return [];
        }
    }
    getItemNotes(itemId) {
        if (!this.db)
            return [];
        try {
            // Notes reference subjects via the 'id' column (not a separate column per type)
            // state column contains the HTML/JSON representation
            const noteRows = this.db
                .prepare('SELECT note_id, text, state FROM notes WHERE id = ? AND deleted IS NULL')
                .all(itemId);
            return noteRows.map((row) => ({
                id: row.note_id,
                html: row.state || '',
                text: row.text || '',
            }));
        }
        catch {
            return [];
        }
    }
    getItemPhotos(itemId) {
        if (!this.db)
            return [];
        try {
            // Join with images table to get width/height
            const photoRows = this.db
                .prepare(`
          SELECT p.id, p.path, p.filename, p.mimetype, i.width, i.height
          FROM photos p
          LEFT JOIN images i ON p.id = i.id
          WHERE p.item_id = ?
          ORDER BY p.position
        `)
                .all(itemId);
            return photoRows.map((row) => {
                // Resolve the photo path (handles package structure)
                const resolvedPath = this.resolvePhotoPath(row.path);
                const photo = {
                    id: row.id,
                    path: resolvedPath,
                    filename: row.filename || path.basename(row.path),
                    width: row.width,
                    height: row.height,
                    mimetype: row.mimetype,
                    notes: this.getPhotoNotes(row.id),
                    selections: this.getPhotoSelections(row.id),
                };
                return photo;
            });
        }
        catch {
            return [];
        }
    }
    getPhotoNotes(photoId) {
        if (!this.db)
            return [];
        try {
            // Notes reference subjects via the 'id' column (photos are subjects too)
            const noteRows = this.db
                .prepare('SELECT note_id, text, state FROM notes WHERE id = ? AND deleted IS NULL')
                .all(photoId);
            return noteRows.map((row) => ({
                id: row.note_id,
                html: row.state || '',
                text: row.text || '',
            }));
        }
        catch {
            return [];
        }
    }
    getPhotoSelections(photoId) {
        if (!this.db)
            return [];
        try {
            // Selections only have id, photo_id, x, y, position
            // Width/height/angle are stored in subjects or images tables
            const selectionRows = this.db
                .prepare(`
          SELECT s.id, s.x, s.y,
                 COALESCE(i.width, 100) as width,
                 COALESCE(i.height, 100) as height,
                 COALESCE(i.angle, 0) as angle
          FROM selections s
          LEFT JOIN images i ON s.id = i.id
          WHERE s.photo_id = ?
        `)
                .all(photoId);
            return selectionRows.map((row) => ({
                id: row.id,
                x: row.x || 0,
                y: row.y || 0,
                width: row.width || 100,
                height: row.height || 100,
                angle: row.angle || 0,
                notes: this.getSelectionNotes(row.id),
            }));
        }
        catch {
            return [];
        }
    }
    getSelectionNotes(selectionId) {
        if (!this.db)
            return [];
        try {
            // Notes reference subjects via the 'id' column (selections are subjects too)
            const noteRows = this.db
                .prepare('SELECT note_id, text, state FROM notes WHERE id = ? AND deleted IS NULL')
                .all(selectionId);
            return noteRows.map((row) => ({
                id: row.note_id,
                html: row.state || '',
                text: row.text || '',
            }));
        }
        catch {
            return [];
        }
    }
}
