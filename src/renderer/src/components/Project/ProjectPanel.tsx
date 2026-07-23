import React, { Suspense, lazy, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus, FolderOpen, X, FileDown, FileType, ExternalLink, FileText, FileSignature, Target, Presentation, Bug } from 'lucide-react';
import { useProjectStore, type Project } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { useDialogStore } from '../../stores/dialogStore';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { RevealJsConfig } from './RevealJsConfig';
import { CSLSettings } from './CSLSettings';
import { ActionsSection } from '../Config/ActionsSection';
import { ZoteroProjectSettings } from './ZoteroProjectSettings';
import { OnboardingWizard } from './OnboardingWizard';
import './ProjectPanel.css';

// Modals are only rendered when opened — keep them off the main chunk.
const PDFExportModal = lazy(() =>
  import('../Export/PDFExportModal').then((m) => ({ default: m.PDFExportModal })),
);
const WordExportModal = lazy(() =>
  import('../Export/WordExportModal').then((m) => ({ default: m.WordExportModal })),
);
const ReportIssueModal = lazy(() =>
  import('../Report/ReportIssueModal').then((m) => ({ default: m.ReportIssueModal })),
);

export const ProjectPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    currentProject,
    recentProjects,
    loadState,
    loadProject,
    createProject,
    closeProject,
    loadRecentProjects,
    chapters,
  } = useProjectStore();
  const isLoading = loadState.kind === 'loading';

  const { loadFile } = useEditorStore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPDFExportModal, setShowPDFExportModal] = useState(false);
  const [showWordExportModal, setShowWordExportModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingProjectName, setOnboardingProjectName] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectType, setNewProjectType] = useState<'article' | 'book' | 'presentation'>('article');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadRecentProjects();
  }, [loadRecentProjects]);

  const handleCreateProject = async () => {
    if (!newProjectName || !newProjectPath) {
      await useDialogStore.getState().showAlert(t('project.fillAllFields'));
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
      // Launch conversational onboarding
      setOnboardingProjectName(projectName);
      setShowOnboarding(true);
    } catch (error: unknown) {
      console.error('Failed to create project:', error);
      await useDialogStore.getState().showAlert(t('project.createError'));
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
    } catch (error: unknown) {
      console.error('Failed to open project:', error);
      await useDialogStore.getState().showAlert(t('project.openError'));
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
    } catch (error: unknown) {
      console.error('Failed to select path:', error);
    }
  };

  const handleLoadRecentProject = async (project: Project) => {
    try {
      const projectPath = `${project.path}/project.json`;
      await loadProject(projectPath);
    } catch (error: unknown) {
      console.error('Failed to load recent project:', error);
      await useDialogStore.getState().showAlert(t('project.openError'));
    }
  };

  const handleRemoveRecentProject = async (project: Project) => {
    try {
      const projectPath = `${project.path}/project.json`;
      await window.electron.project.removeRecent(projectPath);
      await loadRecentProjects();
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      console.error('Failed to load file:', error);
      await useDialogStore.getState().showAlert(t('toolbar.openError'));
    }
  };

  const handleOpenProjectInFinder = async () => {
    if (currentProject?.path) {
      try {
        await window.electron.shell.openPath(currentProject.path);
      } catch (error: unknown) {
        console.error('Failed to open project folder:', error);
        await useDialogStore.getState().showAlert(t('project.openFolderError') + ': ' + (error instanceof Error ? error.message : String(error)));
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
            <button
              className="toolbar-btn"
              onClick={() => setShowReportModal(true)}
              title={t("project.reportIssue")}
            >
              <Bug size={20} strokeWidth={1} />
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
                  {/* Les chapitres d'un livre ne sont PAS répétés ici : le
                      navigateur de chapitres en fait autorité (il seul permet
                      de créer, réordonner et rattacher). Deux listes des mêmes
                      fichiers, avec des capacités différentes, laissaient
                      l'utilisateur sans savoir laquelle fait foi — audit du
                      2026-07-19. Ne restent que les pièces communes. */}
                  {currentProject.type === 'book' ? (
                    <p className="project-files-hint">
                      {t('project.chaptersInNavigator', { count: chapters.length })}
                    </p>
                  ) : (
                    <div
                      className="project-file-item"
                      onClick={() => handleFileSelect(`${currentProject.path}/document.md`)}
                    >
                      <FileText size={16} strokeWidth={1.5} /> document.md
                    </div>
                  )}
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
                  <RevealJsConfig projectPath={currentProject.path} />
                </CollapsibleSection>
              </>
            )}

            {/* Project Settings - CSL + Default Editor */}
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

            {/* L'entretien de démarrage n'était joué qu'une fois, juste après
                la création du projet : un utilisateur qui l'avait passé ne
                pouvait plus y revenir (audit du 2026-07-19). Il écrit le
                fichier de contexte du projet, il exige donc un projet ouvert. */}
            <button
              className="project-btn"
              onClick={() => {
                setOnboardingProjectName(currentProject.name);
                setShowOnboarding(true);
              }}
              style={{ marginTop: '1rem', width: '100%' }}
            >
              {t('project.reopenOnboarding')}
            </button>

            <button
              className="project-btn"
              onClick={closeProject}
              style={{ marginTop: '0.5rem', width: '100%' }}
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

            <div className="form-field">
              <label>{t('project.projectType')}</label>
              <select
                value={newProjectType}
                onChange={(e) => setNewProjectType(e.target.value as 'article' | 'book' | 'presentation')}
              >
                <option value="article">{t('project.types.article')}</option>
                <option value="book">{t('project.types.book')}</option>
                <option value="presentation">{t('project.types.presentation')}</option>
              </select>
            </div>

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
      {showPDFExportModal && (
        <Suspense fallback={null}>
          <PDFExportModal
            isOpen={showPDFExportModal}
            onClose={() => setShowPDFExportModal(false)}
          />
        </Suspense>
      )}

      {/* Word Export Modal */}
      {showWordExportModal && (
        <Suspense fallback={null}>
          <WordExportModal
            isOpen={showWordExportModal}
            onClose={() => setShowWordExportModal(false)}
          />
        </Suspense>
      )}

      {/* Report Issue Modal */}
      {showReportModal && (
        <Suspense fallback={null}>
          <ReportIssueModal
            isOpen={showReportModal}
            onClose={() => setShowReportModal(false)}
          />
        </Suspense>
      )}

      {/* Onboarding Wizard — appears after project creation */}
      {showOnboarding && (
        <OnboardingWizard
          projectName={onboardingProjectName}
          onComplete={async (hints) => {
            try {
              await window.electron.fusion.hints.write(hints);
            } catch (err: unknown) {
              console.error('Failed to write onboarding hints:', err);
            }
            setShowOnboarding(false);
          }}
          onSkip={() => setShowOnboarding(false)}
        />
      )}
    </div>
  );
};
