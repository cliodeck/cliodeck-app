/**
 * Téléchargeur de modèles GGUF depuis HuggingFace
 * Gère le téléchargement, la vérification et la suppression des modèles embarqués
 */

import path from 'path';
import fs from 'fs';
import {
  EMBEDDED_MODELS,
  DEFAULT_EMBEDDED_MODEL,
  type EmbeddedModelInfo,
} from './EmbeddedLLMClient.js';

export interface DownloadProgress {
  percent: number;
  downloadedMB: number;
  totalMB: number;
  speed: string; // ex: "2.5 MB/s"
  eta: string; // ex: "2:30"
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

// GGUF file magic number (first 4 bytes)
const GGUF_MAGIC = Buffer.from([0x47, 0x47, 0x55, 0x46]); // "GGUF"

export class ModelDownloader {
  private modelsDir: string;
  private abortController: AbortController | null = null;
  private isDownloading = false;

  constructor(userDataPath: string) {
    this.modelsDir = path.join(userDataPath, 'models');
    // Créer le répertoire si nécessaire
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Validates that a file is a valid GGUF format by checking magic bytes
   */
  private isValidGGUF(filePath: string): { valid: boolean; reason?: string } {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, buffer, 0, 4, 0);
      fs.closeSync(fd);

      if (bytesRead < 4) {
        return { valid: false, reason: 'File too small to be valid GGUF' };
      }

      if (!buffer.equals(GGUF_MAGIC)) {
        return {
          valid: false,
          reason: `Invalid magic bytes: expected GGUF, got ${buffer.toString('hex')}`,
        };
      }

      return { valid: true };
    } catch (error: any) {
      return { valid: false, reason: `Error reading file: ${error.message}` };
    }
  }

  /**
   * Retourne le chemin où le modèle sera/est stocké
   */
  getModelPath(modelId: string = DEFAULT_EMBEDDED_MODEL): string {
    const modelInfo = EMBEDDED_MODELS[modelId];
    if (!modelInfo) {
      throw new Error(`Unknown model: ${modelId}. Available: ${Object.keys(EMBEDDED_MODELS).join(', ')}`);
    }
    return path.join(this.modelsDir, modelInfo.filename);
  }

