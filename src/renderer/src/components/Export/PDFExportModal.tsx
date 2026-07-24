import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, X, AlertCircle, CheckCircle } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { currentRelativePath, useManuscriptStore } from '../../stores/manuscriptStore';
import {
  ExportCitationSection,
  loadDefaultCitationValue,
  type ExportCitationValue,
} from './ExportCitationSection';
import './PDFExportModal.css';

interface PDFExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PDFExportModal: React.FC<PDFExportModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const { currentProject, chapters, bookSettings } = useProjectStore();
  const { content } = useEditorStore();
  const isBook = currentProject?.type === 'book';
  // Tirage de travail : l'auteur peut n'exporter que le chapitre ouvert
  // (arbitrage 9). Par défaut, le livre entier.
  const [bookScope, setBookScope] = useState<'book' | 'chapter'>('book');

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState({ stage: '', message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [dependenciesChecked, setDependenciesChecked] = useState(false);
  const [hasPandoc, setHasPandoc] = useState(false);
  const [hasXelatex, setHasXelatex] = useState(false);
  const [citation, setCitation] = useState<ExportCitationValue>({
    useEngine: false,
    style: 'chicago-note-bibliography',
    locale: 'fr-FR',
  });

  // Check dependencies on mount
  useEffect(() => {
    if (isOpen && !dependenciesChecked) {
      checkDependencies();
    }
  }, [isOpen]);

  // Initialize with project data
  useEffect(() => {
    if (currentProject && isOpen) {
      setTitle(currentProject.name);
      setOutputPath(`${currentProject.path}/${currentProject.name}.pdf`);
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

    const unsubscribe = window.electron.pdfExport.onProgress((progressData) => {
      setProgress(progressData);
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen]);

  const checkDependencies = async () => {
    try {
      const result = await window.electron.pdfExport.checkDependencies();
      setHasPandoc(result.pandoc);
      setHasXelatex(result.xelatex);
      setDependenciesChecked(true);

      if (!result.pandoc || !result.xelatex) {
        const missing = [
          !result.pandoc ? t('export.pdf.missingPandoc') : null,
          !result.xelatex ? t('export.pdf.missingXelatex') : null,
        ].filter(Boolean);
        setError(`${t('export.pdf.missingDeps')}\n${missing.map((m) => `- ${m}`).join('\n')}`);
      }
    } catch (err: unknown) {
      // Le détail technique reste en console pour le diagnostic ;
      // l'utilisateur reçoit une phrase actionnable.
      console.error('Failed to check export dependencies:', err);
      setError(t('export.pdf.depsCheckError'));
    }
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.electron.dialog.saveFile({
        defaultPath: outputPath,
        filters: [
          { name: t('export.pdf.pdfFiles'), extensions: ['pdf'] },
          { name: t('export.pdf.allFiles'), extensions: ['*'] },
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
      setError(t('export.pdf.noProject'));
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
      setError(t('export.pdf.enterTitle'));
      return;
    }

    if (!hasPandoc || !hasXelatex) {
      setError(t('export.pdf.depsRequired'));
      return;
    }

    setIsExporting(true);
    setError(null);
    setSuccess(false);

    try {
      // Un livre n'a pas de document unique : son manuscrit est assemblé
      // côté main à partir du manifeste (le tampon de l'éditeur ne contient
      // que le chapitre ouvert). Le texte vivant de ce chapitre est
      // transmis en `liveOverrides` pour que les frappes non sauvegardées
      // soient exportées.
      let manuscript:
        | {
            chapters: typeof chapters;
            liveOverrides?: Record<string, string>;
            scope?: 'book' | { chapterId: string };
          }
        | undefined;
      if (isBook) {
        const openRel = currentRelativePath();
        const liveContent = useEditorStore.getState().getLiveContent();
        const openChapter = openRel
          ? (chapters ?? []).find((c) => c.filePath === openRel)
          : undefined;

        if (bookScope === 'chapter' && !openChapter) {
          setError(t('export.pdf.noChapterOpen'));
          setIsExporting(false);
          return;
        }

        manuscript = {
          chapters: (chapters ?? []).filter((c) => !c.missing),
          liveOverrides: openRel ? { [openRel]: liveContent } : undefined,
          scope:
            bookScope === 'chapter' && openChapter
              ? { chapterId: openChapter.id }
              : 'book',
        };
      }

      // For presentations, load slides.md instead of document.md
      let exportContent = content;
      if (currentProject.type === 'presentation') {
        try {
          const slidesPath = `${currentProject.path}/slides.md`;
          exportContent = await window.electron.fs.readFile(slidesPath);
        } catch (err) {
          console.error('Failed to read slides.md:', err);
          setError(t('export.pdf.slidesUnreadable'));
          setIsExporting(false);
          return;
        }
      }

      // For presentations, load Beamer configuration if it exists
      let beamerConfig;
      if (currentProject.type === 'presentation') {
        try {
          const beamerConfigPath = `${currentProject.path}/beamer-config.json`;
          const configExists = await window.electron.fs.exists(beamerConfigPath);
          if (configExists) {
            const configContent = await window.electron.fs.readFile(beamerConfigPath);
            beamerConfig = JSON.parse(configContent);
            console.log('📊 Beamer configuration loaded:', beamerConfig);
          }
        } catch (err) {
          console.warn('No Beamer config found, using defaults');
        }
      }

      const result = await window.electron.pdfExport.export({
        projectPath: currentProject.path,
        projectType: currentProject.type,
        content: manuscript ? '' : exportContent,
        manuscript,
        bookSettings: isBook ? bookSettings : undefined,
        outputPath: outputPath,
        bibliographyPath: currentProject.bibliography,
        cslPath: currentProject.cslPath,
        metadata: {
          title,
          author: author || 'ClioDesk',
          date: new Date().toLocaleDateString('fr-FR'),
        },
        beamerConfig,
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
        console.error('PDF export failed:', result.error);
        setError(result.error || t('export.pdf.unknownError'));
        setIsExporting(false);
      }
    } catch (err: unknown) {
      console.error('PDF export threw:', err);
      setError(t('export.pdf.error'));
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

  // `chapters` est vide hors projet livre ; le garde évite un accès à
  // undefined si le store n'a pas encore été peuplé.
  const partCount = (chapters ?? []).filter((c) => !c.missing).length;

  return (
    <div className="pdf-export-modal" onClick={handleClose}>
      <div
        className="pdf-export-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-export-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pdf-export-header">
          <h3 id="pdf-export-modal-title">{t('export.pdf.title')}</h3>
          <button
            className="close-btn"
            onClick={handleClose}
            disabled={isExporting}
            aria-label={t('export.pdf.cancel')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="pdf-export-body">
          {/* Dependency Check */}
          {dependenciesChecked && (
            <div className="dependency-status">
              <div className={`dependency-item ${hasPandoc ? 'success' : 'error'}`}>
                {hasPandoc ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                <span>
                  {t('export.pdf.pandoc')}{' '}
                  {hasPandoc ? t('export.pdf.installed') : t('export.pdf.missing')}
                </span>
              </div>
              <div className={`dependency-item ${hasXelatex ? 'success' : 'error'}`}>
                {hasXelatex ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                <span>
                  {t('export.pdf.xelatex')}{' '}
                  {hasXelatex ? t('export.pdf.installed') : t('export.pdf.missing')}
                </span>
              </div>
            </div>
          )}

          {/* Portée de l'export d'un livre : ouvrage entier ou tirage de
              travail du chapitre ouvert (plan chapitres, arbitrage 9). */}
          {isBook && (
            <div className="form-field">
              <label htmlFor="pdf-export-scope">{t('export.scope.label')}</label>
              <select
                id="pdf-export-scope"
                value={bookScope}
                onChange={(e) => setBookScope(e.target.value as 'book' | 'chapter')}
                disabled={isExporting}
              >
                <option value="book">
                  {t('export.scope.wholeBook', { count: partCount })}
                </option>
                <option value="chapter">{t('export.scope.currentChapter')}</option>
              </select>
            </div>
          )}

          {/* Form Fields */}
          <div className="form-field">
            <label htmlFor="pdf-export-title">{t('export.pdf.documentTitle')}</label>
            <input
              id="pdf-export-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('export.pdf.titlePlaceholder')}
              disabled={isExporting}
            />
          </div>

          <div className="form-field">
            <label htmlFor="pdf-export-author">{t('export.pdf.author')}</label>
            <input
              id="pdf-export-author"
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={t('export.pdf.authorPlaceholder')}
              disabled={isExporting}
            />
          </div>

          {/* Info about abstract for articles and books */}
          {(currentProject?.type === 'article' || currentProject?.type === 'book') && (
            <div className="export-hint">
              💡 {t('export.pdf.abstractNote', { file: 'abstract.md' })}
            </div>
          )}

          {/* Info about presentations */}
          {currentProject?.type === 'presentation' && (
            <div className="export-hint">
              🎬 {t('export.pdf.beamer', { file: 'slides.md' })}
              <br />
              <br />
              <strong>{t('export.pdf.beamerSyntax')}</strong>
              <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                <li>
                  <code>#</code> {t('export.pdf.beamerSlideTitle')}
                </li>
                <li>
                  <code>##</code> {t('export.pdf.beamerSubtitle')}
                </li>
                <li>
                  <code>::: notes</code> … <code>:::</code> {t('export.pdf.beamerNotes')}
                </li>
              </ul>
            </div>
          )}

          <ExportCitationSection
            value={citation}
            onChange={setCitation}
            disabled={isExporting}
          />

          <div className="form-field">
            <label htmlFor="pdf-export-output">{t('export.pdf.outputFile')}</label>
            <div className="path-selector">
              <input
                id="pdf-export-output"
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder={t('export.pdf.outputPlaceholder')}
                disabled={isExporting}
              />
              <button onClick={handleSelectOutputPath} disabled={isExporting}>
                {t('export.pdf.browse')}
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
              <span>{t('export.pdf.success', { path: outputPath })}</span>
            </div>
          )}
        </div>

        <div className="pdf-export-footer">
          <button className="btn-cancel" onClick={handleClose} disabled={isExporting}>
            {t('export.pdf.cancel')}
          </button>
          <button
            className="btn-export"
            onClick={handleExport}
            disabled={isExporting || !hasPandoc || !hasXelatex || !title}
          >
            <FileDown size={16} />
            {isExporting ? t('export.pdf.exporting') : t('export.pdf.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
