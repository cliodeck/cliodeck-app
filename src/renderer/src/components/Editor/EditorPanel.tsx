import React, { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText, FolderOpen, Save, CheckCircle, BookOpen, Superscript, Search,
  ListOrdered, Columns, Plus, MessageSquare, Eye, Sparkles, FileDown,
} from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { renumberFootnotes, renumberManuscript } from '@/editor/footnote-tools';
import { collectCitationKeys } from '@/editor/citation-tools';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { DocumentStats } from './DocumentStats';
import { SlideNavigator } from '../Slides/SlideNavigator';
import { SlidePreviewPanel } from '../Slides/SlidePreviewPanel';
import { SlideGenerationPanel } from '../Slides/SlideGenerationPanel';
import { ChapterNavigator } from '../Book/ChapterNavigator';

// SimilarityPanel self-hides via `isPanelOpen` — lazy-loading keeps its heavy
// dependency tree off the editor's initial chunk.
const SimilarityPanel = lazy(() =>
  import('../Similarity/SimilarityPanel').then((m) => ({ default: m.SimilarityPanel })),
);
// Modal d'export reveal/Beamer — projets presentation uniquement.
const PresentationExportModal = lazy(() =>
  import('../Export/PresentationExportModal').then((m) => ({ default: m.PresentationExportModal })),
);
import { useEditorStore } from '../../stores/editorStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useSimilarityStore } from '../../stores/similarityStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSlidesStore } from '../../stores/slidesStore';
import { useManuscriptStore, currentRelativePath } from '../../stores/manuscriptStore';
import { useAutoSave } from '../../hooks/useAutoSave';
import { logger } from '../../utils/logger';
import './EditorPanel.css';

