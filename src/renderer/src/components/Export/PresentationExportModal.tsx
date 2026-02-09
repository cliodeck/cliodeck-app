import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, X, AlertCircle, CheckCircle } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import './PresentationExportModal.css';

interface PresentationExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PresentationExportModal: React.FC<PresentationExportModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const { currentProject } = useProjectStore();
  const { content } = useEditorStore();

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState({ stage: '', message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

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
      const result = await window.electron.dialog.saveFile({
        defaultPath: outputPath,
        filters: [
          { name: 'HTML', extensions: ['html'] },
          { name: t('presentation.allFiles'), extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePath) {
        setOutputPath(result.filePath);
      }
    } catch (err: any) {
      console.error('Failed to select output path:', err);
    }
  };

  const handleExport = async () => {
    if (!currentProject) {
      setError(t('presentation.noProjectOpen'));
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
      // Load reveal.js config if it exists
      let config = {};
      try {
        const configPath = `${currentProject.path}/reveal-config.json`;
        const configExists = await window.electron.fs.exists(configPath);
        if (configExists) {
          const configContent = await window.electron.fs.readFile(configPath);
          config = JSON.parse(configContent);
        }
      } catch (err) {
        console.warn('No reveal.js config found, using defaults');
      }

      const result = await window.electron.revealJsExport.export({
        projectPath: currentProject.path,
        content: content,
        outputPath: outputPath,
        metadata: {
          title,
          author: author || 'ClioDesk',
          date: new Date().toLocaleDateString(),
        },
        config,
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
        setError(result.error || t('presentation.unknownError'));
        setIsExporting(false);
      }
    } catch (err: any) {
      setError(t('presentation.exportError') + ': ' + err.message);
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
    <div className="presentation-export-modal" onClick={handleClose}>
      <div className="presentation-export-content" onClick={(e) => e.stopPropagation()}>
        <div className="presentation-export-header">
          <h3>{t('presentation.title')}</h3>
          <button className="close-btn" onClick={handleClose} disabled={isExporting}>
            <X size={20} />
          </button>
        </div>

        <div className="presentation-export-body">
          {/* Info about reveal.js */}
          <div style={{ fontSize: '0.875rem', color: '#888', marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '4px' }}>
            💡 {t('presentation.info')}
            <br /><br />
            <strong>{t('presentation.controls')}</strong>
            <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
              <li>{t('presentation.controlArrows')}</li>
              <li><code style={{ color: '#4ec9b0' }}>S</code> : {t('presentation.controlS').replace('S key: ', '')}</li>
              <li><code style={{ color: '#4ec9b0' }}>F</code> : {t('presentation.controlF').replace('F key: ', '')}</li>
              <li><code style={{ color: '#4ec9b0' }}>ESC</code> : {t('presentation.controlESC').replace('ESC key: ', '')}</li>
            </ul>
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
