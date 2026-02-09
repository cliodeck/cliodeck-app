import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
// MARK: - TropyWatcher
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
export class TropyWatcher extends EventEmitter {
    constructor(options) {
        super();
        this.tpyPath = null;
        this.originalPath = null; // Original path provided (could be .tropy or .tpy)
        this.watcher = null;
        this.debounceTimer = null;
        this.lastMtime = 0;
        this.isWatching = false;
        this.debounceMs = options?.debounceMs ?? 2000;
    }
    /**
     * Démarre la surveillance d'un projet Tropy (.tropy package ou .tpy)
     * @param projectPath Chemin vers le fichier .tropy ou .tpy à surveiller
     */
    watch(projectPath) {
        // Arrêter la surveillance précédente si active
        if (this.isWatching) {
            this.unwatch();
        }
        if (!fs.existsSync(projectPath)) {
            this.emit('error', new Error(`Tropy project not found: ${projectPath}`));
            return;
        }
        this.originalPath = projectPath;
        // Resolve the actual .tpy path
        let tpyPath;
        const stats = fs.statSync(projectPath);
        if (stats.isDirectory() && projectPath.endsWith('.tropy')) {
            // It's a .tropy package - watch the project.tpy inside
            tpyPath = path.join(projectPath, 'project.tpy');
            if (!fs.existsSync(tpyPath)) {
                this.emit('error', new Error(`project.tpy not found inside .tropy package: ${projectPath}`));
                return;
            }
            console.log(`📦 Watching Tropy package: ${projectPath}`);
        }
        else if (projectPath.endsWith('.tpy')) {
            tpyPath = projectPath;
        }
        else {
            this.emit('error', new Error(`Invalid Tropy project path: ${projectPath}. Expected .tropy or .tpy`));
            return;
        }
        this.tpyPath = tpyPath;
        // Enregistrer le mtime initial
        try {
            const tpyStats = fs.statSync(tpyPath);
            this.lastMtime = tpyStats.mtimeMs;
        }
        catch (error) {
            this.emit('error', new Error(`Failed to get file stats: ${error}`));
            return;
        }
        // Créer le watcher
        try {
            this.watcher = fs.watch(tpyPath, { persistent: true }, (eventType) => {
                if (eventType === 'change') {
                    this.handleChange();
                }
            });
            this.watcher.on('error', (error) => {
                this.emit('error', error);
            });
            this.isWatching = true;
            console.log(`👁️ Watching Tropy database: ${tpyPath}`);
        }
        catch (error) {
            this.emit('error', new Error(`Failed to start watcher: ${error}`));
        }
    }
    /**
     * Arrête la surveillance
     */
    unwatch() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.tpyPath) {
            console.log(`👁️ Stopped watching: ${this.tpyPath}`);
        }
        this.tpyPath = null;
        this.isWatching = false;
        this.lastMtime = 0;
    }
    /**
     * Vérifie si le watcher est actif
     */
    isActive() {
        return this.isWatching;
    }
    /**
     * Retourne le chemin surveillé (le fichier .tpy réel)
     */
    getWatchedPath() {
        return this.tpyPath;
    }
    /**
     * Retourne le chemin original fourni (.tropy ou .tpy)
     */
    getOriginalPath() {
        return this.originalPath;
    }
    /**
     * Force une vérification manuelle des changements
     * Utile si on veut déclencher une sync sans attendre un changement de fichier
     */
    forceCheck() {
        if (this.tpyPath) {
            this.emit('change', this.tpyPath);
        }
    }
    // MARK: - Private Methods
    handleChange() {
        // Annuler le timer précédent si présent (debounce)
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        // Attendre le délai de debounce avant de vérifier le changement
        this.debounceTimer = setTimeout(() => {
            this.checkAndEmitChange();
        }, this.debounceMs);
    }
    checkAndEmitChange() {
        if (!this.tpyPath)
            return;
        try {
            // Vérifier le mtime réel pour éviter les faux positifs
            const stats = fs.statSync(this.tpyPath);
            const currentMtime = stats.mtimeMs;
            if (currentMtime > this.lastMtime) {
                this.lastMtime = currentMtime;
                console.log(`📝 Tropy project changed: ${this.tpyPath}`);
                this.emit('change', this.tpyPath);
            }
        }
        catch (error) {
            this.emit('error', new Error(`Failed to check file change: ${error}`));
        }
    }
}
// MARK: - Factory
/**
 * Crée un nouveau TropyWatcher
 */
export function createTropyWatcher(options) {
    return new TropyWatcher(options);
}
