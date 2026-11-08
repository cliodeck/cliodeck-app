import React, { Suspense, lazy, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus, FolderOpen, X, FileDown, FileType, ExternalLink, FileText, FileSignature, Target, Presentation, Bug } from 'lucide-react';
import { NotAProjectError, ProjectOpenError, useProjectStore, type Project } from '../../stores/projectStore';
import { openErrorKey, useEditorStore } from '../../stores/editorStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useMenuIntentStore } from '../../stores/menuIntentStore';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { RevealJsConfig } from './RevealJsConfig';
import { CSLSettings } from './CSLSettings';
import { ActionsSection } from '../Config/ActionsSection';
import { ZoteroProjectSettings } from './ZoteroProjectSettings';
import { OnboardingWizard } from './OnboardingWizard';
import './ProjectPanel.css';
import { backdropClose } from '../../utils/backdropClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { createProjectErrorMessage } from './create-project-error';
import {
  appendToContext,
  contextFailureText,
  readContextFile,
  saveContextFile,
  unreadableFailure,
  type ContextFailure,
} from '../../services/context-file';

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

/**
 * Le message de chaque refus d'ouverture. « project.json est peut-être illisible ou endommagé » ne
 * vaut que pour un manifeste qui se lit mal : il couvrait tout, et l'auteur cherchait à réparer un
 * fichier intact quand un service n'avait pas démarré (BT1-5). Sans code connu, rien n'est supposé.
 */
const OPEN_FAILURE_KEYS: Readonly<Record<string, string>> = {
  manifest_unreadable: 'project.openError',
  manifest_unwritable: 'project.openNotWritable',
  project_unavailable: 'project.openUnavailable',
  project_file_missing: 'project.openUnavailable',
  services_failed: 'project.servicesFailed',
};

