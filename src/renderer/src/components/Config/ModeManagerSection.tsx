import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  Upload,
  Trash2,
  Copy,
  MessageSquare,
  BookOpen,
  FileSearch,
  Eye,
  PenTool,
  Compass,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useModeStore } from '../../stores/modeStore';
import { useDialogStore } from '../../stores/dialogStore';
import { translateMessage } from '../../utils/translate-message';
import type { ResolvedMode } from '../../../../../backend/types/mode';
import './ModeManagerSection.css';

const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare,
  BookOpen,
  FileSearch,
  Eye,
  PenTool,
  Compass,
  Sparkles,
};

export const ModeManagerSection: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const { modes, isLoadingModes, loadModes, saveCustomMode, deleteCustomMode, importMode, exportMode } =
    useModeStore();
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    loadModes();
  }, [loadModes]);

  const getIcon = (iconName: string, size = 14) => {
    const IconComponent = ICON_MAP[iconName];
    if (IconComponent) return <IconComponent size={size} />;
    return <MessageSquare size={size} />;
  };

  const getSourceLabel = (source: string): string => {
    const labels: Record<string, Record<string, string>> = {
      builtin: { fr: 'Intégré', en: 'Built-in', de: 'Integriert' },
      global: { fr: 'Global', en: 'Global', de: 'Global' },
      project: { fr: 'Projet', en: 'Project', de: 'Projekt' },
    };
    return labels[source]?.[lang] || source;
  };

  const builtinModes = modes.filter((m) => m.source === 'builtin');
  const globalModes = modes.filter((m) => m.source === 'global');
  const projectModes = modes.filter((m) => m.source === 'project');

  /**
   * Un refus du main se dit, avec sa raison (S06-1-14) : un mode refusé à l'import fermait le
   * dialogue sans un mot, et la liste restait la même.
   */
  const alertFailure = (title: string, error: unknown) =>
    useDialogStore
      .getState()
      .showAlert(translateMessage(t, error instanceof Error ? error : { message: String(error) }), title);

  const handleDelete = async (mode: ResolvedMode) => {
    if (deleteConfirm === mode.metadata.id) {
      setDeleteConfirm(null);
      try {
        await deleteCustomMode(mode.metadata.id, mode.source as 'global' | 'project');
      } catch (error) {
        await alertFailure(t('modes.manager.deleteFailed'), error);
      }
    } else {
      setDeleteConfirm(mode.metadata.id);
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  };

  const handleImport = async (target: 'global' | 'project') => {
    try {
      await importMode(target);
    } catch (error) {
      await alertFailure(t('modes.manager.importFailed'), error);
    }
  };

  const handleExport = async (modeId: string) => {
    try {
      await exportMode(modeId);
    } catch (error) {
      await alertFailure(t('modes.manager.exportFailed'), error);
    }
  };

  const handleDuplicate = async (mode: ResolvedMode) => {
    try {
      const duplicated = {
        ...JSON.parse(JSON.stringify(mode)),
        metadata: {
          ...mode.metadata,
          id: `${mode.metadata.id}-copy-${Date.now().toString(36)}`,
          name: {
            fr: `${mode.metadata.name.fr} (copie)`,
            en: `${mode.metadata.name.en} (copy)`,
          },
        },
      };
      delete duplicated.source;
      delete duplicated.filePath;
      await saveCustomMode(duplicated, 'global');
    } catch (error) {
      console.error('Failed to duplicate mode:', error);
      await alertFailure(t('modes.manager.duplicateFailed'), error);
    }
  };

  const renderModeRow = (mode: ResolvedMode, canModify: boolean) => (
    <div key={mode.metadata.id} className="mode-manager-row">
      <span className="mode-manager-icon">{getIcon(mode.metadata.icon, 16)}</span>
      <div className="mode-manager-info">
        <span className="mode-manager-name">{mode.metadata.name[lang]}</span>
        <span className="mode-manager-desc">{mode.metadata.description[lang]}</span>
      </div>
      <span className={`mode-manager-source mode-manager-source-${mode.source}`}>
        {getSourceLabel(mode.source)}
      </span>
      <div className="mode-manager-actions">
        <button
          className="mode-manager-btn"
          onClick={() => handleDuplicate(mode)}
          title={t('modes.manager.duplicate', 'Dupliquer')}
        >
          <Copy size={13} />
        </button>
        <button
          className="mode-manager-btn"
          onClick={() => handleExport(mode.metadata.id)}
          title={t('modes.manager.export', 'Exporter')}
        >
          <Download size={13} />
        </button>
        {canModify && (
          <button
            className={`mode-manager-btn mode-manager-btn-danger ${deleteConfirm === mode.metadata.id ? 'confirming' : ''}`}
            onClick={() => handleDelete(mode)}
            title={
              deleteConfirm === mode.metadata.id
                ? t('modes.manager.confirmDelete', 'Cliquer pour confirmer')
                : t('modes.manager.delete', 'Supprimer')
            }
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <CollapsibleSection
      title={t('modes.manager.title', 'Modes')}
      defaultExpanded={false}
    >
      <div className="mode-manager-section">
        {isLoadingModes ? (
          <div className="mode-manager-loading">{t('modes.manager.loading', 'Chargement...')}</div>
        ) : (
          <>
            {/* Built-in modes */}
            <div className="mode-manager-group">
              <h4 className="mode-manager-group-title">
                {t('modes.source.builtin', 'Intégrés')} ({builtinModes.length})
              </h4>
              {builtinModes.map((m) => renderModeRow(m, false))}
            </div>

            {/* Global modes */}
            <div className="mode-manager-group">
              <div className="mode-manager-group-header">
                <h4 className="mode-manager-group-title">
                  {t('modes.source.global', 'Globaux')} ({globalModes.length})
                </h4>
                <button
                  className="mode-manager-btn mode-manager-btn-import"
                  onClick={() => handleImport('global')}
                  title={t('modes.manager.import', 'Importer')}
                >
                  <Upload size={13} />
                  <span>{t('actions.import')}</span>
                </button>
              </div>
              {globalModes.length === 0 ? (
                <div className="mode-manager-empty">
                  {t('modes.manager.noCustom', 'Aucun mode personnalisé')}
                </div>
              ) : (
                globalModes.map((m) => renderModeRow(m, true))
              )}
            </div>

            {/* Project modes */}
            <div className="mode-manager-group">
              <div className="mode-manager-group-header">
                <h4 className="mode-manager-group-title">
                  {t('modes.source.project', 'Projet')} ({projectModes.length})
                </h4>
                <button
                  className="mode-manager-btn mode-manager-btn-import"
                  onClick={() => handleImport('project')}
                  title={t('modes.manager.import', 'Importer')}
                >
                  <Upload size={13} />
                  <span>{t('actions.import')}</span>
                </button>
              </div>
              {projectModes.length === 0 ? (
                <div className="mode-manager-empty">
                  {t('modes.manager.noCustom', 'Aucun mode personnalisé')}
                </div>
              ) : (
                projectModes.map((m) => renderModeRow(m, true))
              )}
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
};
