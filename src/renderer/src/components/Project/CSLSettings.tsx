import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, X } from 'lucide-react';
import './CSLSettings.css';

interface CSLSettingsProps {
  projectPath: string;
  currentCSL?: string;
  onCSLChange?: () => void;
}

export const CSLSettings: React.FC<CSLSettingsProps> = ({
  projectPath,
  currentCSL,
  onCSLChange
}) => {
  const { t } = useTranslation('common');
  const [cslPath, setCSLPath] = useState<string | undefined>(currentCSL);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setCSLPath(currentCSL);
  }, [currentCSL]);

  const handleSelectCSL = async () => {
    try {
      const result = await window.electron.dialog.openFile({
        properties: ['openFile'],
        filters: [
          { name: 'CSL Files', extensions: ['csl'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        await saveCSLPath(selectedPath);
      }
    } catch (error) {
      console.error('Failed to select CSL file:', error);
      alert(t('project.cslSelectError') || 'Error selecting CSL file');
    }
  };

  const saveCSLPath = async (path: string) => {
    setIsSaving(true);
    try {
      const projectJsonPath = `${projectPath}/project.json`;

      // Save the CSL path to project.json (will copy file if external)
      const result = await window.electron.project.setCSLPath({
        projectPath: projectJsonPath,
        cslPath: path,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to save CSL path');
      }

      // Use the final path (may be copied to project)
      const finalPath = result.cslPath || path;
      setCSLPath(finalPath);
      onCSLChange?.();

      console.log('✅ CSL path saved:', finalPath);
    } catch (error: any) {
      console.error('Failed to save CSL path:', error);
      alert(t('project.cslSaveError') || 'Error saving CSL path');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveCSL = async () => {
    setIsSaving(true);
    try {
      const projectJsonPath = `${projectPath}/project.json`;

      await window.electron.project.setCSLPath({
        projectPath: projectJsonPath,
        cslPath: undefined,
      });

      setCSLPath(undefined);
      onCSLChange?.();

      console.log('✅ CSL path removed');
    } catch (error) {
      console.error('Failed to remove CSL path:', error);
      alert(t('project.cslRemoveError') || 'Error removing CSL path');
    } finally {
      setIsSaving(false);
    }
  };

  const getCSLFileName = (path: string) => {
    return path.split('/').pop() || path;
  };

  return (
    <div className="csl-settings">
      <div className="csl-settings-header">
        <label className="csl-label">
          <FileText size={16} />
          {t('project.citationStyle')}
        </label>
      </div>

      {cslPath ? (
        <div className="csl-selected">
          <div className="csl-file-info">
            <span className="csl-file-icon">📄</span>
            <span className="csl-file-name">{getCSLFileName(cslPath)}</span>
          </div>
          <button
            className="csl-remove-btn"
            onClick={handleRemoveCSL}
            disabled={isSaving}
            title="Remove CSL"
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <div className="csl-empty">
          <p className="csl-empty-text">{t('project.noCslSelected')}</p>
        </div>
      )}

      <button
        className="csl-select-btn"
        onClick={handleSelectCSL}
        disabled={isSaving}
      >
        {cslPath ? t('project.selectCSL').replace('Sélectionner', 'Changer') : t('project.selectCSL')}
      </button>

      <small className="csl-help-text">{t('project.cslHelp')}</small>
    </div>
  );
};
