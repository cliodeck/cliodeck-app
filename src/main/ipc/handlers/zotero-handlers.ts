/**
 * Zotero integration IPC handlers
 * Supports both API mode (online) and local SQLite mode
 */
import { ipcMain } from 'electron';
import { zoteroService } from '../../services/zotero-service.js';
import { pdfService } from '../../services/pdf-service.js';
import { configManager } from '../../services/config-manager.js';
import { maskAPIKey } from '../../services/secure-storage.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  ZoteroTestConnectionSchema,
  ZoteroListCollectionsSchema,
  ZoteroSyncSchema,
  ZoteroListLibrariesSchema,
  ZoteroDownloadPDFSchema,
  ZoteroEnrichCitationsSchema,
  ZoteroCheckUpdatesSchema,
  ZoteroApplyUpdatesSchema,
} from '../utils/validation.js';

/**
 * The renderer only ever receives masked API keys (config:get redaction), so
 * the apiKey it round-trips in handler options may be a mask. Substitute the
 * real stored key when the incoming value matches the mask of the stored one.
 */
/**
 * Les handlers Zotero écrivent dans le vector store APRÈS de longs `await`
 * (sync réseau/SQLite). Un `project:load` concurrent remplace le store via
 * `pdfService.init` : relire `getVectorStore()` après l'await écrirait les
 * collections dans le NOUVEAU projet. On capture donc la référence avant
 * l'await et on n'écrit que si elle est encore le store courant — sinon on
 * abandonne les écritures (la synchro elle-même reste valide côté fichiers).
 */
function vectorStoreIfStillCurrent(
  captured: ReturnType<typeof pdfService.getVectorStore>
): ReturnType<typeof pdfService.getVectorStore> {
  const current = pdfService.getVectorStore();
  if (!captured || current !== captured) {
    if (captured) {
      console.warn('⚠️ Projet changé pendant l\'opération Zotero — écritures vector store ignorées');
    }
    return null;
  }
  return current;
}

function withResolvedZoteroApiKey<T extends object>(options: T): T {
  if (!('apiKey' in options)) return options;
  const incoming = (options as { apiKey?: unknown }).apiKey;
  if (typeof incoming !== 'string') return options;
  const stored = configManager.getAPIKey('zotero.apiKey');
  if (!stored) return options;
  if (incoming === '' || incoming === maskAPIKey(stored)) {
    return { ...options, apiKey: stored };
  }
  return options;
}

