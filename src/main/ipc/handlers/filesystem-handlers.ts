/**
 * Filesystem and Dialog IPC handlers
 */
import { ipcMain, dialog, shell } from 'electron';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validateReadPath, validateWritePath } from '../utils/path-validator.js';
import {
  validate,
  FsReadDirectorySchema,
  FsWriteFileSchema,
  FsReadFileSchema,
  FsCopyFileSchema,
  StringPathSchema,
  StringUrlSchema,
  DialogOpenFileSchema,
  DialogSaveFileSchema,
} from '../utils/validation.js';
import { logger } from '../../utils/logger.js';

export function setupFilesystemHandlers() {
  // Filesystem handlers
  ipcMain.handle('fs:read-directory', async (_event, rawDirPath: unknown) => {
    const { dirPath } = validate(FsReadDirectorySchema, { dirPath: rawDirPath });
    logger.info('ipc', 'fs:read-directory', { dirPath });
    try {
      const validatedPath = await validateReadPath(dirPath);
      const { readdir, stat } = await import('fs/promises');
      const path = await import('path');

      const entries = await readdir(validatedPath);
      const items = await Promise.all(
        entries.map(async (name) => {
          const fullPath = path.join(dirPath, name);
          try {
            const stats = await stat(fullPath);
            return {
              name,
              path: fullPath,
              isDirectory: stats.isDirectory(),
              isFile: stats.isFile(),
            };
          } catch (error) {
            logger.warn('ipc', 'fs:read-directory:stat-failed', { fullPath, error: error instanceof Error ? error.message : String(error) });
            return null;
          }
        })
      );

      // Filter out null entries and sort: directories first, then files
      const validItems = items.filter(
        (item): item is NonNullable<typeof item> => item !== null
      );
      const sorted = validItems.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      logger.info('ipc', 'fs:read-directory:response', { itemCount: sorted.length });
      return successResponse({ items: sorted });
    } catch (error: any) {
      logger.error('ipc', 'fs:read-directory', { error: error instanceof Error ? error.message : String(error) });
      return { ...errorResponse(error), items: [] };
    }
  });

  ipcMain.handle('fs:exists', async (_event, rawFilePath: unknown) => {
    const filePath = validate(StringPathSchema, rawFilePath);
    logger.info('ipc', 'fs:exists', { filePath });
    try {
      const validatedPath = await validateReadPath(filePath);
      const { access } = await import('fs/promises');
      await access(validatedPath);
      logger.debug('ipc', 'fs:exists:response', { filePath, exists: true });
      return true;
    } catch {
      logger.debug('ipc', 'fs:exists:response', { filePath, exists: false });
      return false;
    }
  });

  ipcMain.handle('fs:read-file', async (_event, rawFilePath: unknown) => {
    const { filePath } = validate(FsReadFileSchema, { filePath: rawFilePath });
    logger.info('ipc', 'fs:read-file', { filePath });
    try {
      const validatedPath = await validateReadPath(filePath);
      const { readFile } = await import('fs/promises');
      const content = await readFile(validatedPath, 'utf-8');
      logger.info('ipc', 'fs:read-file:response', { contentLength: content.length });
      return content;
    } catch (error: any) {
      logger.error('ipc', 'fs:read-file', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  ipcMain.handle('fs:write-file', async (_event, rawFilePath: unknown, rawContent: unknown) => {
    const { filePath, content } = validate(FsWriteFileSchema, { filePath: rawFilePath, content: rawContent });
    console.log('📞 IPC Call: fs:write-file', { filePath, contentLength: content.length });
    try {
      const validatedPath = await validateWritePath(filePath);
      const { writeFile } = await import('fs/promises');
      await writeFile(validatedPath, content, 'utf-8');
      console.log('📤 IPC Response: fs:write-file - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ fs:write-file error:', error);
      throw error;
    }
  });

  ipcMain.handle('fs:copy-file', async (_event, rawSource: unknown, rawTarget: unknown) => {
    const { source: sourcePath, destination: targetPath } = validate(FsCopyFileSchema, { source: rawSource, destination: rawTarget });
    console.log('📞 IPC Call: fs:copy-file', { sourcePath, targetPath });
    try {
      const validatedSource = await validateReadPath(sourcePath);
      const validatedTarget = await validateWritePath(targetPath);
      const { copyFile } = await import('fs/promises');
      await copyFile(validatedSource, validatedTarget);
      console.log('📤 IPC Response: fs:copy-file - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ fs:copy-file error:', error);
      throw error;
    }
  });

  // Dialog handlers
  ipcMain.handle('dialog:open-file', async (_event, rawOptions: unknown) => {
    const options = validate(DialogOpenFileSchema, rawOptions);
    console.log('📞 IPC Call: dialog:open-file', options);
    const result = await dialog.showOpenDialog(options as any);
    console.log('📤 IPC Response: dialog:open-file', {
      canceled: result.canceled,
      fileCount: result.filePaths?.length,
    });
    return result;
  });

  ipcMain.handle('dialog:save-file', async (_event, rawOptions: unknown) => {
    const options = validate(DialogSaveFileSchema, rawOptions);
    console.log('📞 IPC Call: dialog:save-file', options);
    const result = await dialog.showSaveDialog(options as any);
    console.log('📤 IPC Response: dialog:save-file', {
      canceled: result.canceled,
      filePath: result.filePath,
    });
    return result;
  });

  // Shell handlers
  ipcMain.handle('shell:open-external', async (_event, rawUrl: unknown) => {
    const url = validate(StringUrlSchema, rawUrl);
    console.log('📞 IPC Call: shell:open-external', { url });
    try {
      // Security: validate URL protocol to prevent arbitrary scheme execution
      const parsed = new URL(url);
      const allowedProtocols = ['https:', 'http:', 'mailto:'];
      if (!allowedProtocols.includes(parsed.protocol)) {
        throw new Error(`Blocked protocol: ${parsed.protocol}. Only http, https and mailto are allowed.`);
      }
      await shell.openExternal(url);
      console.log('📤 IPC Response: shell:open-external - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ shell:open-external error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('shell:open-path', async (_event, rawPath: unknown) => {
    const path = validate(StringPathSchema, rawPath);
    console.log('📞 IPC Call: shell:open-path', { path });
    try {
      const result = await shell.openPath(path);
      if (result) {
        // shell.openPath returns non-empty string on failure
        console.error('❌ shell:open-path failed:', result);
        return errorResponse(result);
      }
      console.log('📤 IPC Response: shell:open-path - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ shell:open-path error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Filesystem handlers registered');
}
