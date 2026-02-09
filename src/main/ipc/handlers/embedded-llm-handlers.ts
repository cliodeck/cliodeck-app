/**
 * IPC handlers pour la gestion du LLM embarqué
 * Gère le téléchargement, la configuration et le statut du modèle embarqué
 */

import { ipcMain, app, BrowserWindow } from 'electron';
import { ModelDownloader, type DownloadProgress } from '../../../../backend/core/llm/ModelDownloader.js';
import { EMBEDDED_MODELS, DEFAULT_EMBEDDED_MODEL } from '../../../../backend/core/llm/EmbeddedLLMClient.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { configManager } from '../../services/config-manager.js';
import { pdfService } from '../../services/pdf-service.js';

let downloader: ModelDownloader | null = null;

/**
 * Initialise le downloader avec le chemin userData
 */
function getDownloader(): ModelDownloader {
  if (!downloader) {
    downloader = new ModelDownloader(app.getPath('userData'));
  }
  return downloader;
}

export function setupEmbeddedLLMHandlers() {
  // Vérifier si un modèle est téléchargé
  ipcMain.handle('embedded-llm:is-downloaded', async (_event, modelId?: string) => {
    console.log('📞 IPC Call: embedded-llm:is-downloaded', { modelId });
    try {
      const dl = getDownloader();
      const downloaded = dl.isModelDownloaded(modelId || DEFAULT_EMBEDDED_MODEL);
      console.log('📤 IPC Response: embedded-llm:is-downloaded', { downloaded });
      return successResponse({ downloaded });
    } catch (error: any) {
      console.error('❌ embedded-llm:is-downloaded error:', error);
      return errorResponse(error);
    }
  });

  // Obtenir le chemin du modèle
  ipcMain.handle('embedded-llm:get-model-path', async (_event, modelId?: string) => {
    console.log('📞 IPC Call: embedded-llm:get-model-path', { modelId });
    try {
      const dl = getDownloader();
      const path = dl.getModelPath(modelId || DEFAULT_EMBEDDED_MODEL);
      const downloaded = dl.isModelDownloaded(modelId || DEFAULT_EMBEDDED_MODEL);
      console.log('📤 IPC Response: embedded-llm:get-model-path', { path, downloaded });
      return successResponse({ path, downloaded });
    } catch (error: any) {
      console.error('❌ embedded-llm:get-model-path error:', error);
      return errorResponse(error);
    }
  });

  // Lister tous les modèles disponibles
  ipcMain.handle('embedded-llm:list-models', async () => {
    console.log('📞 IPC Call: embedded-llm:list-models');
    try {
      const dl = getDownloader();
      const models = dl.getAvailableModels();
      console.log('📤 IPC Response: embedded-llm:list-models', { count: models.length });
      return successResponse({ models });
    } catch (error: any) {
      console.error('❌ embedded-llm:list-models error:', error);
      return errorResponse(error);
    }
  });

  // Obtenir les infos d'un modèle spécifique
  ipcMain.handle('embedded-llm:get-model-info', async (_event, modelId?: string) => {
    console.log('📞 IPC Call: embedded-llm:get-model-info', { modelId });
    try {
      const dl = getDownloader();
      const info = dl.getModelInfo(modelId || DEFAULT_EMBEDDED_MODEL);
      const downloaded = dl.isModelDownloaded(modelId || DEFAULT_EMBEDDED_MODEL);
      console.log('📤 IPC Response: embedded-llm:get-model-info', { info, downloaded });
      return successResponse({ ...info, downloaded });
    } catch (error: any) {
      console.error('❌ embedded-llm:get-model-info error:', error);
      return errorResponse(error);
    }
  });

  // Télécharger un modèle
  ipcMain.handle('embedded-llm:download', async (event, modelId?: string) => {
    console.log('📞 IPC Call: embedded-llm:download', { modelId });
    const dl = getDownloader();
    const targetModelId = modelId || DEFAULT_EMBEDDED_MODEL;

    // Vérifier si déjà en cours de téléchargement
    if (dl.isDownloadInProgress()) {
      return errorResponse(new Error('Un téléchargement est déjà en cours'));
    }

    try {
      const modelPath = await dl.downloadModel(targetModelId, (progress: DownloadProgress) => {
        // Envoyer la progression au renderer
        event.sender.send('embedded-llm:download-progress', progress);

        // Aussi envoyer à toutes les fenêtres (pour les notifications)
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win.webContents !== event.sender) {
            win.webContents.send('embedded-llm:download-progress', progress);
          }
        });
      });

      // Mettre à jour la configuration avec le nouveau chemin
      const llmConfig = configManager.get('llm');
      configManager.set('llm', {
        ...llmConfig,
        embeddedModelPath: modelPath,
        embeddedModelId: targetModelId,
      });

      // Charger immédiatement le modèle dans le LLMProviderManager si un projet est ouvert
      // Cela permet d'utiliser le modèle sans avoir à recharger le projet
      const modelLoadSuccess = await pdfService.updateEmbeddedModel(modelPath, targetModelId);

      if (!modelLoadSuccess) {
        // Model failed to load - it's likely corrupted despite passing basic checks
        console.error('❌ [EMBEDDED] Model downloaded but failed to load - deleting corrupted file');
        dl.deleteCorruptedModel(targetModelId);

        // Clear the config since the model is invalid
        configManager.set('llm', {
          ...llmConfig,
          embeddedModelPath: undefined,
          embeddedModelId: undefined,
        });

        return errorResponse(new Error(
          'Le modèle a été téléchargé mais n\'a pas pu être chargé (fichier corrompu). ' +
          'Le fichier a été supprimé. Veuillez réessayer le téléchargement.'
        ));
      }

      console.log(`📤 IPC Response: embedded-llm:download - success`, { modelPath });
      return successResponse({ modelPath, modelId: targetModelId, loaded: true });
    } catch (error: any) {
      console.error('❌ embedded-llm:download error:', error);
      return errorResponse(error);
    }
  });

  // Annuler un téléchargement en cours
  ipcMain.handle('embedded-llm:cancel-download', async () => {
    console.log('📞 IPC Call: embedded-llm:cancel-download');
    try {
      const dl = getDownloader();
      const cancelled = dl.cancelDownload();
      console.log('📤 IPC Response: embedded-llm:cancel-download', { cancelled });
      return successResponse({ cancelled });
    } catch (error: any) {
      console.error('❌ embedded-llm:cancel-download error:', error);
      return errorResponse(error);
    }
  });

  // Supprimer un modèle téléchargé
  ipcMain.handle('embedded-llm:delete-model', async (_event, modelId?: string) => {
    console.log('📞 IPC Call: embedded-llm:delete-model', { modelId });
    try {
      const dl = getDownloader();
      const targetModelId = modelId || DEFAULT_EMBEDDED_MODEL;
      const deleted = dl.deleteModel(targetModelId);

      // Si c'est le modèle actuellement configuré, nettoyer la config et désactiver dans LLMProviderManager
      const llmConfig = configManager.get('llm');
      if (llmConfig.embeddedModelId === targetModelId) {
        configManager.set('llm', {
          ...llmConfig,
          embeddedModelPath: undefined,
          embeddedModelId: undefined,
        });

        // Désactiver le modèle dans le LLMProviderManager
        await pdfService.disableEmbeddedModel();
      }

      console.log('📤 IPC Response: embedded-llm:delete-model', { deleted });
      return successResponse({ deleted });
    } catch (error: any) {
      console.error('❌ embedded-llm:delete-model error:', error);
      return errorResponse(error);
    }
  });

  // Obtenir l'espace disque utilisé par les modèles
  ipcMain.handle('embedded-llm:get-used-space', async () => {
    console.log('📞 IPC Call: embedded-llm:get-used-space');
    try {
      const dl = getDownloader();
      const usage = dl.getUsedSpace();
      console.log('📤 IPC Response: embedded-llm:get-used-space', usage);
      return successResponse(usage);
    } catch (error: any) {
      console.error('❌ embedded-llm:get-used-space error:', error);
      return errorResponse(error);
    }
  });

  // Obtenir le répertoire des modèles
  ipcMain.handle('embedded-llm:get-models-directory', async () => {
    console.log('📞 IPC Call: embedded-llm:get-models-directory');
    try {
      const dl = getDownloader();
      const directory = dl.getModelsDirectory();
      console.log('📤 IPC Response: embedded-llm:get-models-directory', { directory });
      return successResponse({ directory });
    } catch (error: any) {
      console.error('❌ embedded-llm:get-models-directory error:', error);
      return errorResponse(error);
    }
  });

  // Vérifier si un téléchargement est en cours
  ipcMain.handle('embedded-llm:is-downloading', async () => {
    console.log('📞 IPC Call: embedded-llm:is-downloading');
    try {
      const dl = getDownloader();
      const downloading = dl.isDownloadInProgress();
      return successResponse({ downloading });
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  // Définir le provider LLM préféré
  ipcMain.handle('embedded-llm:set-provider', async (_event, provider: 'ollama' | 'embedded' | 'auto') => {
    console.log('📞 IPC Call: embedded-llm:set-provider', { provider });
    try {
      const llmConfig = configManager.get('llm');
      configManager.set('llm', {
        ...llmConfig,
        generationProvider: provider,
      });
      console.log('📤 IPC Response: embedded-llm:set-provider - success');
      return successResponse({ provider });
    } catch (error: any) {
      console.error('❌ embedded-llm:set-provider error:', error);
      return errorResponse(error);
    }
  });

  // Obtenir le provider LLM actuel
  ipcMain.handle('embedded-llm:get-provider', async () => {
    console.log('📞 IPC Call: embedded-llm:get-provider');
    try {
      const llmConfig = configManager.get('llm');
      const provider = llmConfig.generationProvider || 'auto';
      return successResponse({ provider });
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  console.log('✅ Embedded LLM handlers registered');
}
