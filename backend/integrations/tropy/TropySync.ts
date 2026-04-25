import { randomUUID } from 'crypto';
import {
  TropyReader,
  TropyItem,
  PrimarySourceItem,
  PrimarySourcePhoto,
} from './TropyReader';
import { TropyOCRPipeline, OCRResult, TranscriptionFormat } from './TropyOCRPipeline';
import {
  PrimarySourcesVectorStore,
  PrimarySourceDocument,
} from '../../core/vector-store/PrimarySourcesVectorStore';
import { NERService } from '../../core/ner/NERService';
// Legacy OllamaClient type is still imported as a *type-only* casting
// target for the NERService constructor (NERService still wants the slot
// positionally; the stub feeds a no-op there until step 1.2d cleans
// up NERService itself).
import type { OllamaClient } from '../../core/llm/OllamaClient';
import type { LLMProvider } from '../../core/llm/providers/base';
import { archivalFromTropyMetadata } from '../../types/archival-metadata';
import * as fs from 'fs';
import * as path from 'path';

// MARK: - Types

export interface TropySyncOptions {
  performOCR: boolean;
  ocrLanguage: string;
  transcriptionDirectory?: string;
  forceReindex?: boolean;
  extractEntities?: boolean;  // Enable NER extraction (default: false - opt-in due to slow performance)
  /**
   * Typed provider for NER. Required when `extractEntities === true` —
   * the legacy `ollamaClient` slot was removed in fusion step 1.2c.
   */
  llm?: LLMProvider;
}

export interface TropySyncResult {
  success: boolean;
  projectName: string;
  totalItems: number;
  newItems: number;
  updatedItems: number;
  skippedItems: number;
  ocrPerformed: number;
  transcriptionsImported: number;
  errors: string[];
}

export interface TropySyncProgress {
  phase: 'reading' | 'processing' | 'extracting-entities' | 'indexing' | 'done';
  current: number;
  total: number;
  currentItem?: string;
}

export type TropySyncProgressCallback = (progress: TropySyncProgress) => void;

// MARK: - TropySync

/**
 * Synchronisation entre Tropy et ClioDeck
 * Lit les données du fichier .tpy (sans le modifier) et les indexe
 */
export class TropySync {
  private reader: TropyReader;
  private ocrPipeline: TropyOCRPipeline;
  private nerService: NERService | null = null;

  constructor() {
    this.reader = new TropyReader();
    this.ocrPipeline = new TropyOCRPipeline();
  }

  /**
   * Initialises the NER service with a typed LLMProvider.
   *
   * NERService's constructor still requires an OllamaClient positional
   * slot (cleaned up in fusion step 1.2d); we pass a no-op stub so the
   * `runPrompt()` helper's `llm` branch is what actually runs.
   */
  initNERServiceWithProvider(llm: LLMProvider): void {
    const stub = {
      chatModel: 'provider-driven',
      generateResponseStream: async function* () {
        throw new Error(
          'NERService legacy path called despite providers.llm being set'
        );
      },
    } as unknown as OllamaClient;
    this.nerService = new NERService(stub, undefined, 'fr', { llm });
    console.log('🏷️ [TROPY-SYNC] NER service initialized (LLMProvider)');
  }