export const ProjectPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    currentProject,
    recentProjects,
    loadState,
    loadProject,
    createProject,
    closeProject,
    patchCurrentProject,
    loadRecentProjects,
    chapters,
  } = useProjectStore();
  const isLoading = loadState.kind === 'loading';

  const { loadFile } = useEditorStore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPDFExportModal, setShowPDFExportModal] = useState(false);
  const [showWordExportModal, setShowWordExportModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  /** Le projet pour lequel l'assistant a été ouvert : ses réponses ne valent que pour lui. */
  const [onboarding, setOnboarding] = useState<{ name: string; path: string } | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectType, setNewProjectType] = useState<'article' | 'book' | 'presentation'>('article');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Fermer ne perd rien tout de suite : le nom et le dossier restent ici, et la modale rouverte les
  // retrouve, tant que ce panneau reste monté (changer d'onglet à gauche les emporte, après Annuler
  // comme après Échap). Pendant la création, rien ne ferme, comme Annuler, désactivé.
  const closeCreateModal = isCreating ? undefined : () => setShowCreateModal(false);
  const createModalRef = useFocusTrap({ active: showCreateModal, onEscape: closeCreateModal });

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
      // Rien de créé, sans erreur : la modale reste, avec ce que l'auteur y a saisi.
      if (!(await createProject(projectName, newProjectType, newProjectPath))) return;
      setShowCreateModal(false);
      setNewProjectName('');
      setNewProjectPath('');
      setNewProjectType('article');
      // Launch conversational onboarding
      setOnboarding({ name: projectName, path: useProjectStore.getState().currentProject?.path ?? '' });
    } catch (error: unknown) {
      console.error('Failed to create project:', error);
      await useDialogStore
        .getState()
        .showAlert(createProjectErrorMessage(t, error, { name: projectName, folder: newProjectPath }));
    } finally {
      setIsCreating(false);
    }
  };

  /**
   * Ajoute les réponses de l'assistant à `context.md`, écrit à la main ou non (décision Q6).
   * Seul un fichier sans rien de l'auteur se remplace sans demander. Rend faux si rien n'a été
   * écrit : c'est fermer l'assistant qui abandonne les réponses. Rend vrai quand elles sont dans
   * le fichier : l'assistant passe à son écran de fin, et c'est l'auteur qui le ferme.
   *
   * Le nom du projet n'est posé en titre que dans un fichier sans rien de l'auteur : ajouté à la
   * suite de son texte, il devenait un second titre de premier niveau sous le sien (BT1-8).
   */
  const finishOnboarding = async (section: string, projectName: string, projectPath: string): Promise<boolean> => {
    const { showAlert, showConfirm } = useDialogStore.getState();
    const tellFailure = async (failure: ContextFailure): Promise<boolean> => {
      await showAlert(`${contextFailureText(t, failure)} ${t('onboarding.writeError')}`);
      return false;
    };

    const read = await readContextFile();
    if (!read.success) return tellFailure(read);
    const refused = unreadableFailure(read.hints);
    if (refused) return tellFailure(refused);

    const { raw, sourcePath, sources } = read.hints;
    const blank = sources.context.blank;
    const next = blank ? `# ${projectName}\n\n${section}` : appendToContext(raw, section);
    if (next !== raw) {
      if (!blank && !(await showConfirm(t('onboarding.appendConfirm'), t('onboarding.appendConfirmTitle')))) {
        return false;
      }
      const saved = await saveContextFile(next, { expectedRaw: raw, sourcePath, projectPath });
      if (!saved.success) return tellFailure(saved);
    }
    return true;
  };

  /** Le refus d'une ouverture, dans les mots de l'auteur : le fichier choisi nommé, jamais un code. */
  const openFailureMessage = (error: unknown): string => {
    if (error instanceof NotAProjectError) return t('project.notAProject', { file: error.fileName });
    const key = error instanceof ProjectOpenError && error.code ? OPEN_FAILURE_KEYS[error.code] : undefined;
    return t(key ?? openErrorKey(error, 'project.openFailed'));
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
      await useDialogStore.getState().showAlert(openFailureMessage(error));
    }
  };

  // Fichier › Nouveau projet et Ouvrir un projet : les boutons de ce panneau, même s'il vient
  // d'être monté par la commande.
  const menuIntent = useMenuIntentStore((state) => state.intent);
  useEffect(() => {
    const { consume } = useMenuIntentStore.getState();
    if (consume('new-project')) setShowCreateModal(true);
    else if (consume('open-project')) void handleOpenProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- l'intention seule déclenche, une fois
  }, [menuIntent]);

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
      await useDialogStore.getState().showAlert(openFailureMessage(error));
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
      const outcome = await loadFile(filePath);
      if (outcome.status === 'locked') {
        await useDialogStore.getState().showAlert(t(outcome.lock));
      }
    } catch (error: unknown) {
      console.error('Failed to load file:', error);
      await useDialogStore.getState().showAlert(t(openErrorKey(error, 'toolbar.openError')));
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
                  onCSLChange={(cslPath) => patchCurrentProject({ cslPath })}
                />
              </CollapsibleSection>
            )}

            {/* Zotero Project Settings — remontés à chaque projet : rien du précédent (champs,
                message « Enregistré » ou refus) ne s'affiche dans le suivant. */}
            <ZoteroProjectSettings key={currentProject.path} projectPath={currentProject.path} />

            {/* Database Actions - project-specific */}
            <ActionsSection />

            {/* L'entretien de démarrage n'était joué qu'une fois, juste après
                la création du projet : un utilisateur qui l'avait passé ne
                pouvait plus y revenir (audit du 2026-07-19). Il écrit le
                fichier de contexte du projet, il exige donc un projet ouvert. */}
            <button
              className="project-btn"
              onClick={() => setOnboarding({ name: currentProject.name, path: currentProject.path })}
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
        <div ref={createModalRef} className="create-project-modal" {...backdropClose(() => closeCreateModal?.())}>
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
                placeholder={t('projectPanel.namePlaceholder')}
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
                  placeholder={t('projectPanel.pathPlaceholder')}
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
      {onboarding && (
        <OnboardingWizard
          projectName={onboarding.name}
          onComplete={(section) => finishOnboarding(section, onboarding.name, onboarding.path)}
          onSkip={() => setOnboarding(null)}
        />
      )}
    </div>
  );
};
