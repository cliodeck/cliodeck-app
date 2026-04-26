import React, { useState, useEffect } from 'react';
import { FileDown, X, AlertCircle, CheckCircle } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
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
  const { currentProject } = useProjectStore();
  const { content } = useEditorStore();

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
          { name: 'Word Document', extensions: ['docx'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
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
      setError('Aucun projet ouvert');
      return;
    }

    if (!title) {
      setError('Veuillez entrer un titre');
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
          setError('Impossible de lire slides.md. Assurez-vous que le fichier existe.');
          setIsExporting(false);
          return;
        }
      }

      const result = await window.electron.wordExport.export({
        projectPath: currentProject.path,
        projectType: currentProject.type,
        content: exportContent,
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
        setError(result.error || 'Erreur inconnue lors de l\'export');
        setIsExporting(false);
      }
    } catch (err: any) {
      setError('Erreur lors de l\'export: ' + err.message);
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
      <div className="pdf-export-content" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-export-header">
          <h3>Export Word (.docx)</h3>
          <button className="close-btn" onClick={handleClose} disabled={isExporting}>
            <X size={20} />
          </button>
        </div>

        <div className="pdf-export-body">
          {/* Template Detection */}
          {hasTemplate && templatePath && (
            <div style={{ fontSize: '0.875rem', color: 'var(--color-success)', marginBottom: '1rem', padding: '0.75rem', backgroundColor: 'var(--bg-panel-hover)', borderRadius: '4px' }}>
              <CheckCircle size={16} style={{ display: 'inline', marginRight: '0.5rem' }} />
              Modèle Word détecté: <code style={{ color: 'var(--color-success)' }}>{templatePath.split('/').pop()}</code>
            </div>
          )}

          {/* Form Fields */}
          <div className="form-field">
            <label>Titre du document</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Mon document"
              disabled={isExporting}
            />
          </div>

          <div className="form-field">
            <label>Auteur (optionnel)</label>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Votre nom"
              disabled={isExporting}
            />
          </div>

          {/* Info about abstract for articles and books */}
          {(currentProject?.type === 'article' || currentProject?.type === 'book') && (
            <div style={{ fontSize: '0.875rem', color: 'var(--text-tertiary)', marginBottom: '1rem', padding: '0.75rem', backgroundColor: 'var(--bg-panel-hover)', borderRadius: '4px' }}>
              💡 Le résumé sera automatiquement lu depuis le fichier <code style={{ color: 'var(--color-success)' }}>abstract.md</code> de votre projet
            </div>
          )}

          <ExportCitationSection
            value={citation}
            onChange={setCitation}
            disabled={isExporting}
          />

          <div className="form-field">
            <label>Fichier de sortie</label>
            <div className="path-selector">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="/chemin/vers/fichier.docx"
                disabled={isExporting}
              />
              <button onClick={handleSelectOutputPath} disabled={isExporting}>
                Parcourir
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
              <span>Export réussi! Document Word créé à: {outputPath}</span>
            </div>
          )}
        </div>

        <div className="pdf-export-footer">
          <button className="btn-cancel" onClick={handleClose} disabled={isExporting}>
            Annuler
          </button>
          <button
            className="btn-export"
            onClick={handleExport}
            disabled={isExporting || !title}
          >
            <FileDown size={16} />
            {isExporting ? 'Export en cours...' : 'Exporter'}
          </button>
        </div>
      </div>
    </div>
  );
};
