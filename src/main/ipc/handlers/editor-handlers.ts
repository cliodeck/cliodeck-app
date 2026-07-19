/**
 * Editor IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import { projectManager } from '../../services/project-manager.js';
import { manuscriptIndexService } from '../../services/manuscript-index-service.js';
import { retrievalService } from '../../services/retrieval-service.js';
import { historyService } from '../../services/history-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validateReadPath, validateWritePath } from '../utils/path-validator.js';
import { isConsentedPath } from '../utils/user-consented-paths.js';
import {
  validate,
  StringPathSchema,
  EditorSaveFileSchema,
  EditorInsertTextSchema,
} from '../utils/validation.js';

/**
 * Autorise un chemin de document : à l'intérieur du projet courant, ou
 * explicitement désigné par l'utilisateur dans un dialogue natif.
 *
 * Sans cette garde, `editor:load-file` / `editor:save-file` lisaient et
 * écrivaient n'importe quel chemin absolu — de quoi laisser un renderer
 * compromis siphonner `~/.ssh/id_rsa` puis l'exfiltrer via le chat
 * (ADR 0005). Le registre de consentement préserve les usages légitimes
 * hors projet : ouvrir un document rangé ailleurs, « Enregistrer sous ».
 */
async function authorizeDocumentPath(
  filePath: string,
  intent: 'read' | 'write'
): Promise<string> {
  try {
    return intent === 'read'
      ? await validateReadPath(filePath)
      : await validateWritePath(filePath);
  } catch (error) {
    if (await isConsentedPath(filePath)) return path.resolve(filePath);
    throw error;
  }
}

export function setupEditorHandlers() {
  ipcMain.handle('editor:load-file', async (_event, rawFilePath: unknown) => {
    const rawPath = validate(StringPathSchema, rawFilePath);
    console.log('📞 IPC Call: editor:load-file', { filePath: rawPath });
    try {
      const filePath = await authorizeDocumentPath(rawPath, 'read');
      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf-8');
      console.log('📤 IPC Response: editor:load-file', { contentLength: content.length });
      return successResponse({ content });
    } catch (error: unknown) {
      console.error('❌ editor:load-file error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle(
    'editor:save-file',
    async (_event, rawFilePath: unknown, rawContent: unknown, rawPreviousContent?: unknown) => {
      const { filePath: rawPath, content, previousContent } = validate(EditorSaveFileSchema, { filePath: rawFilePath, content: rawContent, previousContent: rawPreviousContent });
      console.log('📞 IPC Call: editor:save-file', { filePath: rawPath, contentLength: content.length });
      try {
        const filePath = await authorizeDocumentPath(rawPath, 'write');
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

        // Indexation du manuscrit : APRÈS écriture, donc le disque fait foi.
        // De fond et best-effort — pas de `await` : l'indexation ne doit
        // jamais retarder une sauvegarde, et son échec (Ollama éteint,
        // corpus désactivé) n'a aucune conséquence visible.
        void (async () => {
          try {
            if (!manuscriptIndexService.isEnabled()) return;
            const root = projectManager.getCurrentProjectPath();
            if (!root) return;
            const embedder = retrievalService.getEmbeddingProvider();
            if (!embedder) return;
            manuscriptIndexService.configure(root);
            await manuscriptIndexService.index(embedder);
          } catch (error: unknown) {
            console.warn('⚠️ Indexation du manuscrit ignorée:', error);
          }
        })();

        console.log('📤 IPC Response: editor:save-file - success');
        return successResponse();
      } catch (error: unknown) {
        console.error('❌ editor:save-file error:', error);
        return errorResponse(error);
      }
    }
  );

  ipcMain.handle('editor:insert-text', async (event, rawText: unknown, rawMetadata?: unknown) => {
    const { text, metadata } = validate(EditorInsertTextSchema, { text: rawText, metadata: rawMetadata });
    console.log('📞 IPC Call: editor:insert-text', { textLength: text.length, metadata });
    // Phase 4 (plan CM6) : le main n'enveloppe plus le texte de marqueurs
    // <!-- cliodeck-gen --> — la provenance est portée par l'annotation
    // changeOrigin des transactions CM6. Le renderer reçoit { text, metadata }
    // et décide : proposition IA (CM6, si metadata.modeId), enveloppe héritée
    // insertion simple sinon.
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.webContents.send('editor:insert-text-command', { text, metadata });
      console.log('📤 IPC Response: editor:insert-text - command sent');
    }
    return successResponse();
  });

  console.log('✅ Editor handlers registered');
}
