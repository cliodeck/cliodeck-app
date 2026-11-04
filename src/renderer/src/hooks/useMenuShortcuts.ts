import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogStore } from '../stores/dialogStore';
import { openErrorKey, useEditorStore, watchSaveOvertaken } from '../stores/editorStore';
import { useProjectStore } from '../stores/projectStore';
import { runCitationCheck } from '../services/check-citations';
import { newDocument } from '../services/new-document';
import i18n from '../i18n';

/**
 * Hook that listens to menu shortcuts and triggers appropriate actions
 * This should be called once at the app root level
 */
export function useMenuShortcuts() {
  const { t } = useTranslation('common');
  const { saveCurrentFile, loadFile, insertFormatting, togglePreview } = useEditorStore();
  const { createProject, loadProject } = useProjectStore();

  useEffect(() => {
    // Vérifier que l'API Electron est disponible
    if (!window.electron || !window.electron.ipcRenderer) {
      console.warn('Electron API not available, skipping menu shortcuts setup');
      return;
    }

    // Les messages d'Ouvrir et d'Enregistrer passent par `i18n.t`, pas par `t` : un écouteur
    // de menu qui n'a pas été retiré garde le `t` du premier rendu, en français, et c'est lui
    // qui répond le premier. Nouveau fichier et Vérifier les citations reçoivent encore ce `t` :
    // ils attendent la correction des écouteurs, qui rendra `t` à jour partout.

    // File operations
    const handleNewFile = () => {
      void newDocument(t);
    };

    const handleOpenFile = async () => {
      try {
        const result = await window.electron.dialog.openFile({
          filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        });

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          const outcome = await loadFile(result.filePaths[0]);
          if (outcome.status === 'locked') {
            await useDialogStore.getState().showAlert(i18n.t(outcome.lock));
          }
        }
      } catch (error) {
        console.error('Failed to open file:', error);
        await useDialogStore.getState().showAlert(i18n.t(openErrorKey(error, 'toolbar.openError')));
      }
    };

    const handleSaveFile = async () => {
      const { filePath, bufferDetached } = useEditorStore.getState();

      // Hors de tout document, le temps d'un changement de projet : rien à enregistrer.
      if (bufferDetached) return;

      const overtaken = watchSaveOvertaken();
      try {
        // If no file path exists, open "Save As" dialog
        if (!filePath) {
          // Aucun nom proposé : le main place le dialogue dans le dernier dossier, souvent
          // celui du projet, et « document.md » y désignerait le manuscrit à remplacer.
          // L'option d'invite de remplacement n'a d'effet documenté que sous Linux.
          const result = await window.electron.dialog.saveFile({
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
            properties: ['showOverwriteConfirmation'],
          });

          if (!result.canceled && result.filePath) {
            const outcome = await useEditorStore.getState().saveFileAs(result.filePath);
            if (outcome.status === 'locked') {
              await useDialogStore.getState().showAlert(i18n.t(outcome.lock));
            }
          }
        } else {
          // File path exists, save directly
          await saveCurrentFile();
        }
      } catch (error) {
        console.error('Failed to save file:', error);
        if (!overtaken()) await useDialogStore.getState().showAlert(i18n.t('toolbar.saveError'));
      }
    };

    // Project operations
    const handleNewProject = () => {
      // Trigger project creation UI
      window.dispatchEvent(new CustomEvent('show-create-project-dialog'));
    };

    const handleOpenProject = () => {
      // Trigger project open UI
      window.dispatchEvent(new CustomEvent('show-open-project-dialog'));
    };

    // Export operations
    const handleExportPDF = () => {
      // Trigger PDF export modal
      window.dispatchEvent(new CustomEvent('show-pdf-export-dialog'));
    };

    // Formatting operations. Ces accélérateurs valent pour toute la fenêtre : la touche que la saisie
    // du chat ne traite pas revient ici, comme le clic dans le menu. Dans l'éditeur, le keymap la
    // prend avant le menu, et les boutons de la barre d'outils n'y passent pas.
    const formatIfEditorFocused = (type: Parameters<typeof insertFormatting>[0]) => {
      if (useEditorStore.getState().editorFacade?.hasFocus()) insertFormatting(type);
    };

    const handleFormatBold = () => {
      formatIfEditorFocused('bold');
    };

    const handleFormatItalic = () => {
      formatIfEditorFocused('italic');
    };

    const handleInsertLink = () => {
      formatIfEditorFocused('link');
    };

    const handleInsertCitation = () => {
      formatIfEditorFocused('citation');
    };

    const handleInsertTable = () => {
      formatIfEditorFocused('table');
    };

    const handleInsertFootnote = () => {
      formatIfEditorFocused('footnote');
    };

    const handleInsertBlockQuote = () => {
      formatIfEditorFocused('blockquote');
    };

    // Une seule implémentation, partagée avec le bouton de la barre
    // d'outils (services/check-citations.ts) : le menu donnait auparavant un
    // résultat différent, calculé en regex sur le seul chapitre ouvert.
    const handleCheckCitations = async () => {
      await runCitationCheck(t);
    };

    // View operations
    const handleTogglePreview = () => {
      togglePreview();
    };

    const handleSwitchPanel = (_event: Electron.IpcRendererEvent, panel: string) => {
      // Trigger panel switch
      window.dispatchEvent(new CustomEvent('switch-panel', { detail: panel }));
    };

    // Bibliography operations
    const handleImportBibTeX = () => {
      window.dispatchEvent(new CustomEvent('show-bibtex-import-dialog'));
    };

    const handleConnectZotero = () => {
      window.dispatchEvent(new CustomEvent('show-zotero-connect-dialog'));
    };

    // Settings
    const handleOpenSettings = () => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
    };

    // Usage journal (journal d'usage IA)
    const handleOpenUsageJournal = () => {
      window.dispatchEvent(new CustomEvent('show-usage-journal'));
    };

    // About
    const handleAbout = () => {
      window.dispatchEvent(new CustomEvent('show-about-dialog'));
    };

    // Register all listeners
    window.electron.ipcRenderer.on('menu:new-file', handleNewFile);
    window.electron.ipcRenderer.on('menu:open-file', handleOpenFile);
    window.electron.ipcRenderer.on('menu:save-file', handleSaveFile);
    window.electron.ipcRenderer.on('menu:new-project', handleNewProject);
    window.electron.ipcRenderer.on('menu:open-project', handleOpenProject);
    window.electron.ipcRenderer.on('menu:export-pdf', handleExportPDF);
    window.electron.ipcRenderer.on('menu:format-bold', handleFormatBold);
    window.electron.ipcRenderer.on('menu:format-italic', handleFormatItalic);
    window.electron.ipcRenderer.on('menu:insert-link', handleInsertLink);
    window.electron.ipcRenderer.on('menu:insert-citation', handleInsertCitation);
    window.electron.ipcRenderer.on('menu:insert-table', handleInsertTable);
    window.electron.ipcRenderer.on('menu:insert-footnote', handleInsertFootnote);
    window.electron.ipcRenderer.on('menu:insert-blockquote', handleInsertBlockQuote);
    window.electron.ipcRenderer.on('menu:check-citations', handleCheckCitations);
    window.electron.ipcRenderer.on('menu:toggle-preview', handleTogglePreview);
    window.electron.ipcRenderer.on('menu:switch-panel', handleSwitchPanel);
    window.electron.ipcRenderer.on('menu:import-bibtex', handleImportBibTeX);
    window.electron.ipcRenderer.on('menu:connect-zotero', handleConnectZotero);
    window.electron.ipcRenderer.on('menu:open-settings', handleOpenSettings);
    window.electron.ipcRenderer.on('menu:open-usage-journal', handleOpenUsageJournal);
    window.electron.ipcRenderer.on('menu:about', handleAbout);

    // Cleanup listeners on unmount
    return () => {
      window.electron.ipcRenderer.removeListener('menu:new-file', handleNewFile);
      window.electron.ipcRenderer.removeListener('menu:open-file', handleOpenFile);
      window.electron.ipcRenderer.removeListener('menu:save-file', handleSaveFile);
      window.electron.ipcRenderer.removeListener('menu:new-project', handleNewProject);
      window.electron.ipcRenderer.removeListener('menu:open-project', handleOpenProject);
      window.electron.ipcRenderer.removeListener('menu:export-pdf', handleExportPDF);
      window.electron.ipcRenderer.removeListener('menu:format-bold', handleFormatBold);
      window.electron.ipcRenderer.removeListener('menu:format-italic', handleFormatItalic);
      window.electron.ipcRenderer.removeListener('menu:insert-link', handleInsertLink);
      window.electron.ipcRenderer.removeListener('menu:insert-citation', handleInsertCitation);
      window.electron.ipcRenderer.removeListener('menu:insert-table', handleInsertTable);
      window.electron.ipcRenderer.removeListener('menu:insert-footnote', handleInsertFootnote);
      window.electron.ipcRenderer.removeListener('menu:insert-blockquote', handleInsertBlockQuote);
      window.electron.ipcRenderer.removeListener('menu:check-citations', handleCheckCitations);
      window.electron.ipcRenderer.removeListener('menu:toggle-preview', handleTogglePreview);
      window.electron.ipcRenderer.removeListener('menu:switch-panel', handleSwitchPanel);
      window.electron.ipcRenderer.removeListener('menu:import-bibtex', handleImportBibTeX);
      window.electron.ipcRenderer.removeListener('menu:connect-zotero', handleConnectZotero);
      window.electron.ipcRenderer.removeListener('menu:open-settings', handleOpenSettings);
      window.electron.ipcRenderer.removeListener('menu:open-usage-journal', handleOpenUsageJournal);
      window.electron.ipcRenderer.removeListener('menu:about', handleAbout);
    };
  }, [
    saveCurrentFile,
    loadFile,
    insertFormatting,
    togglePreview,
    createProject,
    loadProject,
    t,
  ]);
}
