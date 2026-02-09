import React, { useState, useEffect } from 'react';
import { FileDown, X, AlertCircle, CheckCircle } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import './PDFExportModal.css';

interface PDFExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PDFExportModal: React.FC<PDFExportModalProps> = ({ isOpen, onClose }) => {
  const { currentProject } = useProjectStore();
  const { content } = useEditorStore();

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
        setError(
          `Dépendances manquantes:\n${!result.pandoc ? '- Pandoc (installez avec: brew install pandoc)\n' : ''}${!result.xelatex ? '- XeLaTeX (installez avec: brew install --cask mactex)' : ''}`
        );
      }
    } catch (err: any) {
      setError('Erreur lors de la vérification des dépendances: ' + err.message);
    }
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.electron.dialog.saveFile({
        defaultPath: outputPath,
        filters: [
          { name: 'PDF', extensions: ['pdf'] },
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

    if (!hasPandoc || !hasXelatex) {
      setError('Dépendances manquantes. Veuillez les installer avant de continuer.');
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
        content: exportContent,
        outputPath: outputPath,
        bibliographyPath: currentProject.bibliography,
        cslPath: currentProject.cslPath,
        metadata: {
          title,
          author: author || 'ClioDesk',
          date: new Date().toLocaleDateString('fr-FR'),
        },
        beamerConfig,
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
          <h3>Export PDF</h3>
          <button className="close-btn" onClick={handleClose} disabled={isExporting}>
            <X size={20} />
          </button>
        </div>

        <div className="pdf-export-body">
          {/* Dependency Check */}
          {dependenciesChecked && (
            <div className="dependency-status">
              <div className={`dependency-item ${hasPandoc ? 'success' : 'error'}`}>
                {hasPandoc ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                <span>Pandoc {hasPandoc ? 'installé' : 'manquant'}</span>
              </div>
              <div className={`dependency-item ${hasXelatex ? 'success' : 'error'}`}>
                {hasXelatex ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                <span>XeLaTeX {hasXelatex ? 'installé' : 'manquant'}</span>
              </div>
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
            <div style={{ fontSize: '0.875rem', color: '#888', marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '4px' }}>
              💡 Le résumé sera automatiquement lu depuis le fichier <code style={{ color: '#4ec9b0' }}>abstract.md</code> de votre projet
            </div>
          )}

          {/* Info about presentations */}
          {currentProject?.type === 'presentation' && (
            <div style={{ fontSize: '0.875rem', color: '#888', marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '4px' }}>
              🎬 Présentation Beamer : Le contenu sera lu depuis <code style={{ color: '#4ec9b0' }}>slides.md</code>
              <br /><br />
              <strong>Syntaxe :</strong>
              <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                <li><code>#</code> Titre de slide (niveau 1)</li>
                <li><code>##</code> Sous-titre (niveau 2)</li>
                <li><code>::: notes</code> ... <code>:::</code> Notes de présentateur</li>
              </ul>
            </div>
          )}

          <div className="form-field">
            <label>Fichier de sortie</label>
            <div className="path-selector">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="/chemin/vers/fichier.pdf"
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
              <span>Export réussi! PDF créé à: {outputPath}</span>
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
            disabled={isExporting || !hasPandoc || !hasXelatex || !title}
          >
            <FileDown size={16} />
            {isExporting ? 'Export en cours...' : 'Exporter'}
          </button>
        </div>
      </div>
    </div>
  );
};
