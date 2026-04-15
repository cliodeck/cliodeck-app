import React, { useState, useEffect, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Folder, BookOpen, Network, BookMarked, HelpCircle, Archive } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { BibliographyPanel } from '../Bibliography/BibliographyPanel';
import { ChatInterface } from '../Chat/ChatInterface';
import { ProjectPanel } from '../Project/ProjectPanel';
import { PanelLoadingFallback } from '../common/PanelLoadingFallback';
import { WorkspaceModeBar } from './WorkspaceModeBar';
import { BrainstormPanel } from '../Brainstorm/BrainstormPanel';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { logger } from '../../utils/logger';
import './MainLayout.css';

// Lazy-loaded heavy components (panels)
const CorpusExplorerPanel = lazy(() =>
  import('../Corpus/CorpusExplorerPanel').then(m => ({ default: m.CorpusExplorerPanel }))
);
const JournalPanel = lazy(() =>
  import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel }))
);
const PrimarySourcesPanel = lazy(() =>
  import('../PrimarySources/PrimarySourcesPanel').then(m => ({ default: m.PrimarySourcesPanel }))
);

// Lazy-loaded mode surfaces (only rendered when that workspace mode is active)
const AnalyzePanel = lazy(() =>
  import('./AnalyzePanel').then(m => ({ default: m.AnalyzePanel }))
);
const ExportHub = lazy(() =>
  import('./ExportHub').then(m => ({ default: m.ExportHub }))
);

// Lazy-loaded modals (only rendered when opened)
const SettingsModal = lazy(() =>
  import('../Config/SettingsModal').then(m => ({ default: m.SettingsModal }))
);
const PDFExportModal = lazy(() =>
  import('../Export/PDFExportModal').then(m => ({ default: m.PDFExportModal }))
);
const MethodologyModal = lazy(() =>
  import('../Methodology/MethodologyModal').then(m => ({ default: m.MethodologyModal }))
);
const AboutModal = lazy(() =>
  import('../About/AboutModal').then(m => ({ default: m.AboutModal }))
);

type LeftPanelView = 'projects' | 'bibliography' | 'primary-sources';
type RightPanelView = 'chat' | 'corpus' | 'journal';