export const EditorPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { loadFile, saveFile, setContent, insertFormatting } = useEditorStore();
  const { citations } = useBibliographyStore();
  const { openPanel: openSimilarityPanel, isPanelOpen: isSimilarityPanelOpen } = useSimilarityStore();

  // Chantier « même éditeur » : un projet presentation garde CE panneau —
  // la toolbar gagne une section slides et Navigator/Preview/Génération
  // s'ouvrent en tiroirs latéraux autour du même CodeMirrorEditor.
  const isPresentation = useProjectStore((s) => s.currentProject?.type === 'presentation');
  // Projet livre : le manuscrit est fait de N chapitres — le navigateur
  // ouvre l'atelier de la même façon que pour les présentations.
  const isBook = useProjectStore((s) => s.currentProject?.type === 'book');
  const addChapter = useProjectStore((s) => s.addChapter);
  const { isPanelOpen: isGenerationOpen, openPanel: openGeneration, isPreviewOpen, togglePreview } = useSlidesStore();
  const [showExportModal, setShowExportModal] = useState(false);

  // Enable auto-save functionality
  useAutoSave();

  const insertSlideSnippet = (text: string) => {
    useEditorStore.getState().editorFacade?.replaceSelection(text);
  };

  const handleNewFile = async () => {
    logger.component('EditorPanel', 'handleNewFile clicked');
    // Dans un livre, « Nouveau » ajoute un chapitre au manuscrit : vider
    // l'éditeur sortirait l'auteur du projet (`filePath: null`) et
    // couperait l'autosave.
    if (isBook) {
      try {
        await addChapter(t('book.untitledChapter'));
      } catch (error) {
        logger.error('EditorPanel', error);
        await useDialogStore.getState().showAlert(t('book.addChapterError'));
      }
      return;
    }
    if (await useDialogStore.getState().showConfirm(t('toolbar.newFileConfirm'))) {
      // L'éditeur vivant reçoit l'édition via la façade ; le store suit.
      useEditorStore.getState().editorFacade?.setValue('');
      setContent('');
      logger.component('EditorPanel', 'New file created');
    }
  };

  const handleOpenFile = async () => {
    logger.component('EditorPanel', 'handleOpenFile clicked');
    try {
      const result = await window.electron.dialog.openFile({
        properties: ['openFile'],
        filters: [
          { name: t('toolbar.markdown'), extensions: ['md', 'markdown'] },
          { name: t('project.allFiles'), extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        logger.component('EditorPanel', 'Loading file', { path: result.filePaths[0] });
        await loadFile(result.filePaths[0]);
        logger.component('EditorPanel', 'File loaded successfully');
      }
    } catch (error) {
      logger.error('EditorPanel', error);
      await useDialogStore.getState().showAlert(t('toolbar.openError'));
    }
  };

  const handleSaveFile = async () => {
    logger.component('EditorPanel', 'handleSaveFile clicked');
    try {
      await saveFile();
      logger.component('EditorPanel', 'File saved successfully');
    } catch (error: unknown) {
      // If no file path, show save dialog
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('No file path')) {
        logger.component('EditorPanel', 'No file path, showing save dialog');
        const result = await window.electron.dialog.saveFile({
          filters: [
            { name: t('toolbar.markdown'), extensions: ['md'] },
            { name: t('project.allFiles'), extensions: ['*'] },
          ],
        });

        if (!result.canceled && result.filePath) {
          logger.component('EditorPanel', 'Saving file as', { path: result.filePath });
          await useEditorStore.getState().saveFileAs(result.filePath);
          logger.component('EditorPanel', 'File saved successfully');
        }
      } else {
        logger.error('EditorPanel', error);
        await useDialogStore.getState().showAlert(t('toolbar.saveError'));
      }
    }
  };

  // Academic-specific buttons (not in Crepe toolbar)
  const handleCitation = () => {
    logger.component('EditorPanel', 'handleCitation clicked');
    insertFormatting('citation');
  };

  const handleFootnote = () => {
    logger.component('EditorPanel', 'handleFootnote clicked');
    insertFormatting('footnote');
  };

  // Renumérotation manuelle des notes (arbitrage 2 du plan CM6 : commande
  // explicite, jamais silencieuse). CM6 uniquement.
  const handleRenumberFootnotes = async () => {
    logger.component('EditorPanel', 'handleRenumberFootnotes clicked');
    const store = useEditorStore.getState();

    // Document isolé : comportement historique.
    if (!isBook) {
      const result = renumberFootnotes(store.getLiveContent());
      if (!result.changed) return;
      if (store.editorFacade) store.editorFacade.setValue(result.content);
      else setContent(result.content);
      return;
    }

    // Livre : la numérotation traverse les chapitres, dans l'ordre du
    // manifeste et selon le réglage d'ouvrage (arbitrage 3).
    try {
      const docs = await useManuscriptStore.getState().readManuscript();
      if (docs.length === 0) return;

      const mode = useProjectStore.getState().bookSettings.noteNumbering;
      const renumbered = renumberManuscript(
        docs.map((d) => ({ key: d.chapter.filePath, content: d.content })),
        mode
      );
      const changed = renumbered.filter((d) => d.changed);
      if (changed.length === 0) {
        await useDialogStore.getState().showAlert(t('book.renumberNoChange'));
        return;
      }

      const project = useProjectStore.getState().currentProject;
      if (!project) return;
      const openRel = currentRelativePath();
      const originals = new Map(docs.map((d) => [d.chapter.filePath, d.content]));
      const written: string[] = [];

      try {
        for (const doc of changed) {
          if (doc.key === openRel) {
            // Chapitre ouvert : passer par l'éditeur, l'édition reste
            // annulable et la sauvegarde suit le chemin habituel.
            store.editorFacade?.setValue(doc.content);
            await useEditorStore.getState().saveFile();
          } else {
            const result = await window.electron.editor.saveFile(
              `${project.path}/${doc.key}`,
              doc.content
            );
            if (!result.success) throw new Error(result.error || doc.key);
          }
          written.push(doc.key);
        }
      } catch (error) {
        // Atomique : ce qui a été écrit est remis dans son état d'origine —
        // un manuscrit à moitié renuméroté serait pire que pas de
        // renumérotation du tout.
        for (const key of written) {
          const original = originals.get(key);
          if (original === undefined) continue;
          if (key === openRel) store.editorFacade?.setValue(original);
          else {
            await window.electron.editor
              .saveFile(`${project.path}/${key}`, original)
              .catch(() => undefined);
          }
        }
        throw error;
      }

      await useManuscriptStore.getState().refreshAll();
      await useDialogStore
        .getState()
        .showAlert(t('book.renumberDone', { count: changed.length }));
    } catch (error) {
      logger.error('EditorPanel', error);
      await useDialogStore.getState().showAlert(t('book.renumberError'));
    }
  };

  /**
   * Vérification des citations. Les clés sont relevées sur l'arbre Lezer
   * (`collectCitationKeys`) : les `[@…]` des blocs de code ne comptent plus,
   * les citations nues (`@clef`) sont vues, et un cluster `[@a; @b]` compte
   * deux clés. Dans un livre, la vérification porte sur TOUT le manuscrit et
   * situe chaque clé manquante dans son chapitre.
   */
  const handleCheckCitations = async () => {
    logger.component('EditorPanel', 'handleCheckCitations clicked');
    const availableKeys = new Set(citations.map((c) => c.id));

    try {
      const sources: Array<{ label: string | null; content: string }> = isBook
        ? (await useManuscriptStore.getState().readManuscript()).map((d) => ({
            label: d.chapter.title,
            content: d.content,
          }))
        : [{ label: null, content: useEditorStore.getState().getLiveContent() }];

      // Clé manquante -> chapitres où elle apparaît (ordre du manifeste).
      const missing = new Map<string, Set<string>>();
      let total = 0;
      for (const source of sources) {
        for (const occurrence of collectCitationKeys(source.content)) {
          total += 1;
          if (availableKeys.has(occurrence.key)) continue;
          const where = missing.get(occurrence.key) ?? new Set<string>();
          if (source.label) where.add(source.label);
          missing.set(occurrence.key, where);
        }
      }

      if (missing.size === 0) {
        await useDialogStore
          .getState()
          .showAlert(t('citations.allValid', { count: total }));
        return;
      }

      const lines = [...missing.entries()].map(([key, where]) =>
        where.size > 0 ? `[@${key}] — ${[...where].join(', ')}` : `[@${key}]`
      );
      await useDialogStore
        .getState()
        .showAlert(`${t('citations.missing', { count: missing.size })}\n\n${lines.join('\n')}`);
    } catch (error) {
      logger.error('EditorPanel', error);
      await useDialogStore.getState().showAlert(t('citations.checkError'));
    }
  };

  return (
    <div className="editor-panel">
      {/* Toolbar - File operations and academic-specific buttons */}
      <div className="editor-toolbar">
        {/* File operations */}
        <div className="toolbar-section">
          <button className="toolbar-btn" onClick={handleNewFile} title={t('toolbar.newFile')}>
            <FileText size={18} strokeWidth={1.5} />
          </button>
          <button className="toolbar-btn" onClick={handleOpenFile} title={t('toolbar.open')}>
            <FolderOpen size={18} strokeWidth={1.5} />
          </button>
          <button className="toolbar-btn" onClick={handleSaveFile} title={t('toolbar.save')}>
            <Save size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* Academic tools - citation and footnote */}
        <div className="toolbar-section">
          <button className="toolbar-btn" onClick={handleCitation} title={t('toolbar.citation')}>
            <BookOpen size={18} strokeWidth={1.5} />
          </button>
          <button className="toolbar-btn" onClick={handleFootnote} title={t('toolbar.footnote')}>
            <Superscript size={18} strokeWidth={1.5} />
          </button>
          <button
            className="toolbar-btn"
            onClick={() => void handleRenumberFootnotes()}
            title={t('toolbar.renumberFootnotes')}
          >
            <ListOrdered size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* Validation and Similarity */}
        <div className="toolbar-section">
          <button className="toolbar-btn" onClick={handleCheckCitations} title={t('toolbar.checkCitations')}>
            <CheckCircle size={18} strokeWidth={1.5} />
          </button>
          <button
            className={`toolbar-btn ${isSimilarityPanelOpen ? 'active' : ''}`}
            onClick={openSimilarityPanel}
            title={t('similarity.title')}
          >
            <Search size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* Slides insertion (presentation projects) */}
        {isPresentation && (
          <div className="toolbar-section">
            <button
              className="toolbar-btn"
              onClick={() => insertSlideSnippet('\n\n---\n\n# Nouvelle section\n\n')}
              title={t('presentation.addSection')}
            >
              <Columns size={18} strokeWidth={1.5} />
            </button>
            <button
              className="toolbar-btn"
              onClick={() => insertSlideSnippet('\n\n---\n\n## Titre de la slide\n\n')}
              title={t('presentation.addSlide')}
            >
              <Plus size={18} strokeWidth={1.5} />
            </button>
            <button
              className="toolbar-btn"
              onClick={() => insertSlideSnippet('\n\nNote:\nNotes du présentateur ici.\n')}
              title={t('presentation.addNote')}
            >
              <MessageSquare size={18} strokeWidth={1.5} />
            </button>
          </div>
        )}

        {/* Slides drawers + export (presentation projects) */}
        {isPresentation && (
          <div className="toolbar-section toolbar-section-right">
            <button
              className={`toolbar-btn ${isPreviewOpen ? 'active' : ''}`}
              onClick={togglePreview}
              title={t('slides.preview.title')}
            >
              <Eye size={18} strokeWidth={1.5} />
            </button>
            <button
              className={`toolbar-btn ${isGenerationOpen ? 'active' : ''}`}
              onClick={openGeneration}
              title={t('slides.generate.title')}
            >
              <Sparkles size={18} strokeWidth={1.5} />
            </button>
            <button
              className="toolbar-btn"
              onClick={() => setShowExportModal(true)}
              title={t('presentation.export')}
            >
              <FileDown size={18} strokeWidth={1.5} />
            </button>
          </div>
        )}

      </div>

      {/* Editor content — colonne flex : l'éditeur (ou l'atelier slides)
          prend l'espace restant, la barre de stats garde ses 28 px. */}
      <div className="editor-content">
        {isPresentation ? (
          <div className="slides-workbench">
            <PanelGroup direction="horizontal">
              <Panel defaultSize={22} minSize={15} maxSize={35}>
                <SlideNavigator />
              </Panel>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={isGenerationOpen ? 53 : 78} minSize={40}>
                <CodeMirrorEditor />
              </Panel>
              {isPreviewOpen && (
                <>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel defaultSize={35} minSize={25} maxSize={55}>
                    <SlidePreviewPanel />
                  </Panel>
                </>
              )}
              {isGenerationOpen && (
                <>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel defaultSize={25} minSize={20} maxSize={40}>
                    <SlideGenerationPanel />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </div>
        ) : isBook ? (
          <div className="book-workbench">
            <PanelGroup direction="horizontal">
              <Panel defaultSize={24} minSize={15} maxSize={40}>
                <ChapterNavigator />
              </Panel>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={76} minSize={40}>
                <CodeMirrorEditor />
              </Panel>
            </PanelGroup>
          </div>
        ) : (
          <CodeMirrorEditor />
        )}
        <DocumentStats />
      </div>

      {/* Similarity Panel (floating) */}
      {isSimilarityPanelOpen && (
        <Suspense fallback={null}>
          <SimilarityPanel />
        </Suspense>
      )}

      {/* Export presentation modal */}
      {showExportModal && (
        <Suspense fallback={null}>
          <PresentationExportModal
            isOpen={showExportModal}
            onClose={() => setShowExportModal(false)}
          />
        </Suspense>
      )}
    </div>
  );
};