  /**
   * Synchronise un projet Tropy vers le VectorStore
   */
  async sync(
    tpyPath: string,
    vectorStore: PrimarySourcesVectorStore,
    options: TropySyncOptions,
    onProgress?: TropySyncProgressCallback
  ): Promise<TropySyncResult> {
    console.log(`📚 [TROPY-SYNC] Starting sync - performOCR: ${options.performOCR}, forceReindex: ${options.forceReindex}`);

    const result: TropySyncResult = {
      success: false,
      projectName: '',
      totalItems: 0,
      newItems: 0,
      updatedItems: 0,
      skippedItems: 0,
      ocrPerformed: 0,
      transcriptionsImported: 0,
      errors: [],
    };

    try {
      // Phase 1: Lecture du projet Tropy
      onProgress?.({ phase: 'reading', current: 0, total: 1 });

      this.reader.openProject(tpyPath);
      result.projectName = this.reader.getProjectName();
      const items = this.reader.listItems();
      result.totalItems = items.length;

      console.log(`📚 Syncing Tropy project: ${result.projectName} (${items.length} items)`);

      // DEBUG: Count items with notes and analyze first item
      let itemsWithNotes = 0;
      let totalNotes = 0;
      for (const item of items) {
        const counts = this.reader.countItemNotes(item);
        if (counts.total > 0) {
          itemsWithNotes++;
          totalNotes += counts.total;
        }
      }
      console.log(`📝 [TROPY-SYNC] Items with notes: ${itemsWithNotes}/${items.length} (${totalNotes} total notes)`);

      // DEBUG: Analyze first item in detail
      if (items.length > 0) {
        const firstItem = items[0];
        console.log(`🔍 [TROPY-SYNC] First item analysis: "${firstItem.title}"`);
        console.log(`   - ID: ${firstItem.id}`);
        console.log(`   - Template: ${firstItem.template}`);
        console.log(`   - Notes count: ${firstItem.notes?.length || 0}`);
        console.log(`   - Photos count: ${firstItem.photos?.length || 0}`);

        if (firstItem.photos?.length > 0) {
          const firstPhoto = firstItem.photos[0];
          console.log(`   - First photo notes: ${firstPhoto.notes?.length || 0}`);
          console.log(`   - First photo selections: ${firstPhoto.selections?.length || 0}`);
          if (firstPhoto.selections?.length > 0) {
            console.log(`   - First selection notes: ${firstPhoto.selections[0].notes?.length || 0}`);
          }
        }

        // Show all raw metadata for first item
        const rawMetadata = this.reader.getAllItemMetadataRaw(firstItem.id);
        console.log(`   - Raw metadata properties: ${rawMetadata.length}`);
        for (const meta of rawMetadata) {
          const valuePreview = meta.value?.substring(0, 100) || '(empty)';
          console.log(`     * ${meta.property}: "${valuePreview}${meta.value?.length > 100 ? '...' : ''}"`);
        }
      }

      // Enregistrer le projet Tropy dans le VectorStore
      vectorStore.saveTropyProject(tpyPath, result.projectName, false);

      // Phase 2: Traitement des items
      onProgress?.({ phase: 'processing', current: 0, total: items.length });

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        onProgress?.({
          phase: 'processing',
          current: i + 1,
          total: items.length,
          currentItem: item.title || `Item ${item.id}`,
        });

        try {
          const processResult = await this.processItem(item, vectorStore, options);

          if (processResult.isNew) {
            result.newItems++;
          } else if (processResult.isUpdated) {
            result.updatedItems++;
          } else {
            result.skippedItems++;
          }

          result.ocrPerformed += processResult.ocrCount;
          result.transcriptionsImported += processResult.transcriptionCount;
        } catch (error) {
          result.errors.push(`Item ${item.id} (${item.title}): ${error}`);
        }
      }

      // Phase 2.5: Extract named entities (if enabled)
      if (options.extractEntities === true && options.llm) {
        if (!this.nerService) {
          this.initNERServiceWithProvider(options.llm);
        }
        if (this.nerService) {
          await this.extractEntitiesForSources(vectorStore, onProgress);
        }
      }

      // Phase 3: Mise à jour de la dernière sync
      onProgress?.({ phase: 'indexing', current: 1, total: 1 });
      vectorStore.updateLastSync(tpyPath);

      onProgress?.({ phase: 'done', current: items.length, total: items.length });

      result.success = true;
      console.log(`✅ Sync completed: ${result.newItems} new, ${result.updatedItems} updated`);
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`);
      console.error('Sync error:', error);
    } finally {
      this.reader.closeProject();
    }

    return result;
  }

  /**
   * Traite un item Tropy individuel
   */
  private async processItem(
    item: TropyItem,
    vectorStore: PrimarySourcesVectorStore,
    options: TropySyncOptions
  ): Promise<{
    isNew: boolean;
    isUpdated: boolean;
    ocrCount: number;
    transcriptionCount: number;
  }> {
    const existingSource = vectorStore.getSourceByTropyId(item.id);
    let transcription = '';
    let transcriptionSource: PrimarySourceItem['transcriptionSource'] = undefined;
    let ocrCount = 0;
    let transcriptionCount = 0;

    // 1. D'abord, extraire le texte des notes Tropy (transcriptions manuelles dans Tropy)
    // Use extractItemNotesOnly to get ONLY the actual transcription content, not metadata
    const notesOnlyText = this.reader.extractItemNotesOnly(item);
    const notesCounts = this.reader.countItemNotes(item);

    // DEBUG: Log what we're extracting (only for first few items or if there are notes)
    if (notesCounts.total > 0) {
      console.log(`📝 [TROPY-SYNC] Item "${item.title}": ${notesCounts.itemNotes} item notes, ${notesCounts.photoNotes} photo notes, ${notesCounts.selectionNotes} selection notes`);
      console.log(`📝 [TROPY-SYNC] Notes text length: ${notesOnlyText.length} chars`);
      if (notesOnlyText.length > 0) {
        console.log(`📝 [TROPY-SYNC] Notes preview: "${notesOnlyText.substring(0, 200)}..."`);
      }
    }

    // Only use notes text if there are actual notes (not just metadata)
    if (notesOnlyText.trim().length > 0) {
      // Include metadata header + notes for the full transcription
      transcription = this.reader.extractItemText(item);
      transcriptionSource = 'tropy-notes';
    }

    // 2. Chercher des transcriptions externes (Transkribus, etc.)
    if (options.transcriptionDirectory && (!transcription || options.forceReindex)) {
      const externalTranscription = await this.findExternalTranscription(
        item,
        options.transcriptionDirectory
      );
      if (externalTranscription) {
        transcription = externalTranscription.text;
        transcriptionSource = 'transkribus';
        transcriptionCount++;
      }
    }

    // 3. Si pas de transcription et OCR activé, faire l'OCR
    if (!transcription && options.performOCR) {
      console.log(`🔍 [TROPY-SYNC] OCR needed for item ${item.id} "${item.title}" - photos: ${item.photos.map(p => p.filename).join(', ')}`);
      const ocrResult = await this.performOCROnItem(item, options.ocrLanguage);
      if (ocrResult) {
        transcription = ocrResult.text;
        transcriptionSource = 'tesseract';
        ocrCount = ocrResult.photoCount;
      }
    }

    // Construire la source primaire
    const sourceItem: PrimarySourceItem = {
      id: existingSource?.id || randomUUID(),
      tropyId: item.id,
      title: item.title || `Source ${item.id}`,
      date: item.date,
      creator: item.creator,
      archive: item.archive,
      collection: item.collection,
      type: item.type,
      tags: item.tags,
      photos: this.convertPhotos(item),
      transcription: transcription || undefined,
      transcriptionSource,
      lastModified: this.reader.getLastModifiedTime(),
      metadata: this.extractMetadata(item),
      archival: archivalFromTropyMetadata(this.extractMetadata(item), {
        archive: item.archive,
        collection: item.collection,
        creator: item.creator,
        date: item.date,
      }),
    };

    // Sauvegarder
    const isNew = !existingSource;
    const isUpdated =
      existingSource &&
      (options.forceReindex ||
        existingSource.lastModified !== sourceItem.lastModified.toISOString());

    if (isNew || isUpdated) {
      vectorStore.saveSource(sourceItem);
    }

    return { isNew, isUpdated: !isNew && isUpdated, ocrCount, transcriptionCount };
  }

  /**
   * Cherche une transcription externe pour un item
   */
  private async findExternalTranscription(
    item: TropyItem,
    transcriptionDirectory: string
  ): Promise<{ text: string; format: TranscriptionFormat } | null> {
    // Chercher des fichiers correspondants dans le dossier de transcriptions
    // Pattern: item_id.*, title.*, ou premier filename.*
    const possibleNames = [
      `${item.id}`,
      item.title?.replace(/[^a-zA-Z0-9]/g, '_'),
      item.photos[0]?.filename.replace(/\.[^.]+$/, ''),
    ].filter(Boolean);

    const extensions = ['.xml', '.txt'];

    for (const baseName of possibleNames) {
      for (const ext of extensions) {
        const filePath = path.join(transcriptionDirectory, `${baseName}${ext}`);

        if (fs.existsSync(filePath)) {
          const format = this.ocrPipeline.detectFormat(filePath);
          if (format) {
            try {
              const result = await this.ocrPipeline.importTranscription({
                type: format,
                filePath,
              });
              return { text: result.text, format };
            } catch (error) {
              console.warn(`Failed to import transcription ${filePath}:`, error);
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Effectue l'OCR sur toutes les photos d'un item
   * Note: Tropy creates one "photo" entry per page for PDFs, so we deduplicate
   * to avoid OCR'ing the same file multiple times
   */
  private async performOCROnItem(
    item: TropyItem,
    language: string
  ): Promise<{ text: string; photoCount: number } | null> {
    // Deduplicate paths - Tropy creates multiple photo entries for multi-page PDFs
    const uniquePaths = [...new Set(item.photos.map((p) => p.path))];
    const photoPaths = uniquePaths.filter((p) => fs.existsSync(p));

    if (photoPaths.length === 0) {
      return null;
    }

    console.log(`📸 [TROPY-SYNC] Item ${item.id}: ${item.photos.length} photo entries -> ${photoPaths.length} unique files`);

    try {
      const result = await this.ocrPipeline.performBatchOCR(photoPaths, { language });

      // Ne retourner que si on a un texte significatif
      if (result.text.trim().length > 50 && result.confidence > 30) {
        return {
          text: result.text,
          photoCount: photoPaths.length,
        };
      }
    } catch (error) {
      console.warn(`OCR failed for item ${item.id}:`, error);
    }

    return null;
  }

  /**
   * Convertit les photos Tropy en format PrimarySourcePhoto
   */
  private convertPhotos(item: TropyItem): PrimarySourcePhoto[] {
    return item.photos.map((photo) => ({
      id: photo.id,
      path: photo.path,
      filename: photo.filename,
      width: photo.width,
      height: photo.height,
      mimetype: photo.mimetype,
      hasTranscription: photo.notes.length > 0,
      transcription: photo.notes.map((n) => n.text).join('\n\n') || undefined,
      notes: photo.notes.map((n) => n.text),
    }));
  }

  /**
   * Extrait les métadonnées supplémentaires d'un item
   */
  private extractMetadata(item: TropyItem): Record<string, string> {
    const metadata: Record<string, string> = {};

    if (item.template) metadata.template = item.template;
    if (item.type) metadata.type = item.type;

    // Ajouter d'autres métadonnées si présentes
    const knownFields = ['title', 'date', 'creator', 'archive', 'collection', 'type', 'tags'];
    for (const [key, value] of Object.entries(item)) {
      if (!knownFields.includes(key) && typeof value === 'string' && value) {
        metadata[key] = value;
      }
    }

    return metadata;
  }

  /**
   * Extracts named entities from all sources with transcriptions
   */
  private async extractEntitiesForSources(
    vectorStore: PrimarySourcesVectorStore,
    onProgress?: TropySyncProgressCallback
  ): Promise<void> {
    if (!this.nerService) {
      console.warn('⚠️ [TROPY-SYNC] NER service not initialized, skipping entity extraction');
      return;
    }

    // Get all sources with transcriptions
    const allSources = vectorStore.getAllSources();
    const sourcesWithText = allSources.filter(s => s.transcription && s.transcription.trim().length > 50);

    if (sourcesWithText.length === 0) {
      console.log('🏷️ [TROPY-SYNC] No sources with transcriptions to extract entities from');
      return;
    }

    console.log(`🏷️ [TROPY-SYNC] Extracting entities from ${sourcesWithText.length} sources...`);

    let totalEntities = 0;

    for (let i = 0; i < sourcesWithText.length; i++) {
      const source = sourcesWithText[i];

      onProgress?.({
        phase: 'extracting-entities',
        current: i + 1,
        total: sourcesWithText.length,
        currentItem: source.title,
      });

      try {
        // Delete existing entities for this source (in case of re-sync)
        vectorStore.deleteEntitiesForSource(source.id);

        // Extract entities from transcription
        const result = await this.nerService.extractEntities(source.transcription!);

        if (result.entities.length > 0) {
          // Save entities and their mentions
          vectorStore.saveEntitiesForSource(source.id, result.entities);
          totalEntities += result.entities.length;

          console.log(`  📝 ${source.title}: ${result.entities.length} entities (${result.processingTimeMs}ms)`);
        }
      } catch (error) {
        console.warn(`⚠️ [TROPY-SYNC] Failed to extract entities from ${source.title}:`, error);
      }
    }

    console.log(`🏷️ [TROPY-SYNC] Entity extraction complete: ${totalEntities} total entities`);
  }

  /**
   * Vérifie si une synchronisation est nécessaire
   * Compare la date de modification du fichier .tpy avec la dernière sync
   * Supports both .tropy packages and .tpy files
   */
  checkSyncNeeded(projectPath: string, vectorStore: PrimarySourcesVectorStore): boolean {
    const project = vectorStore.getTropyProject();
    if (!project) return true;

    if (project.tpyPath !== projectPath) return true;

    try {
      // Resolve actual .tpy path if it's a .tropy package
      let tpyPath = projectPath;
      const stats = fs.statSync(projectPath);

      if (stats.isDirectory() && projectPath.endsWith('.tropy')) {
        tpyPath = path.join(projectPath, 'project.tpy');
      }

      const tpyStats = fs.statSync(tpyPath);
      const lastSync = new Date(project.lastSync);
      return tpyStats.mtime > lastSync;
    } catch {
      return true;
    }
  }

  /**
   * Libère les ressources
   */
  async dispose(): Promise<void> {
    this.reader.closeProject();
    await this.ocrPipeline.dispose();
  }
}

// MARK: - Factory

export function createTropySync(): TropySync {
  return new TropySync();
}
