import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOpen, Save, CheckCircle, BookOpen, Superscript, Eye, Code2, Search } from 'lucide-react';
import { MilkdownEditor } from './MilkdownEditor';
import { MarkdownEditor } from './MarkdownEditor';
import { DocumentStats } from './DocumentStats';
import { SimilarityPanel } from '../Similarity/SimilarityPanel';
import { useEditorStore } from '../../stores/editorStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useSimilarityStore } from '../../stores/similarityStore';
import { useAutoSave } from '../../hooks/useAutoSave';
import { logger } from '../../utils/logger';
import './EditorPanel.css';

export const EditorPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { loadFile, saveFile, setContent, content, insertFormatting, editorMode, toggleEditorMode } = useEditorStore();
  const { citations } = useBibliographyStore();
  const { openPanel: openSimilarityPanel, isPanelOpen: isSimilarityPanelOpen } = useSimilarityStore();

  // Enable auto-save functionality
  useAutoSave();

  const handleNewFile = () => {
    logger.component('EditorPanel', 'handleNewFile clicked');
    if (window.confirm(t('toolbar.newFileConfirm'))) {
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
      alert(t('toolbar.openError'));
    }
  };

  const handleSaveFile = async () => {
    logger.component('EditorPanel', 'handleSaveFile clicked');
    try {
      await saveFile();
      logger.component('EditorPanel', 'File saved successfully');
    } catch (error: any) {
      // If no file path, show save dialog
      if (error.message.includes('No file path')) {
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
        alert(t('toolbar.saveError'));
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

  const handleCheckCitations = () => {
    logger.component('EditorPanel', 'handleCheckCitations clicked');
    // Extract all citations from content
    const citationMatches = content.match(/\[@([^\]]+)\]/g) || [];
    const citedKeys = citationMatches.map(match => match.replace(/\[@|]/g, ''));

    // Get all available citation keys
    const availableKeys = citations.map(c => c.id);

    // Find missing citations
    const missingCitations = citedKeys.filter(key => !availableKeys.includes(key));
    const duplicateCitations = citedKeys.filter((key, index) => citedKeys.indexOf(key) !== index);

    if (missingCitations.length === 0 && duplicateCitations.length === 0) {
      alert('Toutes les citations sont valides !');
    } else {
      let message = '';
      if (missingCitations.length > 0) {
        message += `Citations manquantes dans la bibliographie:\n${missingCitations.join(', ')}\n\n`;
      }
      if (duplicateCitations.length > 0) {
        message += `Citations en double:\n${[...new Set(duplicateCitations)].join(', ')}`;
      }
      alert(message);
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

        {/* Editor mode toggle */}
        <div className="toolbar-section toolbar-section-right">
          <button
            className={`toolbar-btn ${editorMode === 'wysiwyg' ? 'active' : ''}`}
            onClick={() => editorMode !== 'wysiwyg' && toggleEditorMode()}
            title={t('toolbar.wysiwygMode')}
          >
            <Eye size={18} strokeWidth={1.5} />
          </button>
          <button
            className={`toolbar-btn ${editorMode === 'source' ? 'active' : ''}`}
            onClick={() => editorMode !== 'source' && toggleEditorMode()}
            title={t('toolbar.sourceMode')}
          >
            <Code2 size={18} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Editor content */}
      <div className="editor-content">
        {editorMode === 'wysiwyg' ? <MilkdownEditor /> : <MarkdownEditor />}
        <DocumentStats />
      </div>

      {/* Similarity Panel (floating) */}
      <SimilarityPanel />
    </div>
  );
};
