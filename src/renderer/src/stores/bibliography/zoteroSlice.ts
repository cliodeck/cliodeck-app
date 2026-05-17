import type { ZoteroSliceState, BibliographySliceCreator } from './types';

export const createZoteroSlice: BibliographySliceCreator<ZoteroSliceState> = (set, get) => ({
  downloadAndIndexZoteroPDF: async (citationId: string, attachmentKey: string, projectPath: string) => {
    try {
      const { citations } = get();
      const citation = citations.find((c) => c.id === citationId);

      if (!citation) {
        throw new Error('Citation not found');
      }

      const attachment = citation.zoteroAttachments?.find((att) => att.key === attachmentKey);
      if (!attachment) {
        throw new Error('Attachment not found in citation');
      }

      // Get Zotero config to determine mode
      const zoteroConfig = await window.electron.config.get('zotero');
      if (!zoteroConfig) {
        throw new Error('Zotero not configured. Please configure Zotero in Settings.');
      }

      const mode = zoteroConfig.mode || 'api';

      // Get project-specific config
      let groupId: string | undefined;
      let libraryID: number | undefined;
      try {
        const projectConfig = await window.electron.project.getConfig(`${projectPath}/project.json`);
        groupId = projectConfig?.zotero?.groupId || undefined;
        libraryID = projectConfig?.zotero?.libraryID;
      } catch (configError) {
        console.warn('Could not load project config:', configError);
      }

      // Build download options based on mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic options bag passed to IPC
      let downloadOptions: any;
      if (mode === 'api') {
        if (!zoteroConfig.userId || !zoteroConfig.apiKey) {
          throw new Error('Zotero API not configured. Please configure userId and apiKey in Settings.');
        }
        downloadOptions = {
          mode: 'api',
          userId: zoteroConfig.userId,
          apiKey: zoteroConfig.apiKey,
          groupId,
          attachmentKey: attachment.key,
          filename: attachment.filename,
          targetDirectory: projectPath,
        };
      } else {
        if (!zoteroConfig.dataDirectory) {
          throw new Error('Zotero data directory not configured. Please configure it in Settings.');
        }
        downloadOptions = {
          mode: 'local',
          dataDirectory: zoteroConfig.dataDirectory,
          libraryID,
          attachmentKey: attachment.key,
          filename: attachment.filename,
          targetDirectory: projectPath,
        };
      }

      console.log(`Downloading PDF from Zotero (${mode}): ${attachment.filename}`);

      // Download PDF from Zotero
      const downloadResult = await window.electron.zotero.downloadPDF(downloadOptions);

      if (!downloadResult.success || !downloadResult.filePath) {
        throw new Error(downloadResult.error || 'Failed to download PDF');
      }

      console.log(`✅ PDF downloaded to: ${downloadResult.filePath}`);

      // Update citation with local file path and mark attachment as downloaded
      const updatedCitations = citations.map((c) => {
        if (c.id === citationId) {
          // Also update the zoteroAttachment to mark it as downloaded with local path
          const updatedAttachments = c.zoteroAttachments?.map((att) =>
            att.key === attachmentKey
              ? { ...att, downloaded: true, localPath: downloadResult.filePath }
              : att
          );
          return { ...c, file: downloadResult.filePath, zoteroAttachments: updatedAttachments };
        }
        return c;
      });

      set({ citations: updatedCitations });
      get().applyFilters();

      // Save updated metadata to persist the local file path
      try {
        await window.electron.bibliography.saveMetadata({
          projectPath,
          citations: updatedCitations,
        });
        console.log('💾 Metadata saved after PDF download');
      } catch (metaError) {
        console.error('⚠️ Failed to save metadata after PDF download:', metaError);
      }

      // Index the downloaded PDF
      console.log(`🔍 Indexing downloaded PDF for citation: ${citation.title}`);

      window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
        detail: { citationId, title: citation.title, filePath: downloadResult.filePath }
      }));

      const bibliographyMetadata = {
        title: citation.title,
        author: citation.author,
        year: citation.year,
      };

      const indexResult = await window.electron.pdf.index(
        downloadResult.filePath!,
        citationId,
        bibliographyMetadata
      );

      if (!indexResult.success) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: indexResult.error }
        }));
        throw new Error(indexResult.error || 'Failed to index PDF');
      }

      // Add to indexed set
      set((state) => ({
        indexedFilePaths: new Set([...state.indexedFilePaths, downloadResult.filePath!])
      }));

      window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
        detail: { citationId, success: true }
      }));

      console.log(`✅ PDF downloaded and indexed from Zotero: ${citation.title}`);
    } catch (error) {
      console.error('❌ Failed to download and index PDF from Zotero:', error);
      throw error;
    }
  },

  downloadAllMissingPDFs: async (projectPath: string) => {
    try {
      const { citations } = get();

      // Get Zotero config to determine mode
      const zoteroConfig = await window.electron.config.get('zotero');
      if (!zoteroConfig) {
        throw new Error('Zotero not configured. Please configure Zotero in Settings.');
      }

      const mode = zoteroConfig.mode || 'api';

      if (mode === 'api' && (!zoteroConfig.userId || !zoteroConfig.apiKey)) {
        throw new Error('Zotero API not configured. Please configure userId and apiKey in Settings.');
      }
      if (mode === 'local' && !zoteroConfig.dataDirectory) {
        throw new Error('Zotero data directory not configured. Please configure it in Settings.');
      }

      // Get project-specific config
      let groupId: string | undefined;
      let libraryID: number | undefined;
      try {
        const projectConfig = await window.electron.project.getConfig(`${projectPath}/project.json`);
        groupId = projectConfig?.zotero?.groupId || undefined;
        libraryID = projectConfig?.zotero?.libraryID;
      } catch (configError) {
        console.warn('Could not load project config:', configError);
      }

      // Find citations with Zotero PDFs but no local file
      const citationsNeedingPDFs = citations.filter(
        (c) => !c.file && c.zoteroAttachments && c.zoteroAttachments.length > 0
      );

      if (citationsNeedingPDFs.length === 0) {
        return { downloaded: 0, skipped: 0, errors: [] };
      }

      const errors: string[] = [];
      let downloaded = 0;
      let skipped = 0;

      // Update batch indexing state
      set({
        batchIndexing: {
          isIndexing: true,
          current: 0,
          total: citationsNeedingPDFs.length,
          skipped: 0,
          indexed: 0,
          errors: [],
        }
      });

      for (let i = 0; i < citationsNeedingPDFs.length; i++) {
        const citation = citationsNeedingPDFs[i];

        set((state) => ({
          batchIndexing: {
            ...state.batchIndexing,
            current: i + 1,
            currentCitation: {
              citationId: citation.id,
              title: citation.title,
              progress: 0,
              stage: 'Downloading PDF...',
            }
          }
        }));

        try {
          // Download first available PDF
          const firstAttachment = citation.zoteroAttachments![0];

          console.log(`Downloading PDF for: ${citation.title}`);

          // Build download options based on mode
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic options bag passed to IPC
          const downloadOptions: any = mode === 'api'
            ? {
                mode: 'api',
                userId: zoteroConfig.userId,
                apiKey: zoteroConfig.apiKey,
                groupId,
                attachmentKey: firstAttachment.key,
                filename: firstAttachment.filename,
                targetDirectory: projectPath,
              }
            : {
                mode: 'local',
                dataDirectory: zoteroConfig.dataDirectory,
                libraryID,
                attachmentKey: firstAttachment.key,
                filename: firstAttachment.filename,
                targetDirectory: projectPath,
              };

          const downloadResult = await window.electron.zotero.downloadPDF(downloadOptions);

          if (!downloadResult.success || !downloadResult.filePath) {
            errors.push(`${citation.title}: ${downloadResult.error || 'Failed to download'}`);
            continue;
          }

          // Update citation with local file path
          const updatedCitations = get().citations.map((c) =>
            c.id === citation.id ? { ...c, file: downloadResult.filePath } : c
          );

          set({ citations: updatedCitations });
          get().applyFilters();

          // Index the downloaded PDF
          set((state) => ({
            batchIndexing: {
              ...state.batchIndexing,
              currentCitation: {
                citationId: citation.id,
                title: citation.title,
                progress: 50,
                stage: 'Indexing PDF...',
              }
            }
          }));

          const bibliographyMetadata = {
            title: citation.title,
            author: citation.author,
            year: citation.year,
          };

          const indexResult = await window.electron.pdf.index(
            downloadResult.filePath,
            citation.id,
            bibliographyMetadata
          );

          if (indexResult.success) {
            downloaded++;
            set((state) => ({
              indexedFilePaths: new Set([...state.indexedFilePaths, downloadResult.filePath!]),
              batchIndexing: { ...state.batchIndexing, indexed: downloaded }
            }));
          } else {
            errors.push(`${citation.title}: ${indexResult.error || 'Failed to index'}`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${citation.title}: ${errorMsg}`);
        }
      }

      set({
        batchIndexing: {
          isIndexing: false,
          current: citationsNeedingPDFs.length,
          total: citationsNeedingPDFs.length,
          skipped,
          indexed: downloaded,
          errors,
        }
      });

      console.log(`✅ Batch download complete: ${downloaded} downloaded, ${errors.length} errors`);

      return { downloaded, skipped, errors };
    } catch (error) {
      console.error('❌ Failed to download all missing PDFs:', error);
      throw error;
    }
  },
});
