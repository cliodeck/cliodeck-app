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
import { mcpClientsService } from '../../services/mcp-clients-service.js';
import { usageJournalService } from '../../services/usage-journal-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  ProjectCreateSchema,
  ProjectSaveSchema,
  BibliographySourceSchema,
  StringPathSchema,
  ProjectSetCSLPathSchema,
  ProjectUpdateConfigSchema,
  ProjectSaveChaptersSchema,
  ProjectCreateChapterSchema,
  ProjectBookSettingsSchema,
} from '../utils/validation.js';

export function setupProjectHandlers() {
  ipcMain.handle('project:get-recent', () => {
    console.log('📞 IPC Call: project:get-recent');
    const result = configManager.getRecentProjects();
    console.log('📤 IPC Response: project:get-recent', result);
    return result;
  });

  ipcMain.handle('project:remove-recent', (_event, rawPath: unknown) => {
    const path = validate(StringPathSchema, rawPath);
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

          // Initialize MCP clients (fire-and-forget so a dead server
          // doesn't block project loading).
          void mcpClientsService
            .loadProject(projectPath)
            .catch((e) =>
              console.warn('[mcp-clients] loadProject failed:', e)
            );

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
  ipcMain.handle('project:get-metadata', async (_event, rawPath: unknown) => {
    const path = validate(StringPathSchema, rawPath);
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

  ipcMain.handle('project:load', async (event, rawPath: unknown) => {
    const path = validate(StringPathSchema, rawPath);
    console.log('📞 IPC Call: project:load', { path });
    try {
      const result = await projectManager.loadProject(path);

      // Initialize services if project loaded successfully
      if (result.success) {
        const projectPath = projectManager.getCurrentProjectPath();
        if (projectPath) {
          console.log('🔧 Initializing services for project:', projectPath);

          // Initialize independent services in parallel
          await Promise.all([
            historyService.init(projectPath),
            Promise.resolve(modeService.init(projectPath)),
            Promise.resolve(usageJournalService.init(projectPath)),
            tropyService.init(projectPath),
          ]);

          // Initialize PDF service (depends on config, must run after)
          await pdfService.init(projectPath, (progress) => {
            event.sender.send('project:rebuild-progress', progress);
          });

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

      // Close Usage Journal Service (flush buffer, close DB)
      usageJournalService.close();

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

  // Le paramètre est le CHEMIN du projet (dossier ou project.json), pas un
  // `id` : bien des project.json n'en ont pas, et s'appuyer dessus rendait
  // le projet inouvrable.
  ipcMain.handle('project:get-chapters', async (_event, rawProjectPath: unknown) => {
    const projectPath = validate(StringPathSchema, rawProjectPath);
    console.log('📞 IPC Call: project:get-chapters', { projectPath });
    try {
      const result = await projectManager.getChapters(projectPath);
      console.log('📤 IPC Response: project:get-chapters', {
        chapters: result.chapters.length,
        unattached: result.unattached.length,
      });
      return result;
    } catch (error: any) {
      console.error('❌ project:get-chapters error:', error);
      return { success: false, chapters: [], unattached: [], error: error.message };
    }
  });

  ipcMain.handle('project:save-chapters', async (_event, rawData: unknown) => {
    console.log('📞 IPC Call: project:save-chapters');
    try {
      const data = validate(ProjectSaveChaptersSchema, rawData);
      const result = await projectManager.saveChapters(data);
      console.log('📤 IPC Response: project:save-chapters', result.success);
      return result;
    } catch (error: any) {
      console.error('❌ project:save-chapters error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:create-chapter', async (_event, rawData: unknown) => {
    console.log('📞 IPC Call: project:create-chapter');
    try {
      const data = validate(ProjectCreateChapterSchema, rawData);
      const result = await projectManager.createChapter(data);
      console.log('📤 IPC Response: project:create-chapter', result.success);
      return result;
    } catch (error: any) {
      console.error('❌ project:create-chapter error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:save-book-settings', async (_event, rawData: unknown) => {
    console.log('📞 IPC Call: project:save-book-settings');
    try {
      const data = validate(ProjectBookSettingsSchema, rawData);
      const result = await projectManager.saveBookSettings(data);
      console.log('📤 IPC Response: project:save-book-settings', result.success);
      return result;
    } catch (error: any) {
      console.error('❌ project:save-book-settings error:', error);
      return errorResponse(error);
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

  ipcMain.handle('project:set-csl-path', async (_event, rawData: unknown) => {
    const data = validate(ProjectSetCSLPathSchema, rawData);
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

  ipcMain.handle('project:get-config', async (_event, rawProjectPath: unknown) => {
    const projectPath = validate(StringPathSchema, rawProjectPath);
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

  ipcMain.handle('project:update-config', async (_event, rawProjectPath: unknown, rawUpdates: unknown) => {
    const { projectPath, updates } = validate(ProjectUpdateConfigSchema, { projectPath: rawProjectPath, updates: rawUpdates });
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