  /**
   * Vérifie si un modèle est déjà téléchargé et valide
   */
  isModelDownloaded(modelId: string = DEFAULT_EMBEDDED_MODEL): boolean {
    try {
      const modelPath = this.getModelPath(modelId);
      if (!fs.existsSync(modelPath)) {
        return false;
      }

      const modelInfo = EMBEDDED_MODELS[modelId];
      const stats = fs.statSync(modelPath);
      const sizeMB = stats.size / (1024 * 1024);

      // Strict tolerance of 2% - truncated files should not pass
      const sizeValid = sizeMB >= modelInfo.sizeMB * 0.98;

      if (!sizeValid) {
        console.warn(
          `⚠️ [DOWNLOAD] Model ${modelId} exists but size mismatch: ${sizeMB.toFixed(1)} MB vs expected ≥${(modelInfo.sizeMB * 0.98).toFixed(1)} MB`
        );
        return false;
      }

      // Validate GGUF magic bytes to ensure file is not corrupted
      const ggufCheck = this.isValidGGUF(modelPath);
      if (!ggufCheck.valid) {
        console.warn(`⚠️ [DOWNLOAD] Model ${modelId} is corrupted: ${ggufCheck.reason}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`❌ [DOWNLOAD] Error checking model ${modelId}:`, error);
      return false;
    }
  }

  /**
   * Deletes a corrupted model file
   */
  deleteCorruptedModel(modelId: string = DEFAULT_EMBEDDED_MODEL): boolean {
    try {
      const modelPath = this.getModelPath(modelId);
      if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`🗑️ [DOWNLOAD] Deleted corrupted model: ${modelPath}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ [DOWNLOAD] Error deleting corrupted model ${modelId}:`, error);
      return false;
    }
  }

  /**
   * Retourne les infos d'un modèle
   */
  getModelInfo(modelId: string = DEFAULT_EMBEDDED_MODEL): EmbeddedModelInfo {
    const info = EMBEDDED_MODELS[modelId];
    if (!info) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    return info;
  }

  /**
   * Liste tous les modèles disponibles avec leur statut
   */
  getAvailableModels(): ModelStatus[] {
    return Object.entries(EMBEDDED_MODELS).map(([id, info]) => {
      const downloaded = this.isModelDownloaded(id);
      return {
        id,
        name: info.name,
        description: info.description,
        sizeMB: info.sizeMB,
        downloaded,
        path: downloaded ? this.getModelPath(id) : undefined,
      };
    });
  }

  /**
   * Retourne le répertoire des modèles
   */
  getModelsDirectory(): string {
    return this.modelsDir;
  }

  /**
   * Vérifie si un téléchargement est en cours
   */
  isDownloadInProgress(): boolean {
    return this.isDownloading;
  }

  /**
   * Télécharge un modèle depuis HuggingFace
   */
  async downloadModel(
    modelId: string = DEFAULT_EMBEDDED_MODEL,
    onProgress: (progress: DownloadProgress) => void
  ): Promise<string> {
    if (this.isDownloading) {
      throw new Error('A download is already in progress');
    }

    const modelInfo = EMBEDDED_MODELS[modelId];
    if (!modelInfo) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    // Vérifier si déjà téléchargé
    if (this.isModelDownloaded(modelId)) {
      const existingPath = this.getModelPath(modelId);
      onProgress({
        percent: 100,
        downloadedMB: modelInfo.sizeMB,
        totalMB: modelInfo.sizeMB,
        speed: '-',
        eta: '-',
        status: 'complete',
        message: 'Modèle déjà téléchargé',
      });
      return existingPath;
    }

    const url = `https://huggingface.co/${modelInfo.repo}/resolve/main/${modelInfo.filename}`;
    const destPath = this.getModelPath(modelId);

    console.log(`📥 [DOWNLOAD] Starting download of ${modelInfo.name}`);
    console.log(`   URL: ${url}`);
    console.log(`   Destination: ${destPath}`);

    this.isDownloading = true;
    this.abortController = new AbortController();
    const startTime = Date.now();

    onProgress({
      percent: 0,
      downloadedMB: 0,
      totalMB: modelInfo.sizeMB,
      speed: '...',
      eta: '...',
      status: 'pending',
      message: `Connexion à HuggingFace...`,
    });

    try {
      const response = await fetch(url, {
        signal: this.abortController.signal,
        headers: {
          'User-Agent': 'ClioDesk/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      const totalSize = contentLength ? parseInt(contentLength) : modelInfo.sizeMB * 1024 * 1024;
      let downloadedSize = 0;
      let lastTime = startTime;
      let lastBytes = 0;

      // Créer le stream de fichier avec gestion des erreurs
      const fileStream = fs.createWriteStream(destPath);
      let streamError: Error | null = null;

      // Capture stream errors
      fileStream.on('error', (err) => {
        streamError = err;
        console.error('❌ [DOWNLOAD] File stream error:', err);
      });

      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error('No response body available');
      }

      onProgress({
        percent: 0,
        downloadedMB: 0,
        totalMB: totalSize / (1024 * 1024),
        speed: '...',
        eta: '...',
        status: 'downloading',
        message: `Téléchargement de ${modelInfo.name}...`,
      });

      // Helper to wait for drain if buffer is full
      const waitForDrain = (): Promise<void> => {
        return new Promise((resolve) => {
          fileStream.once('drain', resolve);
        });
      };

      // Lire et écrire par chunks avec gestion du backpressure
      while (true) {
        // Check for stream errors
        if (streamError) {
          throw streamError;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const buffer = Buffer.from(value);
        const canContinue = fileStream.write(buffer);
        downloadedSize += value.length;

        // Handle backpressure - wait for drain if buffer is full
        if (!canContinue) {
          await waitForDrain();
        }

        // Calculer vitesse et ETA toutes les 500ms
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;

        if (elapsed >= 0.5) {
          const bytesPerSec = (downloadedSize - lastBytes) / elapsed;
          const speed = this.formatSpeed(bytesPerSec);
          const remaining = totalSize - downloadedSize;
          const eta = bytesPerSec > 0 ? this.formatETA(remaining / bytesPerSec) : '...';

          lastTime = now;
          lastBytes = downloadedSize;

          const percent = (downloadedSize / totalSize) * 100;
          onProgress({
            percent,
            downloadedMB: downloadedSize / (1024 * 1024),
            totalMB: totalSize / (1024 * 1024),
            speed,
            eta,
            status: 'downloading',
            message: `${percent.toFixed(1)}% - ${speed} - ETA: ${eta}`,
          });
        }
      }

      // Final check for any stream errors that occurred during writing
      if (streamError) {
        fileStream.destroy();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        throw streamError;
      }

      // Check that we received all expected bytes before closing
      if (downloadedSize < totalSize * 0.99) {
        fileStream.destroy();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        throw new Error(
          `Download stream ended prematurely: received ${(downloadedSize / (1024 * 1024)).toFixed(1)} MB ` +
          `of ${(totalSize / (1024 * 1024)).toFixed(1)} MB (${((downloadedSize / totalSize) * 100).toFixed(1)}%)`
        );
      }

      // Fermer le fichier
      await new Promise<void>((resolve, reject) => {
        fileStream.end((err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Vérification du fichier
      onProgress({
        percent: 100,
        downloadedMB: totalSize / (1024 * 1024),
        totalMB: totalSize / (1024 * 1024),
        speed: '-',
        eta: '-',
        status: 'verifying',
        message: 'Vérification du fichier...',
      });

      // Vérifier la taille du fichier téléchargé
      const stats = fs.statSync(destPath);
      const actualSizeMB = stats.size / (1024 * 1024);
      const contentLengthMB = totalSize / (1024 * 1024);
      const expectedSizeMB = modelInfo.sizeMB;

      console.log(`📏 [DOWNLOAD] Size verification:`);
      console.log(`   Downloaded: ${actualSizeMB.toFixed(2)} MB`);
      console.log(`   Content-Length: ${contentLengthMB.toFixed(2)} MB`);
      console.log(`   Expected (model config): ${expectedSizeMB} MB`);

      // Strict check: downloaded bytes should match Content-Length (99% tolerance for minor variations)
      const contentLengthMinSize = totalSize * 0.99;
      if (stats.size < contentLengthMinSize) {
        fs.unlinkSync(destPath);
        throw new Error(
          `Téléchargement incomplet: ${actualSizeMB.toFixed(1)} MB reçus sur ${contentLengthMB.toFixed(1)} MB attendus (Content-Length). ` +
          `Veuillez vérifier votre connexion internet et réessayer.`
        );
      }

      // Also check against expected model size from config (with 5% tolerance for compression variations)
      const expectedMinSize = expectedSizeMB * 1024 * 1024 * 0.95;
      if (stats.size < expectedMinSize) {
        fs.unlinkSync(destPath);
        throw new Error(
          `Fichier trop petit: ${actualSizeMB.toFixed(1)} MB au lieu de ${expectedSizeMB} MB minimum attendu. ` +
          `Le fichier source peut avoir été modifié.`
        );
      }

      // Validate GGUF format (magic bytes)
      const ggufCheck = this.isValidGGUF(destPath);
      if (!ggufCheck.valid) {
        fs.unlinkSync(destPath);
        throw new Error(`Fichier invalide (GGUF corrompu): ${ggufCheck.reason}`);
      }

      onProgress({
        percent: 100,
        downloadedMB: stats.size / (1024 * 1024),
        totalMB: totalSize / (1024 * 1024),
        speed: '-',
        eta: '-',
        status: 'complete',
        message: 'Téléchargement terminé!',
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [DOWNLOAD] Complete in ${duration}s: ${destPath}`);

      return destPath;
    } catch (error: any) {
      // Nettoyage en cas d'erreur ou d'annulation
      if (fs.existsSync(destPath)) {
        try {
          fs.unlinkSync(destPath);
        } catch (cleanupError) {
          console.warn('⚠️ [DOWNLOAD] Could not clean up partial file:', cleanupError);
        }
      }

      if (error.name === 'AbortError') {
        onProgress({
          percent: 0,
          downloadedMB: 0,
          totalMB: modelInfo.sizeMB,
          speed: '-',
          eta: '-',
          status: 'cancelled',
          message: 'Téléchargement annulé',
        });
        throw new Error('Téléchargement annulé par l\'utilisateur');
      }

      onProgress({
        percent: 0,
        downloadedMB: 0,
        totalMB: modelInfo.sizeMB,
        speed: '-',
        eta: '-',
        status: 'error',
        message: `Erreur: ${error.message}`,
      });

      console.error('❌ [DOWNLOAD] Error:', error);
      throw error;
    } finally {
      this.isDownloading = false;
      this.abortController = null;
    }
  }

  /**
   * Annule un téléchargement en cours
   */
  cancelDownload(): boolean {
    if (this.abortController && this.isDownloading) {
      this.abortController.abort();
      console.log('⚠️ [DOWNLOAD] Download cancelled by user');
      return true;
    }
    return false;
  }

  /**
   * Supprime un modèle téléchargé
   */
  deleteModel(modelId: string = DEFAULT_EMBEDDED_MODEL): boolean {
    try {
      const modelPath = this.getModelPath(modelId);
      if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`🗑️ [DOWNLOAD] Deleted model: ${modelPath}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ [DOWNLOAD] Error deleting model ${modelId}:`, error);
      return false;
    }
  }

  /**
   * Calcule l'espace disque utilisé par les modèles
   */
  getUsedSpace(): { totalMB: number; models: Array<{ id: string; sizeMB: number }> } {
    const models: Array<{ id: string; sizeMB: number }> = [];
    let totalMB = 0;

    for (const modelId of Object.keys(EMBEDDED_MODELS)) {
      if (this.isModelDownloaded(modelId)) {
        const modelPath = this.getModelPath(modelId);
        const stats = fs.statSync(modelPath);
        const sizeMB = stats.size / (1024 * 1024);
        models.push({ id: modelId, sizeMB });
        totalMB += sizeMB;
      }
    }

    return { totalMB, models };
  }

  /**
   * Formate une vitesse en bytes/sec vers une chaîne lisible
   */
  private formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec > 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSec > 1024) {
      return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
    }
    return `${bytesPerSec.toFixed(0)} B/s`;
  }

  /**
   * Formate un temps en secondes vers mm:ss
   */
  private formatETA(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0 || seconds > 86400) {
      return '...';
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 60) {
      const hours = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      return `${hours}h${remainingMins.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
