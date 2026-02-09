import { EventEmitter } from 'events';
export interface TropyWatcherEvents {
    change: (tpyPath: string) => void;
    error: (error: Error) => void;
}
export interface TropyWatcherOptions {
    debounceMs?: number;
}
/**
 * Watcher pour les fichiers Tropy (.tropy package ou .tpy)
 * Surveille les modifications du fichier et émet des événements
 * avec un debounce pour éviter les faux positifs.
 *
 * Supports two formats:
 * - .tropy package: A folder with .tropy extension containing project.tpy
 * - .tpy file: Direct SQLite database file
 *
 * IMPORTANT: Ce watcher ne modifie JAMAIS le fichier .tpy.
 * Il observe uniquement les changements effectués par Tropy.
 */
export declare class TropyWatcher extends EventEmitter {
    private tpyPath;
    private originalPath;
    private watcher;
    private debounceTimer;
    private lastMtime;
    private isWatching;
    private readonly debounceMs;
    constructor(options?: TropyWatcherOptions);
    /**
     * Démarre la surveillance d'un projet Tropy (.tropy package ou .tpy)
     * @param projectPath Chemin vers le fichier .tropy ou .tpy à surveiller
     */
    watch(projectPath: string): void;
    /**
     * Arrête la surveillance
     */
    unwatch(): void;
    /**
     * Vérifie si le watcher est actif
     */
    isActive(): boolean;
    /**
     * Retourne le chemin surveillé (le fichier .tpy réel)
     */
    getWatchedPath(): string | null;
    /**
     * Retourne le chemin original fourni (.tropy ou .tpy)
     */
    getOriginalPath(): string | null;
    /**
     * Force une vérification manuelle des changements
     * Utile si on veut déclencher une sync sans attendre un changement de fichier
     */
    forceCheck(): void;
    private handleChange;
    private checkAndEmitChange;
}
/**
 * Crée un nouveau TropyWatcher
 */
export declare function createTropyWatcher(options?: TropyWatcherOptions): TropyWatcher;
