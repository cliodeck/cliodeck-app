import { Menu, MenuItemConstructorOptions, BrowserWindow, app } from 'electron';
import { t } from './i18n.js';
import { mayLeaveRenderer } from './renderer-flush.js';

/**
 * Recharger détruit l'éditeur comme une fermeture : le document s'écrit d'abord. Le rôle
 * natif `reload` rechargeait sans rien demander à personne.
 */
async function reloadAfterFlush(win: BrowserWindow, ignoreCache: boolean): Promise<void> {
  if (win.isDestroyed() || !(await mayLeaveRenderer(win)) || win.isDestroyed()) return;
  if (ignoreCache) win.webContents.reloadIgnoringCache();
  else win.webContents.reload();
}

/**
 * Creates and returns the application menu with keyboard shortcuts
 */
export function createApplicationMenu(mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // App Menu (Mac only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: t('settings'),
                accelerator: 'Cmd+,',
                click: () => {
                  mainWindow.webContents.send('menu:open-settings');
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    // File Menu
    {
      label: t('file'),
      submenu: [
        {
          label: t('newFile'),
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.send('menu:new-file');
          },
        },
        {
          label: t('openFile'),
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu:open-file');
          },
        },
        {
          label: t('save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow.webContents.send('menu:save-file');
          },
        },
        { type: 'separator' as const },
        {
          label: t('newProject'),
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            mainWindow.webContents.send('menu:new-project');
          },
        },
        {
          label: t('openProject'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            mainWindow.webContents.send('menu:open-project');
          },
        },
        { type: 'separator' as const },
        {
          label: t('exportPDF'),
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            mainWindow.webContents.send('menu:export-pdf');
          },
        },
        { type: 'separator' as const },
        ...(isMac
          ? []
          : [
              {
                label: t('settings'),
                accelerator: 'Ctrl+,',
                click: () => {
                  mainWindow.webContents.send('menu:open-settings');
                },
              },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ]),
      ],
    },

    // Edit Menu
    {
      label: t('edit'),
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'delete' as const },
        { role: 'selectAll' as const },
        { type: 'separator' as const },
        {
          label: t('bold'),
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            mainWindow.webContents.send('menu:format-bold');
          },
        },
        {
          label: t('italic'),
          accelerator: 'CmdOrCtrl+I',
          click: () => {
            mainWindow.webContents.send('menu:format-italic');
          },
        },
        {
          label: t('insertLink'),
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            mainWindow.webContents.send('menu:insert-link');
          },
        },
        {
          label: t('insertCitation'),
          accelerator: 'CmdOrCtrl+\'',
          click: () => {
            mainWindow.webContents.send('menu:insert-citation');
          },
        },
        {
          label: t('insertTable'),
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            mainWindow.webContents.send('menu:insert-table');
          },
        },
        { type: 'separator' as const },
        {
          label: t('insertFootnote'),
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            mainWindow.webContents.send('menu:insert-footnote');
          },
        },
        {
          label: t('insertBlockquote'),
          // Sous macOS, Cmd+Maj+Q est « Fermer la session » : le système le prend avant l'app. Sous
          // Windows, AltGr arrive comme Ctrl+Alt, et AltGr+Q tape `@` sur un clavier allemand : Ctrl+Alt+Q
          // prendrait celui des clés de citation. Chaque système garde donc un geste qui n'y fait rien d'autre.
          accelerator: isMac ? 'CmdOrCtrl+Alt+Q' : 'CmdOrCtrl+Shift+Q',
          click: () => {
            mainWindow.webContents.send('menu:insert-blockquote');
          },
        },
        { type: 'separator' as const },
        {
          label: t('checkCitations'),
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            mainWindow.webContents.send('menu:check-citations');
          },
        },
      ],
    },

    // View Menu
    {
      label: t('view'),
      submenu: [
        // Preview disabled
        // {
        //   label: 'Basculer aperçu',
        //   accelerator: 'CmdOrCtrl+K',
        //   click: () => {
        //     mainWindow.webContents.send('menu:toggle-preview');
        //   },
        // },
        // { type: 'separator' as const },
        {
          label: t('panelProjects'),
          accelerator: 'Alt+1',
          click: () => {
            mainWindow.webContents.send('menu:switch-panel', 'projects');
          },
        },
        {
          label: t('panelBibliography'),
          accelerator: 'Alt+2',
          click: () => {
            mainWindow.webContents.send('menu:switch-panel', 'bibliography');
          },
        },
        {
          label: t('panelChat'),
          accelerator: 'Alt+3',
          click: () => {
            mainWindow.webContents.send('menu:switch-panel', 'chat');
          },
        },
        { type: 'separator' as const },
        {
          label: t('usageJournal'),
          accelerator: 'CmdOrCtrl+J',
          click: () => {
            mainWindow.webContents.send('menu:open-usage-journal');
          },
        },
        { type: 'separator' as const },
        {
          id: 'view-reload',
          label: t('reload'),
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            void reloadAfterFlush(mainWindow, false);
          },
        },
        {
          id: 'view-force-reload',
          label: t('forceReload'),
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => {
            void reloadAfterFlush(mainWindow, true);
          },
        },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },

    // Bibliography Menu
    {
      label: t('bibliography'),
      submenu: [
        {
          label: t('importBibTeX'),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => {
            mainWindow.webContents.send('menu:import-bibtex');
          },
        },
        {
          label: t('connectZotero'),
          click: () => {
            mainWindow.webContents.send('menu:connect-zotero');
          },
        },
      ],
    },

    // Window Menu
    {
      label: t('window'),
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [
              // `close` fournit l'accélérateur natif Cmd+W ; le menu étant
              // entièrement custom, sans lui le raccourci n'existe pas (#26).
              { role: 'close' as const },
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },

    // Help Menu
    {
      label: t('help'),
      submenu: [
        {
          label: t('documentation'),
          click: async () => {
            const { shell } = await import('electron');
            await shell.openExternal('https://github.com/cliodeck/cliodeck-app');
          },
        },
        {
          label: t('reportIssue'),
          click: async () => {
            const { shell } = await import('electron');
            await shell.openExternal('https://github.com/cliodeck/cliodeck-app/issues');
          },
        },
        { type: 'separator' as const },
        {
          label: t('about'),
          click: () => {
            mainWindow.webContents.send('menu:about');
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * Sets up the application menu
 */
export function setupApplicationMenu(mainWindow: BrowserWindow): void {
  const menu = createApplicationMenu(mainWindow);
  Menu.setApplicationMenu(menu);
}