export interface MainLayoutProps {
  leftPanel?: React.ReactNode;
  centerPanel?: React.ReactNode;
  rightPanel?: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  leftPanel,
  centerPanel,
}) => {
  const { t } = useTranslation('common');
  const workspaceMode = useWorkspaceModeStore((s) => s.active);
  const rightViewByMode = useWorkspaceModeStore((s) => s.rightViewByMode);
  const persistRightView = useWorkspaceModeStore((s) => s.setRightView);
  const [leftView, setLeftView] = useState<LeftPanelView>('projects');
  const isBrainstorm = workspaceMode === 'brainstorm';

  // Per-mode memory: restore whichever right-tab the user last used in
  // this mode. If that tab is the (hidden) chat tab in Brainstorm, fall
  // back to corpus so we don't render a tab that doesn't exist.
  const storedRightView = rightViewByMode[workspaceMode];
  const rightView: RightPanelView =
    isBrainstorm && storedRightView === 'chat' ? 'corpus' : storedRightView;

  const setRightView = (view: RightPanelView) => {
    persistRightView(workspaceMode, view);
  };
  const [showExportModal, setShowExportModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showMethodologyModal, setShowMethodologyModal] = useState(false);
  const [methodologyInitialFeature, setMethodologyInitialFeature] = useState<string | undefined>(undefined);
  const [showAboutModal, setShowAboutModal] = useState(false);

  const handleLeftViewChange = (view: LeftPanelView) => {
    logger.component('MainLayout', 'Left tab clicked', { view });
    setLeftView(view);
  };

  const handleRightViewChange = (view: RightPanelView) => {
    logger.component('MainLayout', 'Right tab clicked', { view });
    setRightView(view);
  };

  // Listen to menu shortcuts for panel switching and PDF export
  useEffect(() => {
    const handleSwitchPanel = (event: Event) => {
      const customEvent = event as CustomEvent;
      const panel = customEvent.detail;
      // Read store fresh each event so menu shortcuts target the *current*
      // workspace mode even though this effect is set up once.
      const { active, setRightView: persist } = useWorkspaceModeStore.getState();

      switch (panel) {
        case 'projects':
          setLeftView('projects');
          break;
        case 'bibliography':
          setLeftView('bibliography');
          break;
        case 'primary-sources':
          setLeftView('primary-sources');
          break;
        case 'chat':
          persist(active, 'chat');
          break;
        case 'corpus':
          persist(active, 'corpus');
          break;
        case 'journal':
          persist(active, 'journal');
          break;
      }
    };

    const handleShowPDFExport = () => {
      setShowExportModal(true);
    };

    const handleShowSettings = () => {
      setShowSettingsModal(true);
    };

    const handleShowMethodology = (event: Event) => {
      const customEvent = event as CustomEvent;
      setMethodologyInitialFeature(customEvent.detail?.feature);
      setShowMethodologyModal(true);
    };

    const handleShowAbout = () => {
      setShowAboutModal(true);
    };

    window.addEventListener('switch-panel', handleSwitchPanel);
    window.addEventListener('show-pdf-export-dialog', handleShowPDFExport);
    window.addEventListener('show-settings-modal', handleShowSettings);
    window.addEventListener('show-methodology-modal', handleShowMethodology);
    window.addEventListener('show-about-dialog', handleShowAbout);

    return () => {
      window.removeEventListener('switch-panel', handleSwitchPanel);
      window.removeEventListener('show-pdf-export-dialog', handleShowPDFExport);
      window.removeEventListener('show-settings-modal', handleShowSettings);
      window.removeEventListener('show-methodology-modal', handleShowMethodology);
      window.removeEventListener('show-about-dialog', handleShowAbout);
    };
  }, []);

  return (
    <div className="main-layout">
      {/* Floating Help Button */}
      <button
        className="floating-help-btn"
        onClick={() => setShowMethodologyModal(true)}
        title={t('methodology.title')}
      >
        <HelpCircle size={12} />
      </button>

      {/* Workspace mode bar (fusion phase 3.1a) */}
      <WorkspaceModeBar />

      {/* Main 3-panel layout */}
      <div className="main-content">
        <PanelGroup direction="horizontal">
          {/* Left Panel - Projects / Bibliography */}
          <Panel defaultSize={20} minSize={15} maxSize={35}>
            <div className="panel left-panel">
              {/* Panel tabs */}
              <div className="panel-tabs" role="tablist" aria-label={t('project.title')}>
                <button
                  id="left-tab-projects"
                  className={`panel-tab ${leftView === 'projects' ? 'active' : ''}`}
                  onClick={() => handleLeftViewChange('projects')}
                  title={t('project.title')}
                  role="tab"
                  aria-selected={leftView === 'projects'}
                  aria-controls="left-tabpanel-projects"
                >
                  <Folder size={20} strokeWidth={1} />
                </button>
                <button
                  id="left-tab-bibliography"
                  className={`panel-tab ${leftView === 'bibliography' ? 'active' : ''}`}
                  onClick={() => handleLeftViewChange('bibliography')}
                  title={t('bibliography.title')}
                  role="tab"
                  aria-selected={leftView === 'bibliography'}
                  aria-controls="left-tabpanel-bibliography"
                >
                  <BookOpen size={20} strokeWidth={1} />
                </button>
                <button
                  id="left-tab-primary-sources"
                  className={`panel-tab primary-sources-tab ${leftView === 'primary-sources' ? 'active' : ''}`}
                  onClick={() => handleLeftViewChange('primary-sources')}
                  title={t('primarySources.title', 'Primary Sources')}
                  role="tab"
                  aria-selected={leftView === 'primary-sources'}
                  aria-controls="left-tabpanel-primary-sources"
                >
                  <Archive size={20} strokeWidth={1} />
                </button>
              </div>

              {/* Panel content */}
              <div
                className="panel-content"
                role="tabpanel"
                id={`left-tabpanel-${leftView}`}
                aria-labelledby={`left-tab-${leftView}`}
              >
                {leftView === 'projects' && (leftPanel || <ProjectPanel />)}
                {leftView === 'bibliography' && <BibliographyPanel />}
                {leftView === 'primary-sources' && (
                  <Suspense fallback={<PanelLoadingFallback />}>
                    <PrimarySourcesPanel />
                  </Suspense>
                )}
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          {/* Center Panel - Markdown Editor (or Brainstorm scaffold) */}
          <Panel defaultSize={50} minSize={30}>
            <div className="panel center-panel">
              {workspaceMode === 'brainstorm' ? (
                <BrainstormPanel />
              ) : workspaceMode === 'analyze' ? (
                <Suspense fallback={<PanelLoadingFallback />}>
                  <AnalyzePanel />
                </Suspense>
              ) : workspaceMode === 'export' ? (
                <Suspense fallback={<PanelLoadingFallback />}>
                  <ExportHub />
                </Suspense>
              ) : (
                centerPanel || (
                  <div className="panel-placeholder">Éditeur Markdown (Monaco Editor)</div>
                )
              )}
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          {/* Right Panel - Chat RAG / PDF Index / Corpus */}
          <Panel defaultSize={30} minSize={20} maxSize={45}>
            <div className="panel right-panel">
              {/* Panel tabs */}
              <div className="panel-tabs" role="tablist" aria-label={t('chat.title')}>
                {!isBrainstorm && (
                  <button
                    id="right-tab-chat"
                    className={`panel-tab ${rightView === 'chat' ? 'active' : ''}`}
                    onClick={() => handleRightViewChange('chat')}
                    title={t('chat.title')}
                    role="tab"
                    aria-selected={rightView === 'chat'}
                    aria-controls="right-tabpanel-chat"
                  >
                    <MessageCircle size={20} strokeWidth={1} />
                  </button>
                )}
                <button
                  id="right-tab-corpus"
                  className={`panel-tab ${rightView === 'corpus' ? 'active' : ''}`}
                  onClick={() => handleRightViewChange('corpus')}
                  title={t('corpus.title')}
                  role="tab"
                  aria-selected={rightView === 'corpus'}
                  aria-controls="right-tabpanel-corpus"
                >
                  <Network size={20} strokeWidth={1} />
                </button>
                <button
                  id="right-tab-journal"
                  className={`panel-tab ${rightView === 'journal' ? 'active' : ''}`}
                  onClick={() => handleRightViewChange('journal')}
                  title={t('journal.title')}
                  role="tab"
                  aria-selected={rightView === 'journal'}
                  aria-controls="right-tabpanel-journal"
                >
                  <BookMarked size={20} strokeWidth={1} />
                </button>
              </div>

              {/* Panel content */}
              <div
                className="panel-content"
                role="tabpanel"
                id={`right-tabpanel-${rightView}`}
                aria-labelledby={`right-tab-${rightView}`}
              >
                {rightView === 'chat' && !isBrainstorm && <ChatInterface />}
                {rightView === 'corpus' && (
                  <Suspense fallback={<PanelLoadingFallback />}>
                    <CorpusExplorerPanel />
                  </Suspense>
                )}
                {rightView === 'journal' && (
                  <Suspense fallback={<PanelLoadingFallback />}>
                    <JournalPanel />
                  </Suspense>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      {/* PDF Export Modal */}
      {showExportModal && (
        <Suspense fallback={null}>
          <PDFExportModal isOpen={showExportModal} onClose={() => setShowExportModal(false)} />
        </Suspense>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
        <Suspense fallback={null}>
          <SettingsModal isOpen={showSettingsModal} onClose={() => setShowSettingsModal(false)} />
        </Suspense>
      )}

      {/* Methodology Modal */}
      {showMethodologyModal && (
        <Suspense fallback={null}>
          <MethodologyModal
            isOpen={showMethodologyModal}
            onClose={() => {
              setShowMethodologyModal(false);
              setMethodologyInitialFeature(undefined);
            }}
            initialFeature={methodologyInitialFeature}
          />
        </Suspense>
      )}

      {/* About Modal */}
      {showAboutModal && (
        <Suspense fallback={null}>
          <AboutModal isOpen={showAboutModal} onClose={() => setShowAboutModal(false)} />
        </Suspense>
      )}
    </div>
  );
};
