/**
 * Editor IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import { projectManager } from '../../services/project-manager.js';
import { historyService } from '../../services/history-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupEditorHandlers() {
  ipcMain.handle('editor:load-file', async (_event, filePath: string) => {
    console.log('📞 IPC Call: editor:load-file', { filePath });
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf-8');
      console.log('📤 IPC Response: editor:load-file', { contentLength: content.length });
      return successResponse({ content });
    } catch (error: any) {
      console.error('❌ editor:load-file error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle(
    'editor:save-file',
    async (_event, filePath: string, content: string, previousContent?: string) => {
      console.log('📞 IPC Call: editor:save-file', { filePath, contentLength: content.length });
      try {
        const { writeFile } = await import('fs/promises');
        await writeFile(filePath, content, 'utf-8');

        // Log document operation to history
        const hm = historyService.getHistoryManager();
        if (hm) {
          const projectPath = projectManager.getCurrentProjectPath();
          const relativePath = projectPath ? path.relative(projectPath, filePath) : filePath;

          // Calculate diff
          const newWords = content.split(/\s+/).filter((w) => w.length > 0).length;
          const oldWords = previousContent
            ? previousContent.split(/\s+/).filter((w) => w.length > 0).length
            : 0;

          const wordsAdded = Math.max(0, newWords - oldWords);
          const wordsDeleted = Math.max(0, oldWords - newWords);
          const charactersAdded = Math.max(0, content.length - (previousContent?.length || 0));
          const charactersDeleted = Math.max(
            0,
            (previousContent?.length || 0) - content.length
          );

          hm.logDocumentOperation({
            operationType: 'save',
            filePath: relativePath,
            wordsAdded,
            wordsDeleted,
            charactersAdded,
            charactersDeleted,
          });

          console.log(
            `📝 Logged document save: ${relativePath} (+${wordsAdded}w, -${wordsDeleted}w)`
          );
        }

        console.log('📤 IPC Response: editor:save-file - success');
        return successResponse();
      } catch (error: any) {
        console.error('❌ editor:save-file error:', error);
        return errorResponse(error);
      }
    }
  );

  ipcMain.handle('editor:insert-text', async (event, text: string, metadata?: { modeId?: string; model?: string }) => {
    console.log('📞 IPC Call: editor:insert-text', { textLength: text.length, metadata });
    // Wrap text with cliodeck-gen provenance tags if mode metadata is provided
    let wrappedText = text;
    if (metadata?.modeId) {
      const date = new Date().toISOString();
      wrappedText = `<!-- cliodeck-gen mode="${metadata.modeId}" model="${metadata.model || 'unknown'}" date="${date}" -->\n${text}\n<!-- /cliodeck-gen -->`;
    }
    // Send to renderer for insertion into editor
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.webContents.send('editor:insert-text-command', wrappedText);
      console.log('📤 IPC Response: editor:insert-text - command sent');
    }
    return successResponse();
  });

  console.log('✅ Editor handlers registered');
}
