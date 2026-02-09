/**
 * Zotero integration IPC handlers
 */
import { ipcMain } from 'electron';
import { zoteroService } from '../../services/zotero-service.js';
import { pdfService } from '../../services/pdf-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validate, ZoteroTestConnectionSchema, ZoteroSyncSchema } from '../utils/validation.js';

export function setupZoteroHandlers() {
  ipcMain.handle('zotero:test-connection', async (_event, userId: string, apiKey: string, groupId?: string) => {
    console.log('📞 IPC Call: zotero:test-connection', { userId, groupId });
    try {
      const validatedData = validate(ZoteroTestConnectionSchema, { userId, apiKey, groupId });
      const result = await zoteroService.testConnection(
        validatedData.userId,
        validatedData.apiKey,
        validatedData.groupId
      );
      console.log('📤 IPC Response: zotero:test-connection', result);
      return result;
    } catch (error: any) {
      console.error('❌ zotero:test-connection error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:list-collections', async (_event, userId: string, apiKey: string, groupId?: string) => {
    console.log('📞 IPC Call: zotero:list-collections', { userId, groupId });
    try {
      const validatedData = validate(ZoteroTestConnectionSchema, { userId, apiKey, groupId });
      const result = await zoteroService.listCollections(
        validatedData.userId,
        validatedData.apiKey,
        validatedData.groupId
      );
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
      console.log('  userId:', validatedData.userId, 'collectionKey:', validatedData.collectionKey);
      const result = await zoteroService.sync(validatedData);

      // Save collections to VectorStore if sync was successful
      if (result.success && result.collections && result.collections.length > 0) {
        const vectorStore = pdfService.getVectorStore();
        if (vectorStore) {
          vectorStore.saveCollections(result.collections);
          console.log(`📁 Saved ${result.collections.length} collections to VectorStore`);

          // Link documents to collections using the BibTeX file that was just created
          // The BibTeX file has the correct Better BibTeX keys that match indexed documents
          if (result.bibtexPath) {
            try {
              const { BibTeXParser } = await import('../../../../backend/core/bibliography/BibTeXParser.js');
              const parser = new BibTeXParser();
              const citations = parser.parseFile(result.bibtexPath);

              if (citations.length > 0) {
                // Refresh collection links using the parsed citations
                const refreshResult = await zoteroService.refreshCollectionLinks({
                  userId: validatedData.userId,
                  apiKey: validatedData.apiKey,
                  groupId: validatedData.groupId,
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
              // Fallback to generated bibtexKeys (may not match Better BibTeX format)
              if (result.bibtexKeyToCollections && Object.keys(result.bibtexKeyToCollections).length > 0) {
                const linkedCount = vectorStore.linkDocumentsToCollectionsByBibtexKey(result.bibtexKeyToCollections);
                console.log(`🔗 Linked ${linkedCount} documents to their Zotero collections (fallback)`);
              }
            }
          } else if (result.bibtexKeyToCollections && Object.keys(result.bibtexKeyToCollections).length > 0) {
            // No BibTeX file, use generated keys as fallback
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

  ipcMain.handle('zotero:download-pdf', async (_event, options: {
    userId: string;
    apiKey: string;
    groupId?: string;
    attachmentKey: string;
    filename: string;
    targetDirectory: string;
  }) => {
    console.log('📞 IPC Call: zotero:download-pdf', {
      attachmentKey: options.attachmentKey,
      userId: options.userId,
      groupId: options.groupId,
      hasGroupId: !!options.groupId
    });
    try {
      const result = await zoteroService.downloadPDF(options);
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

  ipcMain.handle('zotero:enrich-citations', async (_event, options: {
    userId: string;
    apiKey: string;
    groupId?: string;
    citations: any[];
    collectionKey?: string;
  }) => {
    console.log('📞 IPC Call: zotero:enrich-citations', {
      citationCount: options.citations?.length,
      collectionKey: options.collectionKey
    });
    try {
      const result = await zoteroService.enrichCitations(options);
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

  ipcMain.handle('zotero:check-updates', async (_event, options: {
    userId: string;
    apiKey: string;
    groupId?: string;
    localCitations: any[];
    collectionKey?: string;
  }) => {
    console.log('📞 IPC Call: zotero:check-updates', {
      citationCount: options.localCitations?.length,
      collectionKey: options.collectionKey
    });
    try {
      const result = await zoteroService.checkUpdates(options);
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

  ipcMain.handle('zotero:apply-updates', async (_event, options: {
    userId: string;
    apiKey: string;
    groupId?: string;
    currentCitations: any[];
    diff: any;
    strategy: 'local' | 'remote' | 'manual';
    resolution?: any;
    collectionKey?: string;
  }) => {
    console.log('📞 IPC Call: zotero:apply-updates', {
      strategy: options.strategy,
      citationCount: options.currentCitations?.length
    });
    try {
      const result = await zoteroService.applyUpdates(options);

      // After applying updates, refresh document-collection links
      if (result.success) {
        const vectorStore = pdfService.getVectorStore();
        if (vectorStore) {
          // Use the ORIGINAL citations (before sync) because they have the correct bibtexKey format
          // from Better BibTeX. The finalCitations after sync may have newly generated IDs that
          // don't match the documents' bibtex_key field.
          // We combine both: original citations for bibtexKey, plus finalCitations for zoteroKey mapping
          const originalCitations = options.currentCitations || [];
          const finalCitations = result.finalCitations || [];

          // Build a map of title -> zoteroKey from final citations (which have zoteroKey set)
          const titleToZoteroKey: Record<string, string> = {};
          for (const fc of finalCitations) {
            if (fc.title && fc.zoteroKey) {
              const normalizedTitle = fc.title.toLowerCase().replace(/[^a-z0-9]/g, '');
              titleToZoteroKey[normalizedTitle] = fc.zoteroKey;
            }
          }

          // Map original citations to their zoteroKey by matching titles
          const localCitations = originalCitations.map((c: any) => {
            const normalizedTitle = c.title?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
            return {
              id: c.id,
              zoteroKey: c.zoteroKey || titleToZoteroKey[normalizedTitle],
              title: c.title,
            };
          });

          // Fetch fresh data from Zotero to update collections and document links
          const refreshResult = await zoteroService.refreshCollectionLinks({
            userId: options.userId,
            apiKey: options.apiKey,
            groupId: options.groupId,
            collectionKey: options.collectionKey,
            localCitations,
          });

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
