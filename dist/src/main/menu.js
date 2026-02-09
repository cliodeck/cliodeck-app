import { Menu, app } from 'electron';
import { t } from './i18n.js';
/**
 * Creates and returns the application menu with keyboard shortcuts
 */
export function createApplicationMenu(mainWindow) {
    const isMac = process.platform === 'darwin';
    const template = [
        // App Menu (Mac only)
        ...(isMac
            ? [
                {
                    label: app.name,
                    submenu: [
                        { role: 'about' },
                        { type: 'separator' },
                        {
                            label: t('settings'),
                            accelerator: 'Cmd+,',
                            click: () => {
                                mainWindow.webContents.send('menu:open-settings');
                            },
                        },
                        { type: 'separator' },
                        { role: 'services' },
                        { type: 'separator' },
                        { role: 'hide' },
                        { role: 'hideOthers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit' },
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
                { type: 'separator' },
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
                { type: 'separator' },
                {
                    label: t('exportPDF'),
                    accelerator: 'CmdOrCtrl+E',
                    click: () => {
                        mainWindow.webContents.send('menu:export-pdf');
                    },
                },
                { type: 'separator' },
                ...(isMac
                    ? []
                    : [
                        {
                            label: 'Paramètres',
                            accelerator: 'Ctrl+,',
                            click: () => {
                                mainWindow.webContents.send('menu:open-settings');
                            },
                        },
                        { type: 'separator' },
                        { role: 'quit' },
                    ]),
            ],
        },
        // Edit Menu
        {
            label: t('edit'),
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'delete' },
                { role: 'selectAll' },
                { type: 'separator' },
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
                { type: 'separator' },
                {
                    label: t('insertFootnote'),
                    accelerator: 'CmdOrCtrl+Shift+F',
                    click: () => {
                        mainWindow.webContents.send('menu:insert-footnote');
                    },
                },
                {
                    label: t('insertBlockquote'),
                    accelerator: 'CmdOrCtrl+Shift+Q',
                    click: () => {
                        mainWindow.webContents.send('menu:insert-blockquote');
                    },
                },
                { type: 'separator' },
                {
                    label: t('documentStats'),
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => {
                        mainWindow.webContents.send('menu:toggle-stats');
                    },
                },
                {
                    label: t('citationSuggestions'),
                    accelerator: 'CmdOrCtrl+Shift+L',
                    click: () => {
                        mainWindow.webContents.send('menu:toggle-suggestions');
                    },
                },
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
                {
                    label: t('panelCorpus'),
                    accelerator: 'Alt+4',
                    click: () => {
                        mainWindow.webContents.send('menu:switch-panel', 'corpus');
                    },
                },
                { type: 'separator' },
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
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
                    label: t('searchCitations'),
                    accelerator: 'CmdOrCtrl+F',
                    click: () => {
                        mainWindow.webContents.send('menu:search-citations');
                    },
                },
                { type: 'separator' },
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
                { role: 'minimize' },
                { role: 'zoom' },
                ...(isMac
                    ? [
                        { type: 'separator' },
                        { role: 'front' },
                        { type: 'separator' },
                        { role: 'window' },
                    ]
                    : [{ role: 'close' }]),
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
                        await shell.openExternal('https://github.com/inactinique/cliodeck');
                    },
                },
                {
                    label: t('reportIssue'),
                    click: async () => {
                        const { shell } = await import('electron');
                        await shell.openExternal('https://github.com/inactinique/cliodeck/issues');
                    },
                },
                { type: 'separator' },
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
export function setupApplicationMenu(mainWindow) {
    const menu = createApplicationMenu(mainWindow);
    Menu.setApplicationMenu(menu);
}
