/**
 * Zotero integration IPC handlers
 * Supports both API mode (online) and local SQLite mode
 */
import { ipcMain } from 'electron';
import { zoteroService } from '../../services/zotero-service.js';
import { pdfService } from '../../services/pdf-service.js';
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

export function setupZoteroHandlers() {
  ipcMain.handle('zotero:test-connection', async (_event, options: unknown) => {
    console.log('📞 IPC Call: zotero:test-connection');
    try {
      const validatedData = validate(ZoteroTestConnectionSchema, options);
      const result = await zoteroService.testConnection(validatedData);
      console.log('📤 IPC Response: zotero:test-connection', result);
      return result;
    } catch (error: any) {
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
    } catch (error: any) {
      console.error('❌ zotero:list-libraries error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:list-collections', async (_event, options: unknown) => {
    console.log('📞 IPC Call: zotero:list-collections');
    try {
      const validatedData = validate(ZoteroListCollectionsSchema, options);
      const result = await zoteroService.listCollections(validatedData);
      console.log('📤 IPC Response: zotero:list-collections', {
        success: result.success,
        collectionCount: result.collections?.length,
      });
      return result;
    } catch (error: any) {
      console.error('❌ zotero:list-collections error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:sync', async (_event, options: unknown) => {
    console.log('📞 IPC Call: zotero:sync');
    try {
      const validatedData = validate(ZoteroSyncSchema, options);
      const result = await zoteroService.sync(validatedData);

      // Save collections to VectorStore if sync was successful
      if (result.success && result.collections && result.collections.length > 0) {
        const vectorStore = pdfService.getVectorStore();
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
                  const linkedCount = vectorStore.linkDocumentsToCollectionsByBibtexKey(refreshResult.bibtexKeyToCollections);
                  console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections`);
                }
              }
            } catch (parseError) {
              console.error('⚠️ Could not parse BibTeX for collection linking:', parseError);
              if (result.bibtexKeyToCollections && Object.keys(result.bibtexKeyToCollections).length > 0) {
                const linkedCount = vectorStore.linkDocumentsToCollectionsByBibtexKey(result.bibtexKeyToCollections);
                console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections (fallback)`);
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
    } catch (error: any) {
      console.error('❌ zotero:sync error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:download-pdf', async (_event, rawOptions: unknown) => {
    const options = validate(ZoteroDownloadPDFSchema, rawOptions);
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
    } catch (error: any) {
      console.error('❌ zotero:download-pdf error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:enrich-citations', async (_event, rawOptions: unknown) => {
    const options = validate(ZoteroEnrichCitationsSchema, rawOptions);
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
    } catch (error: any) {
      console.error('❌ zotero:enrich-citations error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:check-updates', async (_event, rawOptions: unknown) => {
    const options = validate(ZoteroCheckUpdatesSchema, rawOptions);
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
    } catch (error: any) {
      console.error('❌ zotero:check-updates error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:apply-updates', async (_event, rawOptions: unknown) => {
    const options = validate(ZoteroApplyUpdatesSchema, rawOptions);
    console.log('📞 IPC Call: zotero:apply-updates', {
      mode: options.mode,
      strategy: options.strategy,
      citationCount: options.currentCitations?.length,
    });
    try {
      const result = await zoteroService.applyUpdates(options as any);

      // After applying updates, refresh document-collection links
      if (result.success) {
        const vectorStore = pdfService.getVectorStore();
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

          if (refreshResult.collections && refreshResult.collections.length > 0) {
            vectorStore.saveCollections(refreshResult.collections);
            console.log(`📁 Updated ${refreshResult.collections.length} collections in VectorStore`);
          }

          if (refreshResult.bibtexKeyToCollections && Object.keys(refreshResult.bibtexKeyToCollections).length > 0) {
            const linkedCount = vectorStore.linkDocumentsToCollectionsByBibtexKey(refreshResult.bibtexKeyToCollections);
            console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections`);
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
    } catch (error: any) {
      console.error('❌ zotero:apply-updates error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Zotero handlers registered');
}
