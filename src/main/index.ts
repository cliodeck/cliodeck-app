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

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { setupIPCHandlers } from './ipc/index.js';
import { configManager } from './services/config-manager.js';
import { pdfService } from './services/pdf-service.js';
import { setupApplicationMenu } from './menu.js';
import { loadMenuTranslations, setLanguage } from './i18n.js';

// Obtenir __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const preloadPath = path.join(__dirname, '../../preload/index.js');
  console.log('📂 __dirname:', __dirname);
  console.log('📂 Preload path:', preloadPath);
  console.log('📂 Preload exists:', existsSync(preloadPath));

  const iconPath = path.join(__dirname, '../../../build/icon.png');

  mainWindow = new BrowserWindow({
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

  // Deny all window.open / target=_blank attempts at the main-process level.
  // Links that should open externally must go through a dedicated IPC path.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // En dev : charger depuis Vite
  // En production : charger depuis dist
  const isDev = process.env.NODE_ENV === 'development';
  const debugEnabled = process.env.CLIODESK_DEBUG === '1' || process.env.DEBUG === '1';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    // DevTools only in production if CLIODESK_DEBUG=1 or DEBUG=1
    if (debugEnabled) {
      mainWindow.webContents.openDevTools();
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Setup application menu with keyboard shortcuts
  setupApplicationMenu(mainWindow);
}

app.whenReady().then(async () => {
  // Initialiser configManager (async pour electron-store ES module)
  console.log('🔧 Initializing configManager...');
  await configManager.init();
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

  // Charger les traductions des menus
  loadMenuTranslations();

  // Charger la langue depuis la configuration
  const savedLanguage = configManager.get('language');
  if (savedLanguage && ['fr', 'en', 'de'].includes(savedLanguage)) {
    setLanguage(savedLanguage);
  }

  // Écouter les changements de langue pour mettre à jour le menu
  ipcMain.on('language-changed', (_event, language: 'fr' | 'en' | 'de') => {
    setLanguage(language);
    if (mainWindow) {
      setupApplicationMenu(mainWindow);
    }
  });

  // Note: pdfService is now project-scoped and initialized on-demand
  // via IPC handlers when a project is loaded (not at app startup)

  // Setup IPC handlers
  setupIPCHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Arrêter proprement le service Topic Modeling lors de la fermeture de l'app
app.on('before-quit', async (event) => {
  // Empêcher la fermeture immédiate pour permettre un arrêt propre
  event.preventDefault();

  try {
    // Importer et arrêter le service s'il est en cours d'exécution
    const { topicModelingService } = await import('./services/topic-modeling-service.js');
    const status = topicModelingService.getStatus();

    if (status.isRunning) {
      console.log('🛑 Stopping topic modeling service before quit...');
      await topicModelingService.stop();
      console.log('✅ Topic modeling service stopped');
    }
  } catch (error) {
    console.warn('⚠️ Could not stop topic modeling service:', error);
  }

  // Continuer la fermeture
  app.exit();
});
