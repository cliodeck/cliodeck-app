/**
 * Le VRAI main derrière `window.electron`, sur un vrai dossier : les handlers
 * `fusion:hints:*`, `editor:*` et `fs:*` tels quels, et les vrais octets du disque. Seuls
 * sont simulés le projet courant du main et les services sans rapport que ces handlers tirent
 * avec eux. Un faux disque cacherait ce qui se joue ici : la forme exacte de ce qui a été lu,
 * le BOM, les fins de ligne, la casse d'un chemin.
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: null as string | null,
}));

/** Le projet courant du main : changer `projectPath`, c'est ce qu'un changement de projet y fait. */
export const main = h;

vi.mock('electron', () => {
  const win = { webContents: { send: () => undefined }, isDestroyed: () => false };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: {},
    shell: {},
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nonexistent-app-path' },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});
vi.mock('../../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../../../main/services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined, getLLMConfig: () => ({}) },
}));
vi.mock('../../../../../main/services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../../../main/services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../../../main/services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../../../main/services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../../../main/services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined },
}));
vi.mock('../../../../../main/services/manuscript-index-service.js', () => ({
  manuscriptIndexService: { isEnabled: () => false },
}));
vi.mock('../../../../../main/services/reading-notes-index-service.js', () => ({
  readingNotesIndexService: { configure: () => undefined, isReadingNoteFile: () => false },
}));
vi.mock('../../../../../main/services/reading-notes-indexing.js', () => ({
  indexReadingNotesInBackground: () => undefined,
}));
vi.mock('../../../../../main/services/history-service.js', () => ({
  historyService: { getHistoryManager: () => null },
}));

const { setupFusionHandlers } = await import('../../../../../main/ipc/handlers/fusion-handlers');
const { setupEditorHandlers } = await import('../../../../../main/ipc/handlers/editor-handlers');
const { setupFilesystemHandlers } = await import('../../../../../main/ipc/handlers/filesystem-handlers');
setupFusionHandlers();
setupEditorHandlers();
setupFilesystemHandlers();

export function ipc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, ...args) as Promise<T>;
}

export type EditorSave = (filePath: string, content: string) => Promise<unknown>;

/** Ce qu'un test veut observer sur le passage : il n'a qu'à remplacer ces fonctions. */
export const passage = {
  /** Les écritures de `fusion:hints:write`, avant et après le main. */
  beforeHintsWrite: async (): Promise<void> => undefined,
  afterHintsWrite: async (): Promise<void> => undefined,
  /** Une écriture de l'éditeur qui échoue, ou que le test retient. */
  editorSave: (filePath: string, content: string): Promise<unknown> =>
    ipc('editor:save-file', filePath, content),
  reset(): void {
    this.beforeHintsWrite = async () => undefined;
    this.afterHintsWrite = async () => undefined;
    this.editorSave = (filePath, content) => ipc('editor:save-file', filePath, content);
  },
};

/** Ce que le preload expose, pour ce que ces tests regardent. */
export function installMain(): void {
  (window as unknown as { electron: unknown }).electron = {
    fusion: {
      hints: {
        read: () => ipc('fusion:hints:read'),
        write: async (...args: unknown[]) => {
          await passage.beforeHintsWrite();
          const response = await ipc('fusion:hints:write', ...args);
          await passage.afterHintsWrite();
          return response;
        },
      },
    },
    fs: {
      sameFile: (a: string, b: string) => ipc('fs:same-file', a, b),
    },
    editor: {
      loadFile: (filePath: string) => ipc('editor:load-file', filePath),
      saveFile: (filePath: string, content: string) => passage.editorSave(filePath, content),
      onInsertText: () => () => undefined,
    },
    project: {
      getRecent: async () => [],
      getChapters: async () => ({ success: true, chapters: [], unattached: [] }),
      onRebuildProgress: () => () => undefined,
    },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => () => undefined },
  };
}
