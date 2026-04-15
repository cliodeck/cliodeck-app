// Console filter must be imported first to filter logs in production
import '../shared/console-filter.js';

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
