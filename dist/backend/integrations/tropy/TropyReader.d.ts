export interface TropyItem {
    id: number;
    template: string;
    title?: string;
    date?: string;
    creator?: string;
    type?: string;
    collection?: string;
    archive?: string;
    tags: string[];
    notes: TropyNote[];
    photos: TropyPhoto[];
}
export interface TropyPhoto {
    id: number;
    path: string;
    filename: string;
    title?: string;
    width?: number;
    height?: number;
    mimetype?: string;
    notes: TropyNote[];
    selections: TropySelection[];
}
export interface TropySelection {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    notes: TropyNote[];
}
export interface TropyNote {
    id: number;
    html: string;
    text: string;
}
export interface TropyProjectInfo {
    name: string;
    itemCount: number;
    lastModified: Date;
}
export interface PrimarySourceItem {
    id: string;
    tropyId: number;
    title: string;
    date?: string;
    creator?: string;
    archive?: string;
    collection?: string;
    type?: string;
    tags: string[];
    photos: PrimarySourcePhoto[];
    transcription?: string;
    transcriptionSource?: 'tesseract' | 'transkribus' | 'manual' | 'tropy-notes';
    lastModified: Date;
    metadata: Record<string, string>;
}
export interface PrimarySourcePhoto {
    id: number;
    path: string;
    filename: string;
    width?: number;
    height?: number;
    mimetype?: string;
    hasTranscription: boolean;
    transcription?: string;
    notes: string[];
}
/**
 * Lecteur de projets Tropy (.tropy package ou .tpy)
 * IMPORTANT: Ce lecteur ouvre les fichiers en mode LECTURE SEULE.
 * Il ne modifie JAMAIS le fichier .tpy.
 *
 * Supports two formats:
 * - .tropy package: A folder with .tropy extension containing project.tpy and assets/
 * - .tpy file: Direct SQLite database file
 */
export declare class TropyReader {
    private db;
    private tpyPath;
    private packagePath;
    private assetsPath;
    /**
     * Ouvre un projet Tropy (.tropy package ou .tpy) en mode lecture seule
     * @param projectPath Chemin vers le fichier .tropy ou .tpy
     * @throws Error si le fichier n'existe pas
     */
    openProject(projectPath: string): void;
    /**
     * Returns the path to the .tropy package, if applicable
     */
    getPackagePath(): string | null;
    /**
     * Returns the path to the assets folder, if in a package
     */
    getAssetsPath(): string | null;
    /**
     * Resolves a photo path to an absolute path
     * Handles both absolute paths and relative paths within the package
     */
    resolvePhotoPath(photoPath: string): string;
    /**
     * Ferme le projet
     */
    closeProject(): void;
    /**
     * Vérifie si un projet est ouvert
     */
    isOpen(): boolean;
    /**
     * Retourne le chemin du projet ouvert
     */
    getProjectPath(): string | null;
    /**
     * Lit le nom du projet
     */
    getProjectName(): string;
    /**
     * Retourne la date de dernière modification du fichier .tpy
     * Utilisé par le watcher pour détecter les changements
     */
    getLastModifiedTime(): Date;
    /**
     * Returns the original project path (either .tropy package or .tpy file)
     */
    getOriginalProjectPath(): string | null;
    /**
     * Retourne les informations générales du projet
     */
    getProjectInfo(): TropyProjectInfo;
    /**
     * Retourne le nombre d'items dans le projet
     */
    getItemCount(): number;
    /**
     * Liste tous les items du projet
     */
    listItems(): TropyItem[];
    /**
     * Récupère un item par son ID
     */
    getItem(itemId: number): TropyItem | null;
    /**
     * Extrait tout le texte d'un item (notes de l'item + notes des photos)
     * Utile pour l'indexation sans OCR
     */
    extractItemText(item: TropyItem): string;
    /**
     * Extrait SEULEMENT les notes (transcriptions) d'un item, sans les métadonnées
     * Utilisé pour déterminer si un item a des transcriptions réelles
     */
    extractItemNotesOnly(item: TropyItem): string;
    /**
     * Compte le nombre de notes (transcriptions) dans un item
     */
    countItemNotes(item: TropyItem): {
        itemNotes: number;
        photoNotes: number;
        selectionNotes: number;
        total: number;
    };
    /**
     * Liste toutes les photos du projet avec leurs chemins
     * Utile pour vérifier quelles photos existent et lesquelles nécessitent OCR
     */
    listAllPhotos(): Array<{
        itemId: number;
        photo: TropyPhoto;
    }>;
    /**
     * Récupère tous les tags uniques du projet
     */
    getAllTags(): string[];
    private getItemMetadata;
    /**
     * Récupère toutes les métadonnées brutes d'un item (pour debug)
     */
    getAllItemMetadataRaw(itemId: number): Array<{
        property: string;
        value: string;
    }>;
    private extractPropertyName;
    private getItemTags;
    private getItemNotes;
    private getItemPhotos;
    private getPhotoNotes;
    private getPhotoSelections;
    private getSelectionNotes;
}
