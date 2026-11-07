/**
 * Zotero integration IPC handlers
 * Supports both API mode (online) and local SQLite mode
 */
import { ipcMain } from 'electron';
import { zoteroService } from '../../services/zotero-service.js';
import { pdfService } from '../../services/pdf-service.js';
import { configManager } from '../../services/config-manager.js';
import { isMaskedKey } from '../../services/secure-storage.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  ZoteroTestConnectionSchema,
  ZoteroListCollectionsSchema,
  ZoteroListLibrariesSchema,
  ZoteroDownloadPDFSchema,
  ZoteroSynchronizeSchema,
} from '../utils/validation.js';
import { projectManager } from '../../services/project-manager.js';
import { sameFile } from '../../../../backend/core/vector-store/file-identity.js';
import type { SyncConfirmation } from '../../../../backend/integrations/zotero/ZoteroSynchronizer.js';

/**
 * The renderer only ever receives masked API keys (config:get redaction), so
 * the apiKey it round-trips in handler options may be a mask. A value shaped
 * like a mask is never a key: substitute the stored key, whichever key it was
 * the mask of, and send nothing rather than a mask when none is stored.
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
  if (incoming === '' || isMaskedKey(incoming)) {
    return { ...options, apiKey: configManager.getAPIKey('zotero.apiKey') };
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

  ipcMain.handle('zotero:synchronize', async (_event, rawOptions: unknown) => {
    const { expectedProjectPath, ...options } = withResolvedZoteroApiKey(
      validate(ZoteroSynchronizeSchema, rawOptions)
    );
    // Le projet vient du processus principal, jamais du renderer : c'est
    // lui qu'on va réécrire. Lu une fois, avant tout `await`.
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      return errorResponse(new Error('Aucun projet ouvert.'));
    }
    // Le renderer dit où l'on a cliqué : un accord donné dans A ne vaut pas pour B, ouvert
    // pendant la lecture de la collection (S07-1-0). Même fichier, pas même chaîne : un lien ou
    // `/private/var` ne doivent pas faire abandonner une synchronisation légitime.
    if (!sameFile(projectPath, expectedProjectPath)) {
      console.warn('⚠️ zotero:synchronize refusé : le projet a changé depuis la demande');
      return errorResponse('project-changed');
    }
    console.log('📞 IPC Call: zotero:synchronize', {
      mode: options.mode,
      collectionKey: options.collectionKey,
      confirmedDeletions: options.confirmation ? options.confirmation.deletedKeys.length : null,
    });
    try {
      const vectorStoreBefore = pdfService.getVectorStore();
      const result = await zoteroService.synchronizeProject({
        ...options,
        projectPath,
        // Le schéma exige `collectionChange` (nullable, pas optionnel) ; sans `strictNullChecks`,
        // le type que zod en déduit la dit optionnelle.
        confirmation: options.confirmation as SyncConfirmation | undefined,
      });

      // Relier les documents indexés à leurs collections Zotero.
      if (result.success && result.status === 'applied') {
        const store = vectorStoreIfStillCurrent(vectorStoreBefore);
        if (store) {
          // L'ensemble des collections du projet, et l'appartenance de chaque
          // référence, font foi : on les remplace. L'appartenance est gardée
          // pour les PDF indexés APRÈS cette synchronisation (#130).
          store.replaceCollections(result.collections ?? []);
          store.replaceCollectionMemberships(result.bibtexKeyToCollections ?? {});
          if (result.bibtexKeyToCollections && Object.keys(result.bibtexKeyToCollections).length > 0) {
            const linked = store.linkDocumentsToCollectionsByBibtexKey(result.bibtexKeyToCollections);
            console.log(`🔗 Linked ${linked} documents to their Zotero collections`);
          }
        }
      }

      console.log('📤 IPC Response: zotero:synchronize', {
        success: result.success,
        status: result.status,
        added: result.report?.added.length,
        modified: result.report?.modified.length,
        deleted: result.report?.deleted.length,
        written: result.written,
      });
      // Les listes de collections et de liens ne servent qu'ici.
      const { collections: _c, bibtexKeyToCollections: _l, ...forRenderer } = result;
      return forRenderer;
    } catch (error: unknown) {
      console.error('❌ zotero:synchronize error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('zotero:download-pdf', async (_event, rawOptions: unknown) => {
    const options = withResolvedZoteroApiKey(validate(ZoteroDownloadPDFSchema, rawOptions));
    console.log('📞 IPC Call: zotero:download-pdf', {
      mode: options.mode,
      attachmentKey: options.attachmentKey,
    });
    // Le PDF arrive dans `<targetDirectory>/PDFs` : seulement celui du projet ouvert, pas celui
    // d'un lot qui a survécu à l'ouverture d'un autre (S18-2-0).
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      return errorResponse(new Error('Aucun projet ouvert.'));
    }
    if (!sameFile(projectPath, options.targetDirectory)) {
      console.warn('⚠️ zotero:download-pdf refusé : ce n\'est pas le projet ouvert');
      return errorResponse('project-changed');
    }
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

  console.log('✅ Zotero handlers registered');
}
