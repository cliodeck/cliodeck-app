/**
 * Mode management IPC handlers
 */
import { ipcMain } from 'electron';
import { modeService } from '../../services/mode-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupModeHandlers() {
  // List all available modes (builtin + global + project)
  ipcMain.handle('mode:get-all', async () => {
    console.log('📞 IPC Call: mode:get-all');
    try {
      const modes = await modeService.getModeManager().getAllModes();
      console.log('📤 IPC Response: mode:get-all', { count: modes.length });
      return successResponse({ modes });
    } catch (error: any) {
      console.error('❌ mode:get-all error:', error);
      return errorResponse(error);
    }
  });

  // Get a specific mode by ID
  ipcMain.handle('mode:get', async (_event, modeId: string) => {
    console.log('📞 IPC Call: mode:get', { modeId });
    try {
      const mode = await modeService.getModeManager().getMode(modeId);
      if (!mode) {
        return errorResponse(`Mode not found: ${modeId}`);
      }
      return successResponse({ mode });
    } catch (error: any) {
      console.error('❌ mode:get error:', error);
      return errorResponse(error);
    }
  });

  // Get the currently active mode
  ipcMain.handle('mode:get-active', async () => {
    console.log('📞 IPC Call: mode:get-active');
    try {
      const id = modeService.getActiveModeId();
      const mode = await modeService.getActiveMode();
      return successResponse({ id, mode });
    } catch (error: any) {
      console.error('❌ mode:get-active error:', error);
      return errorResponse(error);
    }
  });

  // Set the active mode
  ipcMain.handle('mode:set-active', async (_event, modeId: string) => {
    console.log('📞 IPC Call: mode:set-active', { modeId });
    try {
      modeService.setActiveMode(modeId);
      return successResponse();
    } catch (error: any) {
      console.error('❌ mode:set-active error:', error);
      return errorResponse(error);
    }
  });

  // Save a custom mode (create or update)
  ipcMain.handle('mode:save', async (_event, mode: any, target: 'global' | 'project') => {
    console.log('📞 IPC Call: mode:save', { modeId: mode?.metadata?.id, target });
    try {
      const filePath = await modeService.getModeManager().saveMode(mode, target);
      return successResponse({ filePath });
    } catch (error: any) {
      console.error('❌ mode:save error:', error);
      return errorResponse(error);
    }
  });

  // Delete a custom mode
  ipcMain.handle('mode:delete', async (_event, modeId: string, source: 'global' | 'project') => {
    console.log('📞 IPC Call: mode:delete', { modeId, source });
    try {
      await modeService.getModeManager().deleteMode(modeId, source);
      return successResponse();
    } catch (error: any) {
      console.error('❌ mode:delete error:', error);
      return errorResponse(error);
    }
  });

  // Import a mode from file path
  ipcMain.handle('mode:import', async (_event, filePath: string, target: 'global' | 'project') => {
    console.log('📞 IPC Call: mode:import', { filePath, target });
    try {
      const mode = await modeService.getModeManager().importMode(filePath, target);
      return successResponse({ mode });
    } catch (error: any) {
      console.error('❌ mode:import error:', error);
      return errorResponse(error);
    }
  });

  // Export a mode to file path
  ipcMain.handle('mode:export', async (_event, modeId: string, outputPath: string) => {
    console.log('📞 IPC Call: mode:export', { modeId, outputPath });
    try {
      await modeService.getModeManager().exportMode(modeId, outputPath);
      return successResponse();
    } catch (error: any) {
      console.error('❌ mode:export error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Mode handlers registered (8 handlers)');
}
