// Console filter must be imported first to filter logs in production
import '../shared/console-filter.js';

// Capture otherwise-silent async errors. Electron exits without a trace
// when a promise is rejected unhandled or an uncaught exception escapes
// an event-loop callback — which is how indexing crashes have been
// disappearing. We record to stderr AND append to ~/.cliodeck-crash.log
// so the trace survives the terminal being closed.
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join as pathJoin } from 'path';

const CRASH_LOG = pathJoin(homedir(), '.cliodeck-crash.log');

function recordFatal(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const stamp = new Date().toISOString();
  const message =
    err instanceof Error ? err.stack || err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const line = `\n=== ${stamp} ${kind} ===\n${message}\n`;
  try { process.stderr.write(line); } catch { /* ignore */ }
  try { appendFileSync(CRASH_LOG, line); } catch { /* ignore */ }
}

process.on('uncaughtException', (err) => recordFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => recordFatal('unhandledRejection', reason));

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { attachNavigationGuard } from './navigation-guard.js';
import { setupIPCHandlers } from './ipc/index.js';
import { configManager } from './services/config-manager.js';
import { pdfService } from './services/pdf-service.js';
import { setupApplicationMenu, type MenuDeps } from './menu.js';
import { loadMenuTranslations, setLanguage, t } from './i18n.js';
import { recoveredSettingsDetail, settingsFailureMessage } from './settings-recovery.js';
import { guardWindowClose, mayLeaveRenderer } from './renderer-flush.js';
import { sandboxStatus } from './utils/sandbox-status.js';
import { createQuitHandler, QUIT_DEADLINE_MS, shutdownApp } from './services/app-shutdown.js';
import { disposeAllEmbeddedClients } from '../../backend/core/llm/embedded-engine-pool.js';

// Obtenir __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
/** La fermeture du projet ouvert, rendue par les handlers ; nulle avant `whenReady`, sans projet. */
let shutdownProject: ((budgetMs: number) => Promise<void>) | null = null;

/** URL servie par l'application — référence du garde de navigation. */
function resolveAppUrl(): string {
  return process.env.NODE_ENV === 'development'
    ? 'http://localhost:5173'
    : pathToFileURL(path.join(__dirname, '../../../dist/renderer/index.html')).href;
}

function createWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, '../../preload/index.js');
  console.log('📂 __dirname:', __dirname);
  console.log('📂 Preload path:', preloadPath);
  console.log('📂 Preload exists:', existsSync(preloadPath));

  const iconPath = path.join(__dirname, '../../../build/icon.png');

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = win;

  // Aucune nouvelle fenêtre (`window.open`, `target=_blank`) : le garde le refuse, sur tout WebContents.

  // En dev : charger depuis Vite
  // En production : charger depuis dist
  const isDev = process.env.NODE_ENV === 'development';
  const debugEnabled = process.env.CLIODESK_DEBUG === '1' || process.env.DEBUG === '1';

  const appUrl = resolveAppUrl();
  attachNavigationGuard(win.webContents, appUrl);

  if (isDev) {
    win.loadURL(appUrl);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    // DevTools only in production if CLIODESK_DEBUG=1 or DEBUG=1
    if (debugEnabled) {
      win.webContents.openDevTools();
    }
  }

  guardWindowClose(win);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

/**
 * Le menu vise la fenêtre du moment du clic, la recrée au besoin (macOS), et ne fait plus rien une
 * fois la sortie engagée. Posé une fois, avant la première fenêtre : il ne dépend d'aucune.
 */
const menuDeps: MenuDeps = {
  currentWindow: () => mainWindow,
  createWindow,
  isLeaving: () => onBeforeQuit.isLeaving(),
};

/**
 * Un fichier de réglages illisible a été mis de côté au démarrage (`openStoreResilient`) : l'auteur
 * l'apprend, avec le nom de la copie ; pour les clés d'API, qu'elles sont à ressaisir.
 */
function tellRecoveredSettings(win: BrowserWindow): void {
  const recovered = configManager.getRecoveredFiles();
  if (recovered.length === 0) return;
  const detail = recoveredSettingsDetail(recovered);
  dialog.showMessageBox(win, { type: 'warning', message: t('settingsRecoveredTitle'), detail }).catch((error: unknown) => {
    console.warn('[Config] message des réglages mis de côté non affiché :', error);
  });
}

// Filet global : tout WebContents créé plus tard (webview, aperçu) hérite
// du même garde, sans dépendre du souvenir de l'appeler.
app.on('web-contents-created', (_event, contents) => {
  attachNavigationGuard(contents, resolveAppUrl());
});

