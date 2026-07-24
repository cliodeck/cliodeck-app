import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, X, AlertCircle, CheckCircle } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { useManuscriptStore } from '../../stores/manuscriptStore';
import {
  ExportCitationSection,
  loadDefaultCitationValue,
  type ExportCitationValue,
} from './ExportCitationSection';
import './PDFExportModal.css'; // Reuse the same CSS

interface WordExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WordExportModal: React.FC<WordExportModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const { currentProject, chapters, bookSettings } = useProjectStore();
  const { content, filePath, getLiveContent } = useEditorStore();
  const isBook = currentProject?.type === 'book' && (chapters ?? []).length > 0;
  // Livre : tout l'ouvrage, ou le chapitre courant seul (tirage de travail).
  const [bookScope, setBookScope] = useState<'book' | 'chapter'>('book');

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState({ stage: '', message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [hasTemplate, setHasTemplate] = useState(false);
  const [templatePath, setTemplatePath] = useState<string | null>(null);
  const [citation, setCitation] = useState<ExportCitationValue>({
    useEngine: false,
    style: 'chicago-note-bibliography',
    locale: 'fr-FR',
  });

  // Initialize with project data
  useEffect(() => {
    if (currentProject && isOpen) {
      setTitle(currentProject.name);
      setOutputPath(`${currentProject.path}/${currentProject.name}.docx`);

      // Check for .dotx template in project folder
      checkForTemplate();
    }
  }, [currentProject, isOpen]);

  // Load citation defaults from workspace config when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void loadDefaultCitationValue().then((v) => {
      if (!cancelled) setCitation(v);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Listen for progress updates
  useEffect(() => {
    if (!isOpen) return;

    const unsubscribe = window.electron.wordExport.onProgress((progressData) => {
      setProgress(progressData);
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen]);

  const checkForTemplate = async () => {
    if (!currentProject) return;

    try {
      const result = await window.electron.wordExport.findTemplate(currentProject.path);
      if (result.success && result.templatePath) {
        setHasTemplate(true);
        setTemplatePath(result.templatePath);
        console.log('📝 Word template found:', result.templatePath);
      } else {
        setHasTemplate(false);
        setTemplatePath(null);
      }
    } catch (err) {
      console.error('Failed to check for template:', err);
      setHasTemplate(false);
    }
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.electron.dialog.saveFile({
        defaultPath: outputPath,
        filters: [
          { name: t('export.word.wordFiles'), extensions: ['docx'] },
          { name: t('export.word.allFiles'), extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePath) {
        setOutputPath(result.filePath);
      }
    } catch (err: unknown) {
      console.error('Failed to select output path:', err);
    }
  };

  const handleExport = async () => {
    if (!currentProject) {
      setError(t('export.word.noProject'));
      return;
    }

    // Renumérotation en cours : les chapitres s'écrivent un par un sur le
    // disque, exporter maintenant assemblerait un manuscrit mi-renuméroté
    // (#30).
    if (useManuscriptStore.getState().renumbering) {
      setError(t('book.renumberInProgress'));
      return;
    }

    if (!title) {
      setError(t('export.word.enterTitle'));
      return;
    }

    setIsExporting(true);
    setError(null);
    setSuccess(false);

    try {
      // For presentations, load slides.md instead of document.md
      let exportContent = content;
      if (currentProject.type === 'presentation') {
        try {
          const slidesPath = `${currentProject.path}/slides.md`;
          exportContent = await window.electron.fs.readFile(slidesPath);
        } catch (err) {
          console.error('Failed to read slides.md:', err);
          setError(t('export.word.slidesUnreadable'));
          setIsExporting(false);
          return;
        }
      }

      // Livre : le manifeste part au main, qui assemble (ordre, isolation
      // des notes par chapitre). Le chapitre ouvert est transmis depuis
      // l'éditeur vivant, sinon les frappes non sauvegardées manqueraient.
      let manuscript:
        | {
            chapters: typeof chapters;
            liveOverrides?: Record<string, string>;
            scope?: 'book' | { chapterId: string };
          }
        | undefined;
      if (isBook) {
        const relative = filePath?.startsWith(currentProject.path + '/')
          ? filePath.slice(currentProject.path.length + 1)
          : null;
        const current = relative
          ? (chapters ?? []).find((c) => c.filePath === relative)
          : undefined;
        manuscript = {
          chapters,
          liveOverrides: relative ? { [relative]: getLiveContent() } : undefined,
          scope:
            bookScope === 'chapter' && current ? { chapterId: current.id } : 'book',
        };
        exportContent = '';
      }

      const result = await window.electron.wordExport.export({
        projectPath: currentProject.path,
        projectType: currentProject.type,
        content: exportContent,
        bookSettings: isBook
          ? (bookSettings as unknown as Record<string, unknown>)
          : undefined,
        manuscript,
        outputPath: outputPath,
        bibliographyPath: currentProject.bibliography,
        cslPath: currentProject.cslPath,
        templatePath: templatePath || undefined,
        metadata: {
          title,
          author: author || 'ClioDesk',
          date: new Date().toLocaleDateString('fr-FR'),
        },
        citation: {
          useEngine: citation.useEngine,
          style: citation.style,
          locale: citation.locale,
        },
      });

      if (result.success) {
        setSuccess(true);
        setTimeout(() => {
          onClose();
          // Reset state
          setIsExporting(false);
          setSuccess(false);
          setError(null);
          setProgress({ stage: '', message: '', progress: 0 });
        }, 2000);
      } else {
        console.error('Word export failed:', result.error);
        setError(result.error || t('export.word.unknownError'));
        setIsExporting(false);
      }
    } catch (err: unknown) {
      console.error('Word export threw:', err);
      setError(t('export.word.error'));
      setIsExporting(false);
    }
  };

  const handleClose = () => {
    if (!isExporting) {
      onClose();
      // Reset state
      setError(null);
      setSuccess(false);
      setProgress({ stage: '', message: '', progress: 0 });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="pdf-export-modal" onClick={handleClose}>
      <div
        className="pdf-export-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="word-export-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pdf-export-header">
          <h3 id="word-export-modal-title">{t('export.word.title')}</h3>
          <button
            className="close-btn"
            onClick={handleClose}
            disabled={isExporting}
            aria-label={t('export.word.cancel')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="pdf-export-body">
          {/* Template Detection */}
          {hasTemplate && templatePath && (
            <div className="export-hint export-hint--success">
              <CheckCircle size={16} style={{ display: 'inline', marginRight: '0.5rem' }} />
              {t('export.word.templateDetected', { file: templatePath.split('/').pop() })}
            </div>
          )}

          {/* Livre : périmètre de l'export (arbitrage 9 — tirage de travail) */}
          {isBook && (
            <div className="form-field">
              <label htmlFor="word-export-scope">{t('export.scope.label')}</label>
              <select
                id="word-export-scope"
                value={bookScope}
                onChange={(e) => setBookScope(e.target.value as 'book' | 'chapter')}
                disabled={isExporting}
              >
                <option value="book">
                  {t('export.scope.wholeBook', { count: (chapters ?? []).length })}
                </option>
                <option value="chapter">{t('export.scope.currentChapter')}</option>
              </select>
            </div>
          )}

          {/* Form Fields */}
          <div className="form-field">
            <label htmlFor="word-export-title">{t('export.word.documentTitle')}</label>
            <input
              id="word-export-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('export.word.titlePlaceholder')}
              disabled={isExporting}
            />
          </div>

          <div className="form-field">
            <label htmlFor="word-export-author">{t('export.word.author')}</label>
            <input
              id="word-export-author"
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={t('export.word.authorPlaceholder')}
              disabled={isExporting}
            />
          </div>

          {/* Info about abstract for articles and books */}
          {(currentProject?.type === 'article' || currentProject?.type === 'book') && (
            <div className="export-hint">
              💡 {t('export.word.abstractNote', { file: 'abstract.md' })}
            </div>
          )}

          <ExportCitationSection
            value={citation}
            onChange={setCitation}
            disabled={isExporting}
          />

          <div className="form-field">
            <label htmlFor="word-export-output">{t('export.word.outputFile')}</label>
            <div className="path-selector">
              <input
                id="word-export-output"
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder={t('export.word.outputPlaceholder')}
                disabled={isExporting}
              />
              <button onClick={handleSelectOutputPath} disabled={isExporting}>
                {t('export.word.browse')}
              </button>
            </div>
          </div>

          {/* Progress */}
          {isExporting && (
            <div className="export-progress">
              <div className="progress-bar-container">
                <div className="progress-bar" style={{ width: `${progress.progress}%` }} />
              </div>
              <p className="progress-message">{progress.message}</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="export-error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="export-success">
              <CheckCircle size={16} />
              <span>{t('export.word.success', { path: outputPath })}</span>
            </div>
          )}
        </div>

        <div className="pdf-export-footer">
          <button className="btn-cancel" onClick={handleClose} disabled={isExporting}>
            {t('export.word.cancel')}
          </button>
          <button
            className="btn-export"
            onClick={handleExport}
            disabled={isExporting || !title}
          >
            <FileDown size={16} />
            {isExporting ? t('export.word.exporting') : t('export.word.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
