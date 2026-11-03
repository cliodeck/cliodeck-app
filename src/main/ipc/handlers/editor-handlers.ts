/**
 * Editor IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import {
  atomicWriteFile,
  readUserFile,
  withFileLock,
  type UserFileRead,
} from '../../../../backend/core/fs/user-files.js';
import { authorizeDocumentPath } from '../utils/document-path-authorization.js';
import { projectManager } from '../../services/project-manager.js';
import { manuscriptIndexService } from '../../services/manuscript-index-service.js';
import { retrievalService } from '../../services/retrieval-service.js';
import { readingNotesIndexService } from '../../services/reading-notes-index-service.js';
import { indexReadingNotesInBackground } from '../../services/reading-notes-indexing.js';
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
 * Le BOM n'est pas du texte. Laissé dans l'éditeur, il s'y affiche comme un caractère de
 * contrôle, et le `#` d'un titre en première ligne cesse d'être un titre (mesuré). L'éditeur
 * ne le voit donc pas, et il revient à l'écriture, tel que le fichier le portait.
 */
const BOM = '\uFEFF';

async function withOriginalBom(filePath: string, content: string): Promise<string> {
  if (content.startsWith(BOM)) return content;
  const current = await readUserFile(filePath);
  return current.kind === 'ok' && current.content.startsWith(BOM) ? BOM + content : content;
}

export function setupEditorHandlers() {
  ipcMain.handle('editor:load-file', async (_event, rawFilePath: unknown) => {
    const rawPath = validate(StringPathSchema, rawFilePath);
    console.log('📞 IPC Call: editor:load-file', { filePath: rawPath });
    try {
      // Le verrou avant la validation : une lecture demandée après une sauvegarde lit ce
      // que celle-ci a écrit. La lecture est stricte : un fichier qui n'est pas en UTF-8
      // est refusé, intact, plutôt qu'ouvert avec ses accents changés en U+FFFD, que
      // l'autosave rendrait définitifs.
      const read = await withFileLock(rawPath, async (): Promise<UserFileRead> => {
        let filePath: string;
        try {
          filePath = await authorizeDocumentPath(rawPath, 'read');
        } catch (error: unknown) {
          return { kind: 'unreadable', reason: 'refused', message: errorResponse(error).error };
        }
        return readUserFile(filePath);
      });
      if (read.kind === 'ok') {
        const content = read.content.startsWith(BOM) ? read.content.slice(BOM.length) : read.content;
        console.log('📤 IPC Response: editor:load-file', { contentLength: content.length });
        return successResponse({ content });
      }
      console.warn('⚠️ editor:load-file:', read);
      // `absent` est le seul cas où l'appelant peut créer le fichier : un chemin refusé
      // n'est jamais « absent », qu'il existe ou non.
      return read.kind === 'absent'
        ? { success: false, code: 'absent', error: `${rawPath} n'existe pas` }
        : { success: false, code: 'unreadable', reason: read.reason, error: read.message };
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
        // Le verrou avant la validation : ses `await` ne doivent pas pouvoir inverser
        // deux sauvegardes et laisser la plus ancienne sur le disque.
        const filePath = await withFileLock(rawPath, async () => {
          const authorized = await authorizeDocumentPath(rawPath, 'write');
          await atomicWriteFile(authorized, await withOriginalBom(authorized, content));
          return authorized;
        });

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

        // Une note de lecture sauvegardée rejoint son corpus de la même façon.
        const projectRoot = projectManager.getCurrentProjectPath();
        if (projectRoot) {
          readingNotesIndexService.configure(projectRoot);
          if (readingNotesIndexService.isReadingNoteFile(filePath)) {
            indexReadingNotesInBackground('sauvegarde');
          }
        }

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
