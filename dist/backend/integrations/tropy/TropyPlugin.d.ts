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
export interface TropyProject {
    name: string;
    items: TropyItem[];
}
export interface ImportResult {
    itemCount: number;
    photoCount: number;
    noteCount: number;
    outputDirectory: string;
    errors: string[];
}
export declare class TropyPlugin {
    private db;
    /**
     * Ouvre un projet Tropy (.tpy)
     */
    openProject(tpyPath: string): void;
    /**
     * Ferme le projet
     */
    closeProject(): void;
    /**
     * Lit le nom du projet
     */
    getProjectName(): string;
    /**
     * Liste tous les items du projet
     */
    listItems(): TropyItem[];
    /**
     * Importe un projet Tropy dans un dossier local
     */
    importProject(tpyPath: string, targetDirectory: string): Promise<ImportResult>;
    private getItemMetadata;
    private extractPropertyName;
    private getItemTags;
    private getItemNotes;
    private getItemPhotos;
    private getPhotoNotes;
    private getPhotoSelections;
    private getSelectionNotes;
    private importItem;
    private generateItemMarkdown;
    private sanitizeFilename;
    private countPhotoNotes;
}
