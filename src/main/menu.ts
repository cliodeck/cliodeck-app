import { Menu, MenuItemConstructorOptions, app, ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron';
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
 * Ce que le menu demande à l'app, au moment du clic. Ses clics se fermaient sur la fenêtre du
 * lancement : sous macOS, l'app survit à la fermeture de sa fenêtre, la barre de menus reste, et
 * chaque commande levait « Object has been destroyed » sans rien faire (S11-1-16).
 */
export interface MenuDeps {
  /** La fenêtre principale, ou `null` après son `closed`. */
  currentWindow(): BrowserWindow | null;
  /** Recrée la fenêtre principale. */
  createWindow(): BrowserWindow;
  /**
   * La sortie est engagée (`QuitHandler.isLeaving`) : la fenêtre est masquée jusqu'à `app.exit`, et
   * plus personne n'écrirait ce qu'une commande déclencherait. Rien ne se recrée, ne s'affiche, ne
   * s'envoie.
   */
  isLeaving(): boolean;
}

interface MenuCommand {
  channel: string;
  args: unknown[];
  isLeaving: () => boolean;
}

/**
 * Les commandes dont le renderer a posé l'écouteur, par `WebContents` : le preload le dit
 * (`menu:listening`). Une fenêtre recréée n'écoute pas tout de suite : sa première page est le
 * document vide (CLAUDE.md §6), et React pose ses écouteurs après `did-finish-load` (26 ms plus
 * tard, mesuré sur l'app). Une commande envoyée avant se perdait ; elle attend dans `waiting`.
 */
const listening = new WeakMap<WebContents, Set<string>>();
const waiting = new WeakMap<WebContents, MenuCommand[]>();

/**
 * Les commandes en attente partent dans l'ordre des clics : la file s'arrête à la première dont le
 * canal n'est pas encore écouté, et celles qui la suivent l'attendent. Livrer canal par canal les
 * aurait fait partir dans l'ordre où `useMenuShortcuts` pose ses écouteurs. Le hook pose tous les
 * siens dans le même effet, et chaque canal que le menu envoie y est écouté (`menu-window.test.ts`) :
 * la file se vide à la dernière annonce, et aucune commande ne la retient pour toujours.
 */
function flush(contents: WebContents): void {
  const queue = waiting.get(contents);
  if (!queue) return;
  const channels = listening.get(contents);
  for (let head = queue[0]; head && channels?.has(head.channel); head = queue[0]) {
    queue.shift();
    if (head.isLeaving() || contents.isDestroyed()) continue;
    contents.send(head.channel, ...head.args);
  }
  if (queue.length === 0) waiting.delete(contents);
}

function onRendererListening(event: IpcMainEvent, channel: unknown): void {
  if (typeof channel !== 'string') return;
  const contents = event.sender;
  const channels = listening.get(contents) ?? new Set<string>();
  channels.add(channel);
  listening.set(contents, channels);
  flush(contents);
}

/** Une commande prend son tour : tout de suite si rien n'attend et que son canal est écouté. */
function deliver(win: BrowserWindow, command: MenuCommand): void {
  const contents = win.webContents;
  const queue = waiting.get(contents) ?? [];
  queue.push(command);
  waiting.set(contents, queue);
  flush(contents);
}

/**
 * Creates and returns the application menu with keyboard shortcuts
 */
export function createApplicationMenu(deps: MenuDeps): Menu {
  const isMac = process.platform === 'darwin';

  // Un seul écouteur, quel que soit le nombre de menus construits (un par changement de langue).
  ipcMain.removeListener('menu:listening', onRendererListening);
  ipcMain.on('menu:listening', onRendererListening);

  /** La fenêtre du moment du clic, jamais une fenêtre détruite. */
  const liveWindow = (): BrowserWindow | null => {
    const win = deps.currentWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  /** Une commande qui ouvre quelque chose : sans fenêtre, elle la recrée, et attend son renderer. */
  const send = (channel: string, ...args: unknown[]): void => {
    if (deps.isLeaving()) return;
    deliver(liveWindow() ?? deps.createWindow(), { channel, args, isLeaving: deps.isLeaving });
  };

  /** Une commande sur le document ouvert : sans fenêtre, elle n'a rien à viser. */
  const sendToDocument = (channel: string, ...args: unknown[]): void => {
    const win = deps.isLeaving() ? null : liveWindow();
    if (win) deliver(win, { channel, args, isLeaving: deps.isLeaving });
  };

  const reload = (ignoreCache: boolean): void => {
    const win = deps.isLeaving() ? null : liveWindow();
    if (win) void reloadAfterFlush(win, ignoreCache);
  };

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
                  send('menu:open-settings');
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
            send('menu:new-file');
          },
        },
        {
          label: t('openFile'),
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            send('menu:open-file');
          },
        },
        {
          label: t('save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            sendToDocument('menu:save-file');
          },
        },
        { type: 'separator' as const },
        {
          label: t('newProject'),
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            send('menu:new-project');
          },
        },
        {
          label: t('openProject'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            send('menu:open-project');
          },
        },
        { type: 'separator' as const },
        {
          label: t('exportPDF'),
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            sendToDocument('menu:export-pdf');
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
                  send('menu:open-settings');
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
            sendToDocument('menu:format-bold');
          },
        },
        {
          label: t('italic'),
          accelerator: 'CmdOrCtrl+I',
          click: () => {
            sendToDocument('menu:format-italic');
          },
        },
        {
          label: t('insertLink'),
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            sendToDocument('menu:insert-link');
          },
        },
        {
          label: t('insertCitation'),
          accelerator: 'CmdOrCtrl+\'',
          click: () => {
            sendToDocument('menu:insert-citation');
          },
        },
        {
          label: t('insertTable'),
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            sendToDocument('menu:insert-table');
          },
        },
        { type: 'separator' as const },
        {
          label: t('insertFootnote'),
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            sendToDocument('menu:insert-footnote');
          },
        },
        {
          label: t('insertBlockquote'),
          // Sous macOS, Cmd+Maj+Q est « Fermer la session » : le système le prend avant l'app. Sous
          // Windows, AltGr arrive comme Ctrl+Alt, et AltGr+Q tape `@` sur un clavier allemand : Ctrl+Alt+Q
          // prendrait celui des clés de citation. Chaque système garde donc un geste qui n'y fait rien d'autre.
          accelerator: isMac ? 'CmdOrCtrl+Alt+Q' : 'CmdOrCtrl+Shift+Q',
          click: () => {
            sendToDocument('menu:insert-blockquote');
          },
        },
        { type: 'separator' as const },
        {
          label: t('checkCitations'),
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            sendToDocument('menu:check-citations');
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
        //     sendToDocument('menu:toggle-preview');
        //   },
        // },
        // { type: 'separator' as const },
        {
          label: t('panelProjects'),
          accelerator: 'Alt+1',
          click: () => {
            send('menu:switch-panel', 'projects');
          },
        },
        {
          label: t('panelBibliography'),
          accelerator: 'Alt+2',
          click: () => {
            send('menu:switch-panel', 'bibliography');
          },
        },
        {
          label: t('panelChat'),
          accelerator: 'Alt+3',
          click: () => {
            send('menu:switch-panel', 'chat');
          },
        },
        { type: 'separator' as const },
        {
          label: t('usageJournal'),
          accelerator: 'CmdOrCtrl+J',
          click: () => {
            send('menu:open-usage-journal');
          },
        },
        { type: 'separator' as const },
        {
          id: 'view-reload',
          label: t('reload'),
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            reload(false);
          },
        },
        {
          id: 'view-force-reload',
          label: t('forceReload'),
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => {
            reload(true);
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
            send('menu:import-bibtex');
          },
        },
        {
          label: t('connectZotero'),
          click: () => {
            send('menu:connect-zotero');
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
            send('menu:about');
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
export function setupApplicationMenu(deps: MenuDeps): void {
  const menu = createApplicationMenu(deps);
  Menu.setApplicationMenu(menu);
}
