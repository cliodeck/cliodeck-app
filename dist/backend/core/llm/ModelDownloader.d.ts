/**
 * Téléchargeur de modèles GGUF depuis HuggingFace
 * Gère le téléchargement, la vérification et la suppression des modèles embarqués
 */
import { type EmbeddedModelInfo } from './EmbeddedLLMClient.js';
export interface DownloadProgress {
    percent: number;
    downloadedMB: number;
    totalMB: number;
    speed: string;
    eta: string;
    status: 'pending' | 'downloading' | 'verifying' | 'complete' | 'error' | 'cancelled';
    message: string;
}
export interface ModelStatus {
    id: string;
    name: string;
    description: string;
    sizeMB: number;
    downloaded: boolean;
    path?: string;
}
export declare class ModelDownloader {
    private modelsDir;
    private abortController;
    private isDownloading;
    constructor(userDataPath: string);
    /**
     * Validates that a file is a valid GGUF format by checking magic bytes
     */
    private isValidGGUF;
    /**
     * Retourne le chemin où le modèle sera/est stocké
     */
    getModelPath(modelId?: string): string;
    /**
     * Vérifie si un modèle est déjà téléchargé et valide
     */
    isModelDownloaded(modelId?: string): boolean;
    /**
     * Deletes a corrupted model file
     */
    deleteCorruptedModel(modelId?: string): boolean;
    /**
     * Retourne les infos d'un modèle
     */
    getModelInfo(modelId?: string): EmbeddedModelInfo;
    /**
     * Liste tous les modèles disponibles avec leur statut
     */
    getAvailableModels(): ModelStatus[];
    /**
     * Retourne le répertoire des modèles
     */
    getModelsDirectory(): string;
    /**
     * Vérifie si un téléchargement est en cours
     */
    isDownloadInProgress(): boolean;
    /**
     * Télécharge un modèle depuis HuggingFace
     */
    downloadModel(modelId: string, onProgress: (progress: DownloadProgress) => void): Promise<string>;
    /**
     * Annule un téléchargement en cours
     */
    cancelDownload(): boolean;
    /**
     * Supprime un modèle téléchargé
     */
    deleteModel(modelId?: string): boolean;
    /**
     * Calcule l'espace disque utilisé par les modèles
     */
    getUsedSpace(): {
        totalMB: number;
        models: Array<{
            id: string;
            sizeMB: number;
        }>;
    };
    /**
     * Formate une vitesse en bytes/sec vers une chaîne lisible
     */
    private formatSpeed;
    /**
     * Formate un temps en secondes vers mm:ss
     */
    private formatETA;
}