export function setupZoteroHandlers() {
  ipcMain.handle('zotero:test-connection', async (_event, options: unknown) => {
    console.log('📞 IPC Call: zotero:test-connection');
    try {
      const validatedData = withResolvedZoteroApiKey(validate(ZoteroTestConnectionSchema, options));
      const result = await zoteroService.testConnection(validatedData);
      console.log('📤 IPC Response: zotero:test-connection', result);
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:test-connection error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:list-libraries', async (_event, rawDataDirectory: unknown) => {
    const { dataDirectory } = validate(ZoteroListLibrariesSchema, { dataDirectory: rawDataDirectory });
    console.log('📞 IPC Call: zotero:list-libraries', { dataDirectory });
    try {
      const result = await zoteroService.listLibraries(dataDirectory);
      console.log('📤 IPC Response: zotero:list-libraries', {
        success: result.success,
        libraryCount: result.libraries?.length,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:list-libraries error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:list-collections', async (_event, options: unknown) => {
    console.log('📞 IPC Call: zotero:list-collections');
    try {
      const validatedData = withResolvedZoteroApiKey(validate(ZoteroListCollectionsSchema, options));
      const result = await zoteroService.listCollections(validatedData);
      console.log('📤 IPC Response: zotero:list-collections', {
        success: result.success,
        collectionCount: result.collections?.length,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:list-collections error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:sync', async (_event, options: unknown) => {
    console.log('📞 IPC Call: zotero:sync');
    try {
      const validatedData = withResolvedZoteroApiKey(validate(ZoteroSyncSchema, options));
      const vectorStoreBefore = pdfService.getVectorStore();
      const result = await zoteroService.sync(validatedData);

      // Save collections to VectorStore if sync was successful
      if (result.success && result.collections && result.collections.length > 0) {
        const vectorStore = vectorStoreIfStillCurrent(vectorStoreBefore);
        if (vectorStore) {
          vectorStore.saveCollections(result.collections);
          console.log(`📁 Saved ${result.collections.length} collections to VectorStore`);

          // Link documents to collections using the BibTeX file that was just created
          if (result.bibtexPath) {
            try {
              const { BibTeXParser } = await import('../../../../backend/core/bibliography/BibTeXParser.js');
              const parser = new BibTeXParser();
              const citations = parser.parseFile(result.bibtexPath);

              if (citations.length > 0) {
                const refreshResult = await zoteroService.refreshCollectionLinks({
                  ...validatedData,
                  collectionKey: validatedData.collectionKey,
                  localCitations: citations.map((c: any) => ({
                    id: c.id,
                    zoteroKey: c.zoteroKey,
                    title: c.title,
                  })),
                });

                if (refreshResult.bibtexKeyToCollections && Object.keys(refreshResult.bibtexKeyToCollections).length > 0) {
                  // refreshCollectionLinks est un nouvel await : re-vérifier.
                  const store = vectorStoreIfStillCurrent(vectorStoreBefore);
                  if (store) {
                    const linkedCount = store.linkDocumentsToCollectionsByBibtexKey(refreshResult.bibtexKeyToCollections);
                    console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections`);
                  }
                }
              }
            } catch (parseError) {
              console.error('⚠️ Could not parse BibTeX for collection linking:', parseError);
              if (result.bibtexKeyToCollections && Object.keys(result.bibtexKeyToCollections).length > 0) {
                const store = vectorStoreIfStillCurrent(vectorStoreBefore);
                if (store) {
                  const linkedCount = store.linkDocumentsToCollectionsByBibtexKey(result.bibtexKeyToCollections);
                  console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections (fallback)`);
                }
              }
            }
          } else if (result.bibtexKeyToCollections && Object.keys(result.bibtexKeyToCollections).length > 0) {
            const linkedCount = vectorStore.linkDocumentsToCollectionsByBibtexKey(result.bibtexKeyToCollections);
            console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections (fallback)`);
          }
        }
      }

      console.log('📤 IPC Response: zotero:sync', {
        success: result.success,
        itemCount: result.itemCount,
        pdfCount: result.pdfCount,
        collectionCount: result.collections?.length,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:sync error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:download-pdf', async (_event, rawOptions: unknown) => {
    const options = withResolvedZoteroApiKey(validate(ZoteroDownloadPDFSchema, rawOptions));
    console.log('📞 IPC Call: zotero:download-pdf', {
      mode: options.mode,
      attachmentKey: options.attachmentKey,
    });
    try {
      const result = await zoteroService.downloadPDF(options as any);
      console.log('📤 IPC Response: zotero:download-pdf', {
        success: result.success,
        filePath: result.filePath,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:download-pdf error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:enrich-citations', async (_event, rawOptions: unknown) => {
    const options = withResolvedZoteroApiKey(validate(ZoteroEnrichCitationsSchema, rawOptions));
    console.log('📞 IPC Call: zotero:enrich-citations', {
      mode: options.mode,
      citationCount: options.citations?.length,
      collectionKey: options.collectionKey,
    });
    try {
      const result = await zoteroService.enrichCitations(options as any);
      console.log('📤 IPC Response: zotero:enrich-citations', {
        success: result.success,
        enrichedCount: result.citations?.length,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:enrich-citations error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:check-updates', async (_event, rawOptions: unknown) => {
    const options = withResolvedZoteroApiKey(validate(ZoteroCheckUpdatesSchema, rawOptions));
    console.log('📞 IPC Call: zotero:check-updates', {
      mode: options.mode,
      citationCount: options.localCitations?.length,
      collectionKey: options.collectionKey,
    });
    try {
      const result = await zoteroService.checkUpdates(options as any);
      console.log('📤 IPC Response: zotero:check-updates', {
        success: result.success,
        hasChanges: result.hasChanges,
        summary: result.summary,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:check-updates error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:apply-updates', async (_event, rawOptions: unknown) => {
    const options = withResolvedZoteroApiKey(validate(ZoteroApplyUpdatesSchema, rawOptions));
    console.log('📞 IPC Call: zotero:apply-updates', {
      mode: options.mode,
      strategy: options.strategy,
      citationCount: options.currentCitations?.length,
    });
    try {
      const vectorStoreBefore = pdfService.getVectorStore();
      const result = await zoteroService.applyUpdates(options as any);

      // After applying updates, refresh document-collection links
      if (result.success) {
        const vectorStore = vectorStoreIfStillCurrent(vectorStoreBefore);
        if (vectorStore) {
          const originalCitations = options.currentCitations || [];
          const finalCitations = result.finalCitations || [];

          const titleToZoteroKey: Record<string, string> = {};
          for (const fc of finalCitations) {
            if (fc.title && fc.zoteroKey) {
              const normalizedTitle = fc.title.toLowerCase().replace(/[^a-z0-9]/g, '');
              titleToZoteroKey[normalizedTitle] = fc.zoteroKey;
            }
          }

          const localCitations = originalCitations.map((c: any) => {
            const normalizedTitle = c.title?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
            return {
              id: c.id,
              zoteroKey: c.zoteroKey || titleToZoteroKey[normalizedTitle],
              title: c.title,
            };
          });

          const refreshResult = await zoteroService.refreshCollectionLinks({
            ...options,
            localCitations,
          } as any);

          // refreshCollectionLinks est un nouvel await : re-vérifier.
          const store = vectorStoreIfStillCurrent(vectorStoreBefore);
          if (store) {
            if (refreshResult.collections && refreshResult.collections.length > 0) {
              store.saveCollections(refreshResult.collections);
              console.log(`📁 Updated ${refreshResult.collections.length} collections in VectorStore`);
            }

            if (refreshResult.bibtexKeyToCollections && Object.keys(refreshResult.bibtexKeyToCollections).length > 0) {
              const linkedCount = store.linkDocumentsToCollectionsByBibtexKey(refreshResult.bibtexKeyToCollections);
              console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections`);
            }
          }
        }
      }

      console.log('📤 IPC Response: zotero:apply-updates', {
        success: result.success,
        addedCount: result.addedCount,
        modifiedCount: result.modifiedCount,
        deletedCount: result.deletedCount,
      });
      return result;
    } catch (error: unknown) {
      console.error('❌ zotero:apply-updates error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Zotero handlers registered');
}
