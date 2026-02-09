import { useEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { MainLayout } from './components/Layout/MainLayout';
import { EditorPanel } from './components/Editor/EditorPanel';
import { RebuildProgressModal } from './components/Project/RebuildProgressModal';
import { ErrorFallback } from './components/ErrorFallback';
import { useMenuShortcuts } from './hooks/useMenuShortcuts';
import { useLanguageStore } from './stores/languageStore';
import { useProjectStore } from './stores/projectStore';
import { useEditorStore } from './stores/editorStore';
import { useTheme } from './hooks/useTheme';

function App() {
  // Setup menu shortcuts listeners
  useMenuShortcuts();

  // Initialize theme from localStorage at startup
  useTheme();

  // Initialiser la langue
  const initializeLanguage = useLanguageStore((state) => state.initializeLanguage);
  const loadProject = useProjectStore((state) => state.loadProject);
  const updateEditorSettings = useEditorStore((state) => state.updateSettings);
  const initializeEditorMode = useEditorStore((state) => state.initializeEditorMode);

  useEffect(() => {
    initializeLanguage();

    // Issue #12: Charger les settings éditeur et initialiser le mode par défaut
    const initEditorSettings = async () => {
      try {
        const editorConfig = await window.electron.config.get('editor');
        if (editorConfig) {
          updateEditorSettings({
            fontSize: editorConfig.fontSize,
            wordWrap: editorConfig.wordWrap,
            showMinimap: editorConfig.showMinimap,
            fontFamily: editorConfig.fontFamily,
            defaultEditorMode: editorConfig.defaultEditorMode || 'wysiwyg',
          });
          initializeEditorMode();
        }
      } catch (error) {
        console.error('Failed to load editor settings:', error);
      }
    };
    initEditorSettings();

    // Note: Chargement automatique désactivé car peut causer des erreurs au démarrage
    // L'utilisateur doit ouvrir manuellement le projet via File > Open Project
    // ou cliquer sur un projet récent dans le panneau projet

    // Si vous voulez réactiver le chargement automatique, décommentez ci-dessous:
    /*
    const loadLastProject = async () => {
      try {
        const recentProjects = await window.electron.project.getRecent();
        if (recentProjects && recentProjects.length > 0) {
          console.log('🔄 Auto-loading last project:', recentProjects[0]);
          await loadProject(recentProjects[0]);
        }
      } catch (error) {
        console.error('Failed to auto-load last project:', error);
      }
    };

    loadLastProject();
    */
  }, [initializeLanguage, loadProject, updateEditorSettings, initializeEditorMode]);

  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onReset={() => {
        // Reset app state if needed
        window.location.reload();
      }}
      onError={(error, errorInfo) => {
        // Log error to console
        console.error('Error caught by boundary:', error, errorInfo);
        // TODO: Send to error tracking service (Sentry, etc.)
      }}
    >
      <MainLayout centerPanel={<EditorPanel />} />
      <RebuildProgressModal />
    </ErrorBoundary>
  );
}

export default App;
