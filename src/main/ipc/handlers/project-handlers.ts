/**
 * Project management IPC handlers
 *
 * Créer, ouvrir et fermer un projet passent par une seule séquence (`project-lifecycle`, L03-3) :
 * une file, et la même table de services (`project-services`). Aucun handler n'appelle plus
 * `projectManager.loadProject` lui-même.
 */
import path from 'path';
import { ipcMain, BrowserWindow, type WebContents } from 'electron';
import { configManager } from '../../services/config-manager.js';
import { projectManager } from '../../services/project-manager.js';
import { mcpClientsService } from '../../services/mcp-clients-service.js';
import {
  createProjectLifecycle,
  type ProjectLifecycle,
  type ProjectOpenResult,
  type UnrequestedClose,
} from '../../services/project-lifecycle.js';
import {
  projectServices,
  ProjectServiceError,
  type LoadedProject,
  type ProjectOpenRequest,
} from '../../services/project-services.js';
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
  ProjectReadChaptersSchema,
  ProjectBookSettingsSchema,
} from '../utils/validation.js';

/**
 * La réponse d'une exception levée hors de la séquence. Un service en panne n'arrive plus ici : la
 * séquence répond `services_failed`, et son journal nomme le service.
 */
function projectFailure(channel: 'project:create' | 'project:load', error: unknown) {
  if (error instanceof ProjectServiceError) {
    console.error(`❌ ${channel} error:`, `service ${error.service} :`, error.cause);
    return { success: false, code: 'services_failed', error: error.message };
  }
  console.error(`❌ ${channel} error:`, error);
  return errorResponse(error);
}

/**
 * La séquence a fermé le projet d'elle-même : le renderer le croit encore ouvert, et le validateur
 * refuserait ses enregistrements sans rien dire. Il l'apprend par `project:closed`, avec le code
 * qu'il traduit.
 */
export function relayUnrequestedClose(closed: UnrequestedClose): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send('project:closed', { path: closed.path, code: closed.code, error: closed.error });
  }
}

/** Le suivi de reconstruction de l'index, vers la fenêtre qui a demandé l'ouverture, tant qu'elle vit. */
function openRequestFrom(sender: WebContents): ProjectOpenRequest {
  return {
    onRebuildProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send('project:rebuild-progress', progress);
    },
  };
}

function logOpenResult(channel: 'project:create' | 'project:load', result: ProjectOpenResult<LoadedProject>): void {
  // Un refus porte `restoredPath` : le projet ouvert après lui.
  if ('restoredPath' in result) {
    console.log(`📤 IPC Response: ${channel} failed`, {
      code: result.code,
      error: result.error,
      restoredPath: result.restoredPath,
    });
    return;
  }
  console.log(`📤 IPC Response: ${channel} success`, result.warnings.length ? { warnings: result.warnings } : '');
}

export function setupProjectHandlers() {
  const lifecycle: ProjectLifecycle<LoadedProject, ProjectOpenRequest> = createProjectLifecycle<
    LoadedProject,
    ProjectOpenRequest
  >({
    manager: projectManager,
    services: projectServices(),
    onUnrequestedClose: relayUnrequestedClose,
  });

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
      // Écrit sans devenir le projet courant : un refus (`project_exists`…) arrive avant toute
      // fermeture, et le projet ouvert reste tel quel.
      const created = await projectManager.createProject(validatedData);
      if (!created.success) {
        console.log('📤 IPC Response: project:create', created);
        return created;
      }

      // Puis il s'ouvre comme tout projet : journal d'usage compris (S11-1-4).
      const result = await lifecycle.open(created.path, openRequestFrom(event.sender));
      logOpenResult('project:create', result);
      if (result.success && result.configIssue?.kind !== 'linked_outside') {
        // Comme avant pour un projet créé : un `config.json` neuf, aucun serveur à approuver. Sans
        // attente, pour qu'un serveur mort ne retienne pas l'ouverture (A10 : seule la création).
        void mcpClientsService
          .loadProject(path.dirname(created.path))
          .catch((e) => console.warn('[mcp-clients] loadProject failed:', e));
      }
      return result;
    } catch (error: unknown) {
      return projectFailure('project:create', error);
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
    } catch (error: unknown) {
      console.error('❌ project:get-metadata error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:load', async (event, rawPath: unknown) => {
    const path = validate(StringPathSchema, rawPath);
    console.log('📞 IPC Call: project:load', { path });
    try {
      // Le projet d'avant se ferme, services compris, avant que B s'ouvre ; en cas d'échec, il revient
      // (`restoredPath`), ou plus aucun projet n'est ouvert (null).
      const result = await lifecycle.open(path, openRequestFrom(event.sender));
      logOpenResult('project:load', result);
      return result;
    } catch (error: unknown) {
      return projectFailure('project:load', error);
    }
  });

  ipcMain.handle('project:close', async () => {
    console.log('📞 IPC Call: project:close');
    try {
      // Ne répond qu'une fois tout fermé : les indexations en vol ont fini d'écrire, et le main n'a
      // plus de projet courant (S01-1-9, S11-1-20).
      await lifecycle.close();
      console.log('📤 IPC Response: project:close - success');
      return successResponse();
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      console.error('❌ project:get-chapters error:', error);
      return { ...errorResponse(error), chapters: [], unattached: [] };
    }
  });

  ipcMain.handle('project:save-chapters', async (_event, rawData: unknown) => {
    console.log('📞 IPC Call: project:save-chapters');
    try {
      const data = validate(ProjectSaveChaptersSchema, rawData);
      const result = await projectManager.saveChapters(data);
      console.log('📤 IPC Response: project:save-chapters', result.success);
      return result;
    } catch (error: unknown) {
      console.error('❌ project:save-chapters error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('project:read-chapters', async (_event, rawData: unknown) => {
    try {
      const data = validate(ProjectReadChaptersSchema, rawData);
      const result = await projectManager.readChapters(data);
      return result;
    } catch (error: unknown) {
      console.error('❌ project:read-chapters error:', error);
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      console.error('❌ project:update-config error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Project handlers registered');
}
