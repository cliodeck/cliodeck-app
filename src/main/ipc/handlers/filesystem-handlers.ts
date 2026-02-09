/**
 * Filesystem and Dialog IPC handlers
 */
import { ipcMain, dialog, shell } from 'electron';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupFilesystemHandlers() {
  // Filesystem handlers
  ipcMain.handle('fs:read-directory', async (_event, dirPath: string) => {
    console.log('📞 IPC Call: fs:read-directory', { dirPath });
    try {
      const { readdir, stat } = await import('fs/promises');
      const path = await import('path');

      const entries = await readdir(dirPath);
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
            console.warn(`⚠️ Could not stat ${fullPath}:`, error);
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

      console.log('📤 IPC Response: fs:read-directory', { itemCount: sorted.length });
      return successResponse({ items: sorted });
    } catch (error: any) {
      console.error('❌ fs:read-directory error:', error);
      return { ...errorResponse(error), items: [] };
    }
  });

  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    console.log('📞 IPC Call: fs:exists', { filePath });
    try {
      const { access } = await import('fs/promises');
      await access(filePath);
      console.log('📤 IPC Response: fs:exists - true');
      return true;
    } catch {
      console.log('📤 IPC Response: fs:exists - false');
      return false;
    }
  });

  ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
    console.log('📞 IPC Call: fs:read-file', { filePath });
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf-8');
      console.log('📤 IPC Response: fs:read-file', { contentLength: content.length });
      return content;
    } catch (error: any) {
      console.error('❌ fs:read-file error:', error);
      throw error;
    }
  });

  ipcMain.handle('fs:write-file', async (_event, filePath: string, content: string) => {
    console.log('📞 IPC Call: fs:write-file', { filePath, contentLength: content.length });
    try {
      const { writeFile } = await import('fs/promises');
      await writeFile(filePath, content, 'utf-8');
      console.log('📤 IPC Response: fs:write-file - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ fs:write-file error:', error);
      throw error;
    }
  });

  ipcMain.handle('fs:copy-file', async (_event, sourcePath: string, targetPath: string) => {
    console.log('📞 IPC Call: fs:copy-file', { sourcePath, targetPath });
    try {
      const { copyFile } = await import('fs/promises');
      await copyFile(sourcePath, targetPath);
      console.log('📤 IPC Response: fs:copy-file - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ fs:copy-file error:', error);
      throw error;
    }
  });

  // Dialog handlers
  ipcMain.handle('dialog:open-file', async (_event, options: any) => {
    console.log('📞 IPC Call: dialog:open-file', options);
    const result = await dialog.showOpenDialog(options);
    console.log('📤 IPC Response: dialog:open-file', {
      canceled: result.canceled,
      fileCount: result.filePaths?.length,
    });
    return result;
  });

  ipcMain.handle('dialog:save-file', async (_event, options: any) => {
    console.log('📞 IPC Call: dialog:save-file', options);
    const result = await dialog.showSaveDialog(options);
    console.log('📤 IPC Response: dialog:save-file', {
      canceled: result.canceled,
      filePath: result.filePath,
    });
    return result;
  });

  // Shell handlers
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    console.log('📞 IPC Call: shell:open-external', { url });
    try {
      await shell.openExternal(url);
      console.log('📤 IPC Response: shell:open-external - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ shell:open-external error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('shell:open-path', async (_event, path: string) => {
    console.log('📞 IPC Call: shell:open-path', { path });
    try {
      const result = await shell.openPath(path);
      console.log('📤 IPC Response: shell:open-path - success', { result });
      return successResponse({ error: result }); // openPath returns error string if failed, empty string if success
    } catch (error: any) {
      console.error('❌ shell:open-path error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Filesystem handlers registered');
}