app.whenReady().then(async () => {
  // Les textes du main d'abord : la boîte d'erreur ci-dessous en a besoin, avant toute configuration.
  // Sans configuration lue, ils sont en français, la langue par défaut.
  loadMenuTranslations();

  // Initialiser configManager (async pour electron-store ES module)
  console.log('🔧 Initializing configManager...');
  try {
    await configManager.init();
  } catch (error) {
    // Un fichier qui ne se lit pas comme du JSON a déjà été mis de côté par `init`. Ce qui reste
    // (droits, disque) ne se répare pas d'ici. Sans ce `catch`, le rejet n'allait qu'au journal des
    // plantages, et l'app restait en vie sans fenêtre, l'icône du Dock inerte (S11-1-10). La boîte
    // nomme aussi une copie déjà faite : le lancement suivant ne la verrait plus.
    console.error('❌ configManager:', error);
    const { title, content } = settingsFailureMessage(error, configManager.getRecoveredFiles());
    dialog.showErrorBox(title, content);
    // Aucun projet n'est ouvert : sortir sans passer par `before-quit` ne perd rien.
    app.exit(1);
    return;
  }
  console.log('✅ configManager initialized');

  // Propagate connector secrets from secureStorage into process.env so
  // any MCP-server-as-tools subprocess we spawn inherits them. Third-party
  // MCP clients (Claude Desktop) don't share our env, so they still need
  // EUROPEANA_API_KEY explicitly in their own config — see archive-mcp-connectors.md.
  try {
    const { secureStorage } = await import('./services/secure-storage.js');
    const europeanaKey = secureStorage.getKey('mcp.europeana.apiKey');
    if (europeanaKey) {
      process.env.EUROPEANA_API_KEY = europeanaKey;
      console.log('🔑 [Secrets] EUROPEANA_API_KEY propagated to process.env');
    }
  } catch (e) {
    console.warn('[Secrets] Failed to propagate connector keys:', e);
  }

  // Le lanceur de l'AppImage coupe le bac à sable de lui-même quand le
  // système ne le permet pas (#151). Le renderer en avertit l'utilisateur ;
  // la trace, elle, doit figurer au journal d'un rapport de bogue.
  const sandbox = sandboxStatus({
    platform: process.platform,
    noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
    appImagePath: process.env.APPIMAGE,
  });
  if (sandbox.disabled) {
    console.warn(
      `⚠️ [Security] Bac à sable de Chromium désactivé (--no-sandbox)${sandbox.appImage ? ', lancement depuis une AppImage' : ''}.`
    );
  }

  // Charger la langue depuis la configuration
  const savedLanguage = configManager.get('language');
  if (savedLanguage && ['fr', 'en', 'de'].includes(savedLanguage)) {
    setLanguage(savedLanguage);
  }

  // Écouter les changements de langue pour mettre à jour le menu
  ipcMain.on('language-changed', (_event, language: 'fr' | 'en' | 'de') => {
    setLanguage(language);
    setupApplicationMenu(menuDeps);
  });

  // Note: pdfService is now project-scoped and initialized on-demand
  // via IPC handlers when a project is loaded (not at app startup)

  // Setup IPC handlers
  shutdownProject = setupIPCHandlers().shutdownProject;

  // Setup application menu with keyboard shortcuts
  setupApplicationMenu(menuDeps);

  tellRecoveredSettings(createWindow());

  app.on('activate', () => {
    // Pendant l'arrêt, un clic sur le Dock ne recrée rien : `app.exit` l'emporterait aussitôt.
    if (!onBeforeQuit.isLeaving() && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Quitter (L03-9) : le document d'abord ; puis les fenêtres retirées de l'écran ; puis, dans une
// échéance, le projet ouvert (ses journaux compris), le service des thèmes et les modèles embarqués ;
// puis `app.exit()`, quoi qu'il arrive.
// `app.exit()` ne ferme rien de lui-même : sans cet arrêt, la session du journal de recherche
// restait « Active » et le tampon du journal d'usage se perdait.
const onBeforeQuit = createQuitHandler({
  mayLeave: () => mayLeaveRenderer(mainWindow),
  // Masquées, pas détruites : le renderer peut encore finir une écriture jusqu'à `app.exit`.
  hideWindows: () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.hide();
    }
  },
  shutdown: () =>
    shutdownApp({
      deadlineMs: QUIT_DEADLINE_MS,
      stopTopicModeling: async () => {
        const { topicModelingService } = await import('./services/topic-modeling-service.js');
        await topicModelingService.stop();
      },
      closeProject: async (budgetMs) => {
        await shutdownProject?.(budgetMs);
      },
      releaseEmbeddedModels: () => disposeAllEmbeddedClients(),
    }),
  exit: () => app.exit(),
});
app.on('before-quit', onBeforeQuit);
