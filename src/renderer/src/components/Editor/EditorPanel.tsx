import React, { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText, FolderOpen, Save, CheckCircle, BookOpen, Superscript, Search,
  ListOrdered, Columns, Plus, MessageSquare, Eye, Sparkles, FileDown,
  SearchCode, Inbox,
} from 'lucide-react';
import { DraftsPanel } from './DraftsPanel';
import { useDraftsStore } from '../../stores/draftsStore';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { renumberFootnotes, renumberManuscript } from '@/editor/footnote-tools';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { DocumentStats } from './DocumentStats';
import { SlideNavigator } from '../Slides/SlideNavigator';
import { SlidePreviewPanel } from '../Slides/SlidePreviewPanel';
import { SlideGenerationPanel } from '../Slides/SlideGenerationPanel';
import { ChapterNavigator } from '../Book/ChapterNavigator';
import { ManuscriptSearch } from '../Book/ManuscriptSearch';

// SimilarityPanel self-hides via `isPanelOpen` — lazy-loading keeps its heavy
// dependency tree off the editor's initial chunk.
const SimilarityPanel = lazy(() =>
  import('../Similarity/SimilarityPanel').then((m) => ({ default: m.SimilarityPanel })),
);
// Modal d'export reveal/Beamer — projets presentation uniquement.
const PresentationExportModal = lazy(() =>
  import('../Export/PresentationExportModal').then((m) => ({ default: m.PresentationExportModal })),
);
import { openErrorKey, useEditorStore } from '../../stores/editorStore';
import { useSimilarityStore } from '../../stores/similarityStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSlidesStore } from '../../stores/slidesStore';
import { useManuscriptStore, currentRelativePath } from '../../stores/manuscriptStore';
import { useAutoSave } from '../../hooks/useAutoSave';
import { runCitationCheck } from '../../services/check-citations';
import { newDocument } from '../../services/new-document';
import { unreadableChaptersNote } from '../../services/unreadable-chapters';
import { ExportReadTimedOutError, startExportReadLimit } from '../Export/export-read-limit';
import { logger } from '../../utils/logger';
import './EditorPanel.css';

