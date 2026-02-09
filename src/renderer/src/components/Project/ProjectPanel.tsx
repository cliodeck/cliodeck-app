import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus, FolderOpen, X, FileDown, FileType, ExternalLink, FileText, FileSignature, Target, Presentation } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { PDFExportModal } from '../Export/PDFExportModal';
import { WordExportModal } from '../Export/WordExportModal';
import { BeamerConfig } from './BeamerConfig';
import { CSLSettings } from './CSLSettings';
import { ActionsSection } from '../Config/ActionsSection';
import { ZoteroProjectSettings } from './ZoteroProjectSettings';
import './ProjectPanel.css';

export const ProjectPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    currentProject,
    recentProjects,
    isLoading,
    loadProject,
    createProject,
    closeProject,
    loadRecentProjects,
  } = useProjectStore();

  const { loadFile } = useEditorStore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPDFExportModal, setShowPDFExportModal] = useState(false);
  const [showWordExportModal, setShowWordExportModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectType, setNewProjectType] = useState<'article' | 'book' | 'presentation'>('article');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadRecentProjects();
  }, [loadRecentProjects]);

  const handleCreateProject = async () => {
    if (!newProjectName || !newProjectPath) {
      alert(t('project.fillAllFields'));
      return;
    }

    const projectName = newProjectName;

    setIsCreating(true);
    try {
      await createProject(projectName, newProjectType, newProjectPath);
      setShowCreateModal(false);
      setNewProjectName('');
      setNewProjectPath('');
      setNewProjectType('article');
    } catch (error: any) {
      console.error('Failed to create project:', error);
      alert(t('project.createError') + ': ' + error.message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenProject = async () => {
    try {
      const result = await window.electron.dialog.openFile({
        properties: ['openFile'],
        filters: [
          { name: t('project.dialogTitle'), extensions: ['json'] },
          { name: t('project.allFiles'), extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        await loadProject(result.filePaths[0]);
      }
    } catch (error: any) {
      console.error('Failed to open project:', error);
      alert(t('project.openError') + ': ' + error.message);
    }
  };

  const handleSelectPath = async () => {
    try {
      const result = await window.electron.dialog.openFile({
        properties: ['openDirectory', 'createDirectory'],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        setNewProjectPath(result.filePaths[0]);
      }
    } catch (error: any) {
      console.error('Failed to select path:', error);
    }
  };

  const handleLoadRecentProject = async (project: any) => {
    try {
      const projectPath = `${project.path}/project.json`;
      await loadProject(projectPath);
    } catch (error: any) {
      console.error('Failed to load recent project:', error);
      alert(t('project.openError') + ': ' + error.message);
    }
  };

  const handleRemoveRecentProject = async (project: any) => {
    try {
      const projectPath = `${project.path}/project.json`;
      await window.electron.project.removeRecent(projectPath);
      await loadRecentProjects();
    } catch (error: any) {
      console.error('Failed to remove recent project:', error);
    }
  };

  const getProjectTypeName = (type: string) => {
    switch (type) {
      case 'article':
        return t('project.types.article');
      case 'book':
        return t('project.types.book');
      case 'presentation':
        return t('project.types.presentation');
      default:
        return type;
    }
  };

  const handleFileSelect = async (filePath: string) => {
    try {
      await loadFile(filePath);
    } catch (error: any) {
      console.error('Failed to load file:', error);
      alert(t('toolbar.openError') + ': ' + error.message);
    }
  };

  const handleOpenProjectInFinder = async () => {
    if (currentProject?.path) {
      try {
        await window.electron.shell.openPath(currentProject.path);
      } catch (error: any) {
        console.error('Failed to open project folder:', error);
        alert(t('project.openFolderError') + ': ' + error.message);
      }
    }
  };

  return (
    <div className="project-panel" style={{ position: 'relative' }}>
      {isLoading && (
        <div className="project-loading-overlay">
          <div className="project-loading-spinner" />
          <div className="project-loading-text">{t('project.loading')}</div>
        </div>
      )}
      <div className="project-content">
        {/* Action Buttons */}
        <div className="project-actions">
          <div className="project-actions-left">
            <button className="toolbar-btn" onClick={() => setShowCreateModal(true)} title={t("project.newProject")}>
              <FilePlus size={20} strokeWidth={1} />
            </button>
            <button className="toolbar-btn" onClick={handleOpenProject} title={t("project.openProject")}>
              <FolderOpen size={20} strokeWidth={1} />
            </button>
          </div>
          <div className="project-actions-right">
            <button
              className="toolbar-btn"
              onClick={() => setShowPDFExportModal(true)}
              title={t("export.exportToPDF")}
              disabled={!currentProject}
            >
              <FileDown size={20} strokeWidth={1} />
            </button>
            <button
              className="toolbar-btn"
              onClick={() => setShowWordExportModal(true)}
              title={t("export.exportToWord")}
              disabled={!currentProject}
            >
              <FileType size={20} strokeWidth={1} />
            </button>
          </div>
        </div>

        {/* Current Project Info */}
        {currentProject ? (
          <div className="current-project-info">
            <CollapsibleSection title={t('project.currentProject')} defaultExpanded={true}>
              <div className="project-meta">
                <div className="project-meta-row">
                  <span className="project-meta-label">{t('project.name')}:</span>
                  <span>{currentProject.name}</span>
                </div>
                <div className="project-meta-row">
                  <span className="project-meta-label">{t('project.type')}:</span>
                  <span className="project-type-badge">
                    {getProjectTypeName(currentProject.type)}
                  </span>
                </div>
                <div className="project-meta-row">
                  <span className="project-meta-label">{t('project.path')}:</span>
                  <span title={currentProject.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {currentProject.path}
                  </span>
                </div>
                <div className="project-meta-row">
                  <span className="project-meta-label">{t('project.createdAt')}:</span>
                  <span>{new Date(currentProject.createdAt).toLocaleDateString('fr-FR')}</span>
                </div>
              </div>
              <button
                className="project-btn"
                onClick={handleOpenProjectInFinder}
                style={{ marginTop: '1rem', width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center' }}
              >
                <ExternalLink size={16} />
                {t('project.openInFinder')}
              </button>
            </CollapsibleSection>

            {/* File list for Article and Book projects */}
            {(currentProject.type === 'article' || currentProject.type === 'book') && (
              <CollapsibleSection title={t('project.projectFiles')} defaultExpanded={true}>
                <div className="project-files-list">
                  <div
                    className="project-file-item"
                    onClick={() => handleFileSelect(`${currentProject.path}/document.md`)}
                  >
                    <FileText size={16} strokeWidth={1.5} /> document.md
                  </div>
                  <div
                    className="project-file-item"
                    onClick={() => handleFileSelect(`${currentProject.path}/abstract.md`)}
                  >
                    <FileSignature size={16} strokeWidth={1.5} /> abstract.md
                  </div>
                  <div
                    className="project-file-item"
                    onClick={() => handleFileSelect(`${currentProject.path}/context.md`)}
                  >
                    <Target size={16} strokeWidth={1.5} /> context.md
                  </div>
                </div>
              </CollapsibleSection>
            )}

            {/* File list for Presentation projects */}
            {currentProject.type === 'presentation' && (
              <>
                <CollapsibleSection title={t('project.projectFiles')} defaultExpanded={true}>
                  <div className="project-files-list">
                    <div
                      className="project-file-item"
                      onClick={() => handleFileSelect(`${currentProject.path}/slides.md`)}
                    >
                      <Presentation size={16} strokeWidth={1.5} /> slides.md
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title={t('project.appearance')} defaultExpanded={true}>
                  <BeamerConfig projectPath={currentProject.path} />
                </CollapsibleSection>
              </>
            )}

            {/* Project Settings - CSL */}
            {(currentProject.type === 'article' || currentProject.type === 'book' || currentProject.type === 'presentation') && (
              <CollapsibleSection title={t('project.settings')} defaultExpanded={false}>
                <CSLSettings
                  projectPath={currentProject.path}
                  currentCSL={currentProject.cslPath}
                  onCSLChange={() => {
                    // Reload project to get updated CSL path
                    const projectJsonPath = `${currentProject.path}/project.json`;
                    loadProject(projectJsonPath);
                  }}
                />
              </CollapsibleSection>
            )}

            {/* Zotero Project Settings */}
            <ZoteroProjectSettings projectPath={currentProject.path} />

            {/* Database Actions - project-specific */}
            <ActionsSection />

            <button
              className="project-btn"
              onClick={closeProject}
              style={{ marginTop: '1rem', width: '100%' }}
            >
              {t('project.closeProject')}
            </button>
          </div>
        ) : (
          <div className="empty-state">
            <p>{t('project.noProjectOpen')}</p>
            <p>{t('project.createOrOpen')}</p>
          </div>
        )}

        {/* Recent Projects */}
        {recentProjects.length > 0 && (
          <CollapsibleSection title={t('project.recentProjects')} defaultExpanded={false}>
            <div className="recent-projects-list">
              {recentProjects.map((project) => (
                <div
                  key={project.id}
                  className="recent-project-item"
                >
                  <div
                    className="recent-project-content"
                    onClick={() => handleLoadRecentProject(project)}
                  >
                    <div className="recent-project-name">
                      {project.name} <span className="project-type-badge">{getProjectTypeName(project.type)}</span>
                    </div>
                    <div className="recent-project-path">{project.path}</div>
                  </div>
                  <button
                    className="recent-project-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveRecentProject(project);
                    }}
                    title={t('project.removeFromRecent')}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}
      </div>

      {/* Create Project Modal */}
      {showCreateModal && (
        <div className="create-project-modal" onClick={() => setShowCreateModal(false)}>
          <div className="create-project-content" onClick={(e) => e.stopPropagation()}>
            <h3>{t('project.createNewProject')}</h3>

            {/* Project type selector hidden for v1.0 - only article type available */}
            {/* Book and Presentation types need more testing before release */}
            {/*
            <div className="form-field">
              <label>{t('project.projectType')}</label>
              <select
                value={newProjectType}
                onChange={(e) => setNewProjectType(e.target.value as any)}
              >
                <option value="article">{t('project.types.article')}</option>
                <option value="book">{t('project.types.book')}</option>
                <option value="presentation">{t('project.types.presentation')}</option>
              </select>
            </div>
            */}

            <div className="form-field">
              <label>{t('project.projectName')}</label>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Mon article"
                autoFocus
              />
            </div>

            <div className="form-field">
              <label>{t('project.projectLocation')}</label>
              <div className="path-selector">
                <input
                  type="text"
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                  placeholder="/chemin/vers/dossier"
                  readOnly
                />
                <button onClick={handleSelectPath}>{t('actions.browse')}</button>
              </div>
            </div>

            <div className="form-actions">
              <button
                className="btn-cancel"
                onClick={() => setShowCreateModal(false)}
                disabled={isCreating}
              >
                {t('actions.cancel')}
              </button>
              <button
                className="btn-submit"
                onClick={handleCreateProject}
                disabled={isCreating || !newProjectName || !newProjectPath}
              >
                {isCreating ? t('project.creating') : t('actions.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Export Modal (for all project types including presentations) */}
      <PDFExportModal
        isOpen={showPDFExportModal}
        onClose={() => setShowPDFExportModal(false)}
      />

      {/* Word Export Modal */}
      <WordExportModal
        isOpen={showWordExportModal}
        onClose={() => setShowWordExportModal(false)}
      />
    </div>
  );
};
