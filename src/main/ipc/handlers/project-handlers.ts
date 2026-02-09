/**
 * Project management IPC handlers
 */
import { ipcMain } from 'electron';
import { configManager } from '../../services/config-manager.js';
import { projectManager } from '../../services/project-manager.js';
import { historyService } from '../../services/history-service.js';
import { modeService } from '../../services/mode-service.js';
import { pdfService } from '../../services/pdf-service.js';
import { tropyService } from '../../services/tropy-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validate, ProjectCreateSchema, ProjectSaveSchema, BibliographySourceSchema } from '../utils/validation.js';

export function setupProjectHandlers() {
  ipcMain.handle('project:get-recent', () => {
    console.log('📞 IPC Call: project:get-recent');
    const result = configManager.getRecentProjects();
    console.log('📤 IPC Response: project:get-recent', result);
    return result;
  });

  ipcMain.handle('project:remove-recent', (_event, path: string) => {
    console.log('📞 IPC Call: project:remove-recent', { path });
    configManager.removeRecentProject(path);
    console.log('📤 IPC Response: project:remove-recent success');
    return successResponse();
  });

  ipcMain.handle('project:create', async (event, data: unknown) => {
    console.log('📞 IPC Call: project:create', data);
    try {
      const validatedData = validate(ProjectCreateSchema, data);
      const result = await projectManager.createProject(validatedData);

      // Initialize services if project created successfully
      if (result.success) {
        const projectPath = projectManager.getCurrentProjectPath();
        if (projectPath) {
          console.log('🔧 Initializing services for new project:', projectPath);
          await historyService.init(projectPath);
          modeService.init(projectPath);

          // Initialize PDF service with rebuild progress callback
          await pdfService.init(projectPath, (progress) => {
            event.sender.send('project:rebuild-progress', progress);
          });

          // Initialize Tropy service
          await tropyService.init(projectPath);

          console.log('✅ All services initialized successfully');
        }
      }

      console.log('📤 IPC Response: project:create', result);
      return result;
    } catch (error: any) {
      console.error('❌ project:create error:', error);
      return errorResponse(error);
    }
  });

  // Get project metadata without initializing services (for recent projects list)
  // IMPORTANT: Use getProjectMetadata() to avoid changing currentProject/currentProjectPath
  ipcMain.handle('project:get-metadata', async (_event, path: string) => {
    console.log('📞 IPC Call: project:get-metadata', { path });
    try {
      // Use getProjectMetadata to read without affecting current project state
      const result = await projectManager.getProjectMetadata(path);
      console.log('📤 IPC Response: project:get-metadata', result.success ? 'success' : 'failed');
      return result;
    } catch (error: any) {
      console.error('❌ project:get-metadata error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:load', async (event, path: string) => {
    console.log('📞 IPC Call: project:load', { path });
    try {
      const result = await projectManager.loadProject(path);

      // Initialize services if project loaded successfully
      if (result.success) {
        const projectPath = projectManager.getCurrentProjectPath();
        if (projectPath) {
          console.log('🔧 Initializing services for project:', projectPath);
          await historyService.init(projectPath);
          modeService.init(projectPath);

          // Initialize PDF service with rebuild progress callback
          await pdfService.init(projectPath, (progress) => {
            event.sender.send('project:rebuild-progress', progress);
          });

          // Initialize Tropy service
          await tropyService.init(projectPath);

          console.log('✅ All services initialized successfully');
        }
      }

      console.log('📤 IPC Response: project:load', result.success ? 'success' : 'failed');
      return result;
    } catch (error: any) {
      console.error('❌ project:load error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:close', async () => {
    console.log('📞 IPC Call: project:close');
    try {
      // Close Mode Service (reset active mode)
      modeService.close();

      // Close History Service (ends session and closes DB)
      historyService.close();

      // Close PDF Service and free resources
      pdfService.close();

      // Close Tropy Service and free resources
      await tropyService.close();

      console.log('📤 IPC Response: project:close - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ project:close error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:save', async (_event, data: unknown) => {
    console.log('📞 IPC Call: project:save');
    try {
      const validatedData = validate(ProjectSaveSchema, data);
      console.log('  path:', validatedData.path, 'contentLength:', validatedData.content?.length);
      const result = await projectManager.saveProject(validatedData);
      console.log('📤 IPC Response: project:save', result);
      return result;
    } catch (error: any) {
      console.error('❌ project:save error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:get-chapters', async (_event, projectId: string) => {
    console.log('📞 IPC Call: project:get-chapters', { projectId });
    try {
      const result = await projectManager.getChapters(projectId);
      console.log('📤 IPC Response: project:get-chapters', result);
      return result;
    } catch (error: any) {
      console.error('❌ project:get-chapters error:', error);
      return { success: false, chapters: [], error: error.message };
    }
  });

  ipcMain.handle('project:set-bibliography-source', async (_event, data: unknown) => {
    console.log('📞 IPC Call: project:set-bibliography-source', data);
    try {
      const validatedData = validate(BibliographySourceSchema, data);
      const result = await projectManager.setBibliographySource(validatedData);
      console.log('📤 IPC Response: project:set-bibliography-source', result);
      return result;
    } catch (error: any) {
      console.error('❌ project:set-bibliography-source error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:set-csl-path', async (_event, data: { projectPath: string; cslPath?: string }) => {
    console.log('📞 IPC Call: project:set-csl-path', data);
    try {
      const result = await projectManager.setCSLPath(data);
      console.log('📤 IPC Response: project:set-csl-path', result);
      return result;
    } catch (error: any) {
      console.error('❌ project:set-csl-path error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:get-config', async (_event, projectPath: string) => {
    console.log('📞 IPC Call: project:get-config', { projectPath });
    try {
      const config = await projectManager.getConfig(projectPath);
      console.log('📤 IPC Response: project:get-config', config ? 'success' : 'not found');
      return config;
    } catch (error: any) {
      console.error('❌ project:get-config error:', error);
      return null;
    }
  });

  ipcMain.handle('project:update-config', async (_event, projectPath: string, updates: any) => {
    console.log('📞 IPC Call: project:update-config', { projectPath, updates });
    try {
      const result = await projectManager.updateConfig(projectPath, updates);
      console.log('📤 IPC Response: project:update-config', result);
      return result;
    } catch (error: any) {
      console.error('❌ project:update-config error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Project handlers registered');
}
