import React, { useState, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Plus, Columns, MessageSquare, BookOpen, FileDown, Sparkles, Eye } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { MarkdownEditor } from '../Editor/MarkdownEditor';
import { SlideNavigator } from './SlideNavigator';
import { SlideGenerationPanel } from './SlideGenerationPanel';
import { SlidePreviewPanel } from './SlidePreviewPanel';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useSlidesStore } from '../../stores/slidesStore';
import { useAutoSave } from '../../hooks/useAutoSave';
import './SlideEditorPanel.css';
import './SlideGenerationPanel.css';
import './SlidePreviewPanel.css';

const PresentationExportModal = lazy(() =>
  import('../Export/PresentationExportModal').then(m => ({ default: m.PresentationExportModal }))
);

export const SlideEditorPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { saveFile, monacoEditor, isDirty } = useEditorStore();
  const { currentProject } = useProjectStore();
  const { isPanelOpen, openPanel, isPreviewOpen, togglePreview } = useSlidesStore();
  const [showExportModal, setShowExportModal] = useState(false);

  useAutoSave();

  const handleSave = async () => {
    try {
      await saveFile();
    } catch (error: unknown) {
      await useDialogStore.getState().showAlert(t('toolbar.saveError'));
    }
  };

  const insertAtCursor = (text: string) => {
    if (monacoEditor) {
      const selection = monacoEditor.getSelection();
      if (selection) {
        monacoEditor.executeEdits('slide-toolbar', [{ range: selection, text }]);
        monacoEditor.focus();
      }
    }
  };

  const handleAddSection = () => {
    insertAtCursor('\n\n---\n\n# Nouvelle section\n\n');
  };

  const handleAddSlide = () => {
    insertAtCursor('\n\n---\n\n## Titre de la slide\n\n');
  };

  const handleAddNote = () => {
    insertAtCursor('\n\nNote:\nNotes du présentateur ici.\n');
  };

  const handleInsertCitation = () => {
    insertAtCursor('[@clé_citation]');
  };

  if (!currentProject) return null;

  return (
    <div className="slide-editor-panel">
      {/* Toolbar */}
      <div className="editor-toolbar slide-toolbar">
        <div className="toolbar-section">
          <button
            className={`toolbar-btn ${isDirty ? 'dirty' : ''}`}
            onClick={handleSave}
            title={t('toolbar.save')}
          >
            <Save size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="toolbar-section">
          <button className="toolbar-btn" onClick={handleAddSection} title={t('presentation.addSection', '# Section (→)')}>
            <Columns size={18} strokeWidth={1.5} />
          </button>
          <button className="toolbar-btn" onClick={handleAddSlide} title={t('presentation.addSlide', '## Slide (↓)')}>
            <Plus size={18} strokeWidth={1.5} />
          </button>
          <button className="toolbar-btn" onClick={handleAddNote} title={t('presentation.addNote')}>
            <MessageSquare size={18} strokeWidth={1.5} />
          </button>
          <button className="toolbar-btn" onClick={handleInsertCitation} title={t('presentation.insertCitation')}>
            <BookOpen size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="toolbar-section toolbar-section-right">
          <button
            className={`toolbar-btn ${isPreviewOpen ? 'active' : ''}`}
            onClick={togglePreview}
            title={t('slides.preview.title')}
          >
            <Eye size={18} strokeWidth={1.5} />
          </button>
          <button
            className={`toolbar-btn ${isPanelOpen ? 'active' : ''}`}
            onClick={openPanel}
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
      </div>

      {/* Main content: navigator + editor + AI panel */}
      <div className="slide-editor-content">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={22} minSize={15} maxSize={35}>
            <SlideNavigator />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize={isPanelOpen ? 53 : 78} minSize={40}>
            <MarkdownEditor />
          </Panel>
          {isPreviewOpen && (
            <>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={35} minSize={25} maxSize={55}>
                <SlidePreviewPanel />
              </Panel>
            </>
          )}
          {isPanelOpen && (
            <>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={25} minSize={20} maxSize={40}>
                <SlideGenerationPanel />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* Export modal */}
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
