import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, X, AlertCircle, CheckCircle, WifiOff, FileType, Lightbulb } from 'lucide-react';

type ExportMode = 'online' | 'offline' | 'pdf';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import {
  manuscriptFileName,
  resolveManuscriptContent,
} from '../../services/export-manuscript-content';
import './PresentationExportModal.css';

import { exportErrorMessage, exportThrownMessage } from './export-error';
import { readOptionalConfig, startExportReadLimit } from './export-read-limit';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMountedTimeout } from '../../hooks/useMountedTimeout';
import { backdropClose } from '../../utils/backdropClose';
interface PresentationExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PresentationExportModal: React.FC<PresentationExportModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const { currentProject } = useProjectStore();
  const { filePath, getLiveContent } = useEditorStore();

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [exportMode, setExportMode] = useState<ExportMode>('online');
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState({ stage: '', message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // La minuterie de succès appelle le `onClose` du parent : démontée, la
  // modale ne doit plus fermer ce qui serait ouvert entre-temps.
  const afterSuccess = useMountedTimeout();

  // Initialize with project data
  useEffect(() => {
    if (currentProject && isOpen) {
      setTitle(currentProject.name);
      setOutputPath(`${currentProject.path}/${currentProject.name}.html`);
    }
  }, [currentProject, isOpen]);

  // Listen for progress updates
  useEffect(() => {
    if (!isOpen) return;

    const unsubscribe = window.electron.revealJsExport.onProgress((progressData) => {
      setProgress(progressData);
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen]);

  const handleSelectOutputPath = async () => {
    try {
      const filters = exportMode === 'pdf'
        ? [{ name: 'PDF', extensions: ['pdf'] }, { name: t('presentation.allFiles'), extensions: ['*'] }]
        : [{ name: 'HTML', extensions: ['html'] }, { name: t('presentation.allFiles'), extensions: ['*'] }];

      const result = await window.electron.dialog.saveFile({
        defaultPath: outputPath,
        filters,
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
      setError(t('presentation.noProjectOpen'));
      return;
    }

    // Un livre n'a pas de document unique à découper en diapositives (Q43) : le
    // refuser en le disant, plutôt qu'exporter le chapitre ouvert.
    if (currentProject.type === 'book') {
      setError(t('presentation.bookNotSupported'));
      return;
    }

    if (!title) {
      setError(t('presentation.enterTitle'));
      return;
    }

    setIsExporting(true);
    setError(null);
    setSuccess(false);

    try {
      // Le manuscrit, pas le fichier ouvert : une note de lecture ouverte depuis la
      // bibliographie partait en diaporama sous le titre du projet, et « Nouveau
      // fichier » envoyait une chaîne vide. slides.md pour une présentation,
      // document.md pour un article ; le texte vivant quand c'est lui qui est ouvert.
      const readLimit = startExportReadLimit();
      const resolved = await readLimit(
        resolveManuscriptContent(currentProject.path, currentProject.type, filePath, getLiveContent)
      );
      if (!resolved.ok) {
        setError(t('export.manuscriptUnreadable', { file: resolved.missingFile }));
        setIsExporting(false);
        return;
      }
      if (resolved.content.trim() === '') {
        setError(t('presentation.emptyDeck', { file: manuscriptFileName(currentProject.type) }));
        setIsExporting(false);
        return;
      }

      // Load reveal.js config if it exists
      const config =
        (await readLimit(
          readOptionalConfig<Record<string, unknown>>(`${currentProject.path}/reveal-config.json`)
        )) ?? {};

      const exportOptions = {
        projectPath: currentProject.path,
        content: resolved.content,
        outputPath: outputPath,
        metadata: {
          title,
          // Champ vide → le frontmatter YAML de slides.md peut fournir
          // l'auteur (résolution côté main, resolveDeckConfig).
          author: author || undefined,
          date: new Date().toLocaleDateString(),
        },
        config,
      };

      let result;
      if (exportMode === 'offline') {
        result = await window.electron.revealJsExport.exportOffline(exportOptions);
      } else if (exportMode === 'pdf') {
        result = await window.electron.revealJsExport.exportPDF({
          ...exportOptions,
          outputPath: outputPath.replace(/\.html$/, '.pdf'),
        });
      } else {
        result = await window.electron.revealJsExport.export(exportOptions);
      }

      // Le main résout un chemin relatif contre le projet : le champ, et le message
      // de succès qui le reprend, disent où le fichier est écrit.
      if (result.success && typeof result.outputPath === 'string') setOutputPath(result.outputPath);
      if (result.success) {
        setSuccess(true);
        afterSuccess(() => {
          onClose();
          // Reset state
          setIsExporting(false);
          setSuccess(false);
          setError(null);
          setProgress({ stage: '', message: '', progress: 0 });
        }, 2000);
      } else {
        setError(exportErrorMessage(t, result, t('presentation.unknownError')));
        setIsExporting(false);
      }
    } catch (err: unknown) {
      setError(
        exportThrownMessage(
          t,
          err,
          t('presentation.exportError') + ': ' + (err instanceof Error ? err.message : String(err))
        )
      );
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

  // Échap passe par `handleClose`, comme Annuler : sans effet pendant l'export,
  // dont l'issue n'aurait plus d'interface (le piège de focus s'active quand
  // la ref est attachée au conteneur). Un export bloqué ne reste pas sans
  // sortie : le main l'arrête de lui-même (`export-time-limit.ts`), et ce qui
  // précède l'appel au main a la même limite (`export-read-limit.ts`).
  const trapRef = useFocusTrap({ active: isOpen, onEscape: handleClose });

  if (!isOpen) return null;

  return (
    <div ref={trapRef} className="presentation-export-modal" {...backdropClose(handleClose)}>
      <div className="presentation-export-content" onClick={(e) => e.stopPropagation()}>
        <div className="presentation-export-header">
          <h3>{t('presentation.title')}</h3>
          <button className="close-btn" onClick={handleClose} disabled={isExporting}>
            <X size={20} />
          </button>
        </div>

        <div className="presentation-export-body">
          {/* Info about reveal.js */}
          <div style={{ fontSize: '0.875rem', color: 'var(--text-tertiary)', marginBottom: '1rem', padding: '0.75rem', backgroundColor: 'var(--bg-panel-hover)', borderRadius: '4px' }}>
            <Lightbulb size={14} /> {t('presentation.info')}
            <br /><br />
            <strong>{t('presentation.controls')}</strong>
            <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
              <li>{t('presentation.controlArrows')}</li>
              <li><code style={{ color: 'var(--color-success)' }}>S</code> : {t('presentation.controlS').replace('S key: ', '')}</li>
              <li><code style={{ color: 'var(--color-success)' }}>F</code> : {t('presentation.controlF').replace('F key: ', '')}</li>
              <li><code style={{ color: 'var(--color-success)' }}>ESC</code> : {t('presentation.controlESC').replace('ESC key: ', '')}</li>
            </ul>
          </div>

          {/* Export mode selector */}
          <div className="form-field">
            <label>{t('presentation.exportMode')}</label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {(['online', 'offline', 'pdf'] as ExportMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    setExportMode(mode);
                    // Adjust output extension
                    setOutputPath((p) => {
                      const base = p.replace(/\.(html|pdf)$/, '');
                      return mode === 'pdf' ? `${base}.pdf` : `${base}.html`;
                    });
                  }}
                  disabled={isExporting}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: `1px solid ${exportMode === mode ? 'var(--color-accent)' : 'var(--border-color)'}`,
                    background: exportMode === mode ? 'var(--color-accent)' : 'transparent',
                    color: exportMode === mode ? 'var(--text-primary)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                >
                  {mode === 'offline' && <WifiOff size={13} />}
                  {mode === 'pdf' && <FileType size={13} />}
                  {t(`presentation.mode.${mode}`)}
                </button>
              ))}
            </div>
            <small style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginTop: '4px' }}>
              {t(`presentation.modeDesc.${exportMode}`)}
            </small>
            <small style={{ display: 'block', color: 'var(--text-tertiary)', fontSize: '11px', marginTop: '4px' }}>
              {t('presentation.frontmatterPrecedence')}
            </small>
          </div>

          {/* Form Fields */}
          <div className="form-field">
            <label>{t('presentation.presentationTitle')}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('presentation.titlePlaceholder')}
              disabled={isExporting}
            />
          </div>

          <div className="form-field">
            <label>{t('presentation.author')}</label>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={t('presentation.authorPlaceholder')}
              disabled={isExporting}
            />
          </div>

          <div className="form-field">
            <label>{t('presentation.outputFile')}</label>
            <div className="path-selector">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder={t('presentation.outputPlaceholder')}
                disabled={isExporting}
              />
              <button onClick={handleSelectOutputPath} disabled={isExporting}>
                {t('actions.browse')}
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
              <span>{t('presentation.exportSuccess')} {outputPath}</span>
            </div>
          )}
        </div>

        <div className="presentation-export-footer">
          <button className="btn-cancel" onClick={handleClose} disabled={isExporting}>
            {t('actions.cancel')}
          </button>
          <button
            className="btn-export"
            onClick={handleExport}
            disabled={isExporting || !title}
          >
            <FileDown size={16} />
            {isExporting ? t('presentation.exporting') : t('presentation.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
