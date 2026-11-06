import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogStore } from '../stores/dialogStore';
import { openErrorKey, useEditorStore, watchSaveOvertaken } from '../stores/editorStore';
import { useManuscriptStore } from '../stores/manuscriptStore';
import { useMenuIntentStore, type MenuIntent } from '../stores/menuIntentStore';
import { runCitationCheck } from '../services/check-citations';
import { newDocument } from '../services/new-document';
import { isModalOpen } from './useFocusTrap';

/**
 * Hook that listens to menu shortcuts and triggers appropriate actions
 * This should be called once at the app root level
 */
export function useMenuShortcuts() {
  const { t } = useTranslation('common');
  const { saveCurrentFile, loadFile, insertFormatting, togglePreview } = useEditorStore();
  // `t` change à chaque `languageChanged`, que i18next émet au lancement même pour la langue en
  // cours : dans les dépendances de l'effet, il relançait l'abonnement aux commandes. Lu au moment
  // de la commande, il est celui de la langue affichée.
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    // Vérifier que l'API Electron est disponible
    if (!window.electron || !window.electron.ipcRenderer) {
      console.warn('Electron API not available, skipping menu shortcuts setup');
      return;
    }

    // File operations
    const handleNewFile = () => {
      void newDocument(tRef.current);
    };

    const handleOpenFile = async () => {
      try {
        const result = await window.electron.dialog.openFile({
          filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        });

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          const outcome = await loadFile(result.filePaths[0]);
          if (outcome.status === 'locked') {
            await useDialogStore.getState().showAlert(tRef.current(outcome.lock));
          }
        }
      } catch (error) {
        console.error('Failed to open file:', error);
        await useDialogStore.getState().showAlert(tRef.current(openErrorKey(error, 'toolbar.openError')));
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
              await useDialogStore.getState().showAlert(tRef.current(outcome.lock));
            }
          }
        } else {
          // File path exists, save directly
          await saveCurrentFile();
        }
      } catch (error) {
        console.error('Failed to save file:', error);
        if (!overtaken()) await useDialogStore.getState().showAlert(tRef.current('toolbar.saveError'));
      }
    };

    // Nouveau projet, Ouvrir un projet, Importer BibTeX : le panneau de gauche les fait, comme ses
    // boutons, une fois monté. MainLayout ne change pas de panneau sous une modale ni pendant un
    // export : l'intention attendrait alors le prochain passage sur ce panneau, et la commande
    // agirait par surprise, bien plus tard. Rien n'est donc demandé dans ce cas.
    const openInLeftPanel = (panel: 'projects' | 'bibliography', intent: MenuIntent) => {
      if (useManuscriptStore.getState().exporting || isModalOpen()) return;
      useMenuIntentStore.getState().request(intent);
      window.dispatchEvent(new CustomEvent('switch-panel', { detail: panel }));
    };

    // Project operations
    const handleNewProject = () => {
      openInLeftPanel('projects', 'new-project');
    };

    const handleOpenProject = () => {
      openInLeftPanel('projects', 'open-project');
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
      await runCitationCheck(tRef.current);
    };

    // View operations
    const handleTogglePreview = () => {
      togglePreview();
    };

    const handleSwitchPanel = (panel: string) => {
      // Trigger panel switch
      window.dispatchEvent(new CustomEvent('switch-panel', { detail: panel }));
    };

    // Bibliography operations
    const handleImportBibTeX = () => {
      openInLeftPanel('bibliography', 'import-bibtex');
    };

    // Les Réglages, où vit la connexion à Zotero : la modale ne sait pas s'ouvrir sur une section.
    const handleConnectZotero = () => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
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

    // Chaque abonnement rend son désabonnement : à travers `contextBridge`, c'est la seule
    // façon de retirer un écouteur (voir le preload).
    const { on } = window.electron.ipcRenderer;
    const unsubscribers = [
      on('menu:new-file', handleNewFile),
      on('menu:open-file', handleOpenFile),
      on('menu:save-file', handleSaveFile),
      on('menu:new-project', handleNewProject),
      on('menu:open-project', handleOpenProject),
      on('menu:export-pdf', handleExportPDF),
      on('menu:format-bold', handleFormatBold),
      on('menu:format-italic', handleFormatItalic),
      on('menu:insert-link', handleInsertLink),
      on('menu:insert-citation', handleInsertCitation),
      on('menu:insert-table', handleInsertTable),
      on('menu:insert-footnote', handleInsertFootnote),
      on('menu:insert-blockquote', handleInsertBlockQuote),
      on('menu:check-citations', handleCheckCitations),
      on('menu:toggle-preview', handleTogglePreview),
      on('menu:switch-panel', handleSwitchPanel),
      on('menu:import-bibtex', handleImportBibTeX),
      on('menu:connect-zotero', handleConnectZotero),
      on('menu:open-settings', handleOpenSettings),
      on('menu:open-usage-journal', handleOpenUsageJournal),
      on('menu:about', handleAbout),
    ];

    // Cleanup listeners on unmount
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [saveCurrentFile, loadFile, insertFormatting, togglePreview]);
}
