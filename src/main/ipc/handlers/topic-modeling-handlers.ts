/**
 * Topic Modeling IPC handlers
 * Gestion manuelle de l'installation et du statut de l'environnement Python
 */
import { ipcMain } from 'electron';
import { topicModelingService } from '../../services/topic-modeling-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupTopicModelingHandlers() {
  /**
   * Vérifie le statut de l'environnement Python
   */
  ipcMain.handle('topic-modeling:check-status', async () => {
    console.log('📞 IPC Call: topic-modeling:check-status');
    try {
      const status = await topicModelingService.checkEnvironmentStatus();
      console.log('📤 IPC Response: topic-modeling:check-status', status);
      return successResponse(status);
    } catch (error: unknown) {
      console.error('❌ topic-modeling:check-status error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Install ou réinstalle l'environnement Python
   */
  ipcMain.handle('topic-modeling:setup-environment', async (event) => {
    console.log('📞 IPC Call: topic-modeling:setup-environment');
    try {
      // Fonction pour envoyer les messages de progression au frontend
      const onProgress = (message: string) => {
        event.sender.send('topic-modeling:setup-progress', message);
      };

      const result = await topicModelingService.setupEnvironment(onProgress);

      console.log('📤 IPC Response: topic-modeling:setup-environment', result);
      return successResponse(result);
    } catch (error: unknown) {
      console.error('❌ topic-modeling:setup-environment error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Topic modeling handlers registered');
}