export const EditorPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { loadFile, saveFile, setContent, insertFormatting } = useEditorStore();
  const { openPanel: openSimilarityPanel, isPanelOpen: isSimilarityPanelOpen } =
    useSimilarityStore();
  const closeSimilarityPanel = useSimilarityStore((s) => s.closePanel);

  // Chantier « même éditeur » : un projet presentation garde CE panneau —
  // la toolbar gagne une section slides et Navigator/Preview/Génération
  // s'ouvrent en tiroirs latéraux autour du même CodeMirrorEditor.
  const isPresentation = useProjectStore((s) => s.currentProject?.type === 'presentation');
  // Projet livre : le manuscrit est fait de N chapitres — le navigateur
  // ouvre l'atelier de la même façon que pour les présentations.
  const isBook = useProjectStore((s) => s.currentProject?.type === 'book');
  const isRenumbering = useManuscriptStore((s) => s.renumbering);
  // Ouvrir un projet et renuméroter ne se chevauchent pas : `loadProject` charge
  // son document par `loadFile`, que le verrou de la renumérotation refuserait, et
  // le projet s'ouvrirait sans son document.
  const isProjectLoading = useProjectStore((s) => s.loadState.kind === 'loading');
  // Brouillons Brainstorm (#7) — panneau flottant, compteur sur le bouton.
  const draftsCount = useDraftsStore((s) => s.drafts.length);
  const isDraftsPanelOpen = useDraftsStore((s) => s.isPanelOpen);
  const toggleDraftsPanel = useDraftsStore((s) => s.togglePanel);
  const closeDraftsPanel = useDraftsStore((s) => s.closePanel);

  // Les deux panneaux flottants occupent le MÊME coin de l'écran : les
  // ouvrir ensemble en masquait un derrière l'autre, son bouton restant
  // pourtant en état actif. Ils s'excluent donc. C'est ici que ça se règle,
  // et non dans les stores, qui deviendraient mutuellement dépendants —
  // et parce que c'est le seul écran où les deux coexistent.
  const showSimilarityPanel = (): void => {
    closeDraftsPanel();
    openSimilarityPanel();
  };
  const showDraftsPanel = (): void => {
    closeSimilarityPanel();
    toggleDraftsPanel();
  };
  const { isPanelOpen: isGenerationOpen, openPanel: openGeneration, isPreviewOpen, togglePreview } = useSlidesStore();
  const [showExportModal, setShowExportModal] = useState(false);
  // Tiroir « chercher dans le livre » (audit item 21) — livres uniquement :
  // Cmd+F reste la recherche du chapitre ouvert.
  const [showManuscriptSearch, setShowManuscriptSearch] = useState(false);

  // Enable auto-save functionality
  useAutoSave();

  const insertSlideSnippet = (text: string) => {
    useEditorStore.getState().editorFacade?.replaceSelection(text);
  };

  const handleNewFile = () => {
    logger.component('EditorPanel', 'handleNewFile clicked');
    void newDocument(t);
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
        const outcome = await loadFile(result.filePaths[0]);
        if (outcome.status === 'locked') {
          await useDialogStore.getState().showAlert(t(outcome.lock));
        }
        logger.component('EditorPanel', 'File load finished', { status: outcome.status });
      }
    } catch (error) {
      logger.error('EditorPanel', error);
      await useDialogStore.getState().showAlert(t(openErrorKey(error, 'toolbar.openError')));
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
          // Invite de remplacement : effet documenté sous Linux seulement.
          properties: ['showOverwriteConfirmation'],
        });

        if (!result.canceled && result.filePath) {
          logger.component('EditorPanel', 'Saving file as', { path: result.filePath });
          const outcome = await useEditorStore.getState().saveFileAs(result.filePath);
          if (outcome.status === 'locked') {
            await useDialogStore.getState().showAlert(t(outcome.lock));
          }
          logger.component('EditorPanel', 'File save finished', { status: outcome.status });
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

  // La façade se relit au moment d'écrire : celle d'avant une attente peut être
  // celle d'une vue détruite, où `setValue` ne fait rien, en silence.
  const setOpenEditorText = (text: string): void => {
    const { editorFacade } = useEditorStore.getState();
    if (editorFacade) editorFacade.setValue(text);
    else setContent(text);
  };

  /**
   * Renumérote tout le livre et rend le message à afficher : l'appelant ne
   * l'affiche qu'une fois les verrous relâchés. `isAbandoned` dit que la limite
   * de durée est passée : l'auteur a repris la main, plus rien ne s'écrit.
   */
  const renumberBook = async (isAbandoned: () => boolean) => {
    const project = useProjectStore.getState().currentProject;
    if (!project) return null;

    // Le verrou arrête ce qui part après lui, pas ce qui était déjà parti.
    // L'éditeur montre-t-il encore le départ ?
    const startRel = currentRelativePath();
    const editorMoved = (): boolean =>
      currentRelativePath() !== startRel ||
      useProjectStore.getState().currentProject?.path !== project.path;

    const { documents: docs, unreadable } = await useManuscriptStore.getState().readManuscript();
    if (isAbandoned()) return null;
    // La numérotation traverse le livre : sans ce chapitre, elle serait fausse partout.
    if (unreadable.length > 0) {
      const note = unreadableChaptersNote(unreadable, t);
      if (!unreadable.some((u) => u.reason === 'absent')) {
        return t('book.renumberUnreadable', { detail: note });
      }
      // Sorti du disque depuis l'ouverture : le manifeste doit l'apprendre, sinon ce refus
      // se répéterait jusqu'à la réouverture du projet, qui l'écarte comme manquant.
      await useProjectStore.getState().refreshChapters();
      return t('book.renumberUnreadable', { detail: `${note} ${t('book.renumberChapterGone')}` });
    }
    if (docs.length === 0) return null;
    if (editorMoved()) return t('book.renumberInterrupted');

    const mode = useProjectStore.getState().bookSettings.noteNumbering;
    const renumbered = renumberManuscript(
      docs.map((d) => ({ key: d.chapter.filePath, content: d.content })),
      mode
    );
    const changed = renumbered.filter((d) => d.changed);
    if (changed.length === 0) return t('book.renumberNoChange');

    const openKey = docs.find((d) => d.live)?.chapter.filePath;
    const originals = new Map(docs.map((d) => [d.chapter.filePath, d.content]));
    const renumberedTexts = new Map(changed.map((d) => [d.key, d.content]));
    // Ce qu'une remise en état doit reprendre, et parmi eux ce qui a réellement
    // quitté son texte d'origine sur le disque.
    const touched: string[] = [];
    const onDisk = new Set<string>();
    let interrupted = false;
    let restoreFailed = false;

    try {
      for (const doc of changed) {
        if (isAbandoned()) return null;
        // Le texte vivant a été lu avant les attentes : ce que l'auteur a tapé
        // depuis n'est pas dans `doc.content`, et `setValue` l'effacerait.
        interrupted =
          editorMoved() ||
          (doc.key === openKey &&
            useEditorStore.getState().getLiveContent() !== originals.get(doc.key));
        if (interrupted) throw new Error('book.renumberInterrupted');

        if (doc.key === openKey) {
          // Chapitre ouvert : passer par l'éditeur, l'édition reste
          // annulable et la sauvegarde suit le chemin habituel.
          setOpenEditorText(doc.content);
          // Avant l'écriture : si elle échoue, le tampon porte déjà le texte
          // renuméroté, et l'autosave l'écrirait seul quelques secondes plus tard.
          touched.push(doc.key);
          await useEditorStore.getState().saveFile();
        } else {
          const result = await window.electron.editor.saveFile(
            `${project.path}/${doc.key}`,
            doc.content
          );
          if (!result.success) throw new Error(result.error || doc.key);
          touched.push(doc.key);
        }
        onDisk.add(doc.key);
      }
    } catch (error) {
      if (!interrupted) logger.error('EditorPanel', error);
      // Atomique : ce qui a été écrit est remis dans son état d'origine —
      // un manuscrit à moitié renuméroté serait pire que pas de
      // renumérotation du tout.
      for (const key of touched) {
        // L'auteur a repris la main : ces textes ont pu changer depuis.
        if (isAbandoned()) break;
        const original = originals.get(key);
        if (original === undefined) continue;
        const target = `${project.path}/${key}`;
        let restored: boolean;
        if (useEditorStore.getState().filePath === target) {
          // Ni l'un ni l'autre des textes de l'opération : l'auteur a tapé depuis.
          // Le remettre à l'original effacerait sa frappe, puis l'enregistrerait.
          const live = useEditorStore.getState().getLiveContent();
          if (live !== original && live !== renumberedTexts.get(key)) {
            interrupted = true;
            continue;
          }
          // L'aller a écrit ce chapitre SUR LE DISQUE (via saveFile) :
          // restaurer le seul tampon de l'éditeur laissait donc le fichier
          // renuméroté, et ne restaurait rien du tout si la façade était
          // nulle ou l'autosave désactivé. On réécrit explicitement.
          setOpenEditorText(original);
          restored = await useEditorStore
            .getState()
            .saveFile()
            .then(
              () => true,
              () => false
            );
        } else {
          // Y compris le chapitre ouvert au départ, si l'éditeur l'a quitté :
          // `saveFile` écrirait son texte dans le fichier qui l'a remplacé.
          restored = await window.electron.editor.saveFile(target, original).then(
            (result) => result.success,
            () => false
          );
        }
        // Une écriture refusée sur un fichier resté à l'original ne change rien.
        if (!restored && onDisk.has(key)) restoreFailed = true;
      }
      if (restoreFailed) return t('book.renumberRestoreFailed');
      if (interrupted) return t('book.renumberInterrupted');
      return t('book.renumberError');
    }

    // Sans l'attendre : le travail est fait, une relecture qui traînerait
    // retiendrait les verrous et le message de fin.
    void useManuscriptStore.getState().refreshAll();
    return t('book.renumberDone', { count: changed.length });
  };

  // Renumérotation manuelle des notes (arbitrage 2 du plan CM6 : commande
  // explicite, jamais silencieuse). CM6 uniquement.
  const handleRenumberFootnotes = async () => {
    logger.component('EditorPanel', 'handleRenumberFootnotes clicked');

    // Document isolé : comportement historique.
    if (!isBook) {
      const result = renumberFootnotes(useEditorStore.getState().getLiveContent());
      if (!result.changed) return;
      setOpenEditorText(result.content);
      return;
    }

    // Livre : la numérotation traverse les chapitres, dans l'ordre du
    // manifeste et selon le réglage d'ouvrage (arbitrage 3). Verrou posé
    // pendant toute l'opération : les chapitres s'écrivent un par un et un
    // export concurrent assemblerait un manuscrit mi-renuméroté (#30).
    // Symétrie du verrou : un export en cours lit les chapitres pendant
    // plusieurs secondes. Renuméroter maintenant les réécrirait sous
    // l'assemblage — le scénario même que #30 prétendait fermer, resté
    // ouvert parce que le verrou n'était consulté que dans un sens.
    const busy = useManuscriptStore.getState().manuscriptBusyReason();
    if (busy) {
      await useDialogStore.getState().showAlert(t(busy));
      return;
    }
    useManuscriptStore.getState().setRenumbering(true);
    useEditorStore.getState().setSwitchLock('book.renumberInProgress');
    let abandoned = false;
    let message: string | null = null;
    try {
      // La limite des exports, pour la même raison : une écriture sans réponse
      // ne s'annule pas, et sans elle un disque mort laisserait chapitres et
      // projet fermés jusqu'à ce qu'on quitte l'app.
      message = await startExportReadLimit()(renumberBook(() => abandoned));
    } catch (error) {
      logger.error('EditorPanel', error);
      abandoned = true;
      message =
        error instanceof ExportReadTimedOutError
          ? t('book.renumberTimedOut', { minutes: error.timeLimitMinutes })
          : t('book.renumberError');
    } finally {
      // Avant l'alerte, jamais après : la navigation et les exports n'ont pas à
      // attendre qu'on ferme un dialogue, qui peut être derrière d'autres.
      useEditorStore.getState().setSwitchLock(null);
      useManuscriptStore.getState().setRenumbering(false);
    }
    if (message) await useDialogStore.getState().showAlert(message);
  };

  /**
   * Vérification des citations — logique partagée avec l'entrée de menu
   * (`services/check-citations.ts`) : les deux portes doivent donner le
   * MÊME résultat. Elles divergeaient, le menu gardant une version regex
   * qui comptait les `[@…]` des blocs de code et ne voyait qu'un chapitre.
   */
  const handleCheckCitations = async () => {
    logger.component('EditorPanel', 'handleCheckCitations clicked');
    await runCitationCheck(t);
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
          {!isPresentation && (
            <button
              className="toolbar-btn"
              onClick={() => void handleRenumberFootnotes()}
              disabled={isRenumbering || isProjectLoading}
              title={t('toolbar.renumberFootnotes')}
            >
              <ListOrdered size={18} strokeWidth={1.5} />
            </button>
          )}
        </div>

        {/* Validation and Similarity */}
        <div className="toolbar-section">
          {!isPresentation && (
            <button className="toolbar-btn" onClick={handleCheckCitations} title={t('toolbar.checkCitations')}>
              <CheckCircle size={18} strokeWidth={1.5} />
            </button>
          )}
          {isBook && (
            <button
              className={`toolbar-btn ${showManuscriptSearch ? 'active' : ''}`}
              onClick={() => setShowManuscriptSearch((open) => !open)}
              title={t('search.title')}
            >
              <SearchCode size={18} strokeWidth={1.5} />
            </button>
          )}
          <button
            className={`toolbar-btn ${isSimilarityPanelOpen ? 'active' : ''}`}
            onClick={showSimilarityPanel}
            title={t('similarity.title')}
          >
            <Search size={18} strokeWidth={1.5} />
          </button>
          {!isPresentation && (
            <button
              className={`toolbar-btn ${isDraftsPanelOpen ? 'active' : ''}`}
              onClick={showDraftsPanel}
              title={t('drafts.title')}
              style={{ position: 'relative' }}
            >
              <Inbox size={18} strokeWidth={1.5} />
              {draftsCount > 0 && (
                <span className="toolbar-btn__count">{draftsCount}</span>
              )}
            </button>
          )}
        </div>

        {/* Slides insertion (presentation projects) */}
        {isPresentation && (
          <div className="toolbar-section">
            <button
              className="toolbar-btn"
              onClick={() => insertSlideSnippet(`\n\n---\n\n# ${t('snippets.newSection')}\n\n`)}
              title={t('presentation.addSection')}
            >
              <Columns size={18} strokeWidth={1.5} />
            </button>
            <button
              className="toolbar-btn"
              onClick={() => insertSlideSnippet(`\n\n---\n\n## ${t('snippets.slideTitle')}\n\n`)}
              title={t('presentation.addSlide')}
            >
              <Plus size={18} strokeWidth={1.5} />
            </button>
            <button
              className="toolbar-btn"
              onClick={() => insertSlideSnippet(`\n\nNote:\n${t('snippets.speakerNotes')}\n`)}
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
              <Panel defaultSize={showManuscriptSearch ? 50 : 76} minSize={35}>
                <CodeMirrorEditor />
              </Panel>
              {showManuscriptSearch && (
                <>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel defaultSize={26} minSize={20} maxSize={45}>
                    <ManuscriptSearch onClose={() => setShowManuscriptSearch(false)} />
                  </Panel>
                </>
              )}
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

      {/* Brouillons Brainstorm (#7, flottant) */}
      {isDraftsPanelOpen && <DraftsPanel />}

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
