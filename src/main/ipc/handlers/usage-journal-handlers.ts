/**
 * Journal d'usage IA — IPC handlers (espace `usage:*`).
 *
 * STRICTEMENT séparé du journal de recherche (`history:*`). L'UI ne fait que lire le
 * résumé du jour et enregistrer des décisions ; toute la capture vit côté main.
 */
import { ipcMain } from 'electron';
import { usageJournalService } from '../../services/usage-journal-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  UsageSaveDecisionSchema,
  UsageSetModeSchema,
} from '../utils/validation.js';

export function setupUsageJournalHandlers() {
  // Résumé du jour + décisions du jour.
  ipcMain.handle('usage:get-today', async () => {
    try {
      const today = usageJournalService.getToday();
      if (!today) {
        return { ...errorResponse('No project open'), today: null };
      }
      return successResponse({ today });
    } catch (error: any) {
      console.error('❌ usage:get-today error:', error);
      return { ...errorResponse(error), today: null };
    }
  });

  // Enregistre/met à jour une décision + rattachements de sessions ; renvoie la vue rafraîchie.
  ipcMain.handle('usage:save-decision', async (_event, rawInput: unknown) => {
    const input = validate(UsageSaveDecisionSchema, rawInput);
    try {
      const today = usageJournalService.saveDecision(input);
      if (!today) {
        return { ...errorResponse('No project open'), today: null };
      }
      return successResponse({ today });
    } catch (error: any) {
      console.error('❌ usage:save-decision error:', error);
      return { ...errorResponse(error), today: null };
    }
  });

  // Miroir du mode applicatif (poussé par le renderer sur changement de workspace-mode).
  ipcMain.handle('usage:set-mode', async (_event, rawMode: unknown) => {
    const mode = validate(UsageSetModeSchema, rawMode);
    try {
      usageJournalService.setActiveMode(mode);
      return successResponse();
    } catch (error: any) {
      console.error('❌ usage:set-mode error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Usage journal handlers registered (3 handlers)');
}
