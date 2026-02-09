import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Folder, BookOpen, Network, BookMarked, HelpCircle, Archive } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { BibliographyPanel } from '../Bibliography/BibliographyPanel';
import { ChatInterface } from '../Chat/ChatInterface';
import { SettingsModal } from '../Config/SettingsModal';
import { ProjectPanel } from '../Project/ProjectPanel';
import { PDFExportModal } from '../Export/PDFExportModal';
import { CorpusExplorerPanel } from '../Corpus/CorpusExplorerPanel';
import { JournalPanel } from '../Journal/JournalPanel';
import { PrimarySourcesPanel } from '../PrimarySources/PrimarySourcesPanel';
import { MethodologyModal } from '../Methodology/MethodologyModal';
import { AboutModal } from '../About/AboutModal';
import { logger } from '../../utils/logger';
import './MainLayout.css';

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
  const [leftView, setLeftView] = useState<LeftPanelView>('projects');
  const [rightView, setRightView] = useState<RightPanelView>('chat');
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
          setRightView('chat');
          break;
        case 'corpus':
          setRightView('corpus');
          break;
        case 'journal':
          setRightView('journal');
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

      {/* Main 3-panel layout */}
      <div className="main-content">
        <PanelGroup direction="horizontal">
          {/* Left Panel - Projects / Bibliography */}
          <Panel defaultSize={20} minSize={15} maxSize={35}>
            <div className="panel left-panel">
              {/* Panel tabs */}
              <div className="panel-tabs">
                <button
                  className={`panel-tab ${leftView === 'projects' ? 'active' : ''}`}
                  onClick={() => handleLeftViewChange('projects')}
                  title={t('project.title')}
                >
                  <Folder size={20} strokeWidth={1} />
                </button>
                <button
                  className={`panel-tab ${leftView === 'bibliography' ? 'active' : ''}`}
                  onClick={() => handleLeftViewChange('bibliography')}
                  title={t('bibliography.title')}
                >
                  <BookOpen size={20} strokeWidth={1} />
                </button>
                <button
                  className={`panel-tab primary-sources-tab ${leftView === 'primary-sources' ? 'active' : ''}`}
                  onClick={() => handleLeftViewChange('primary-sources')}
                  title={t('primarySources.title', 'Primary Sources')}
                >
                  <Archive size={20} strokeWidth={1} />
                </button>
              </div>

              {/* Panel content */}
              <div className="panel-content">
                {leftView === 'projects' && (leftPanel || <ProjectPanel />)}
                {leftView === 'bibliography' && <BibliographyPanel />}
                {leftView === 'primary-sources' && <PrimarySourcesPanel />}
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          {/* Center Panel - Markdown Editor */}
          <Panel defaultSize={50} minSize={30}>
            <div className="panel center-panel">
              {centerPanel || (
                <div className="panel-placeholder">Éditeur Markdown (Monaco Editor)</div>
              )}
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          {/* Right Panel - Chat RAG / PDF Index / Corpus */}
          <Panel defaultSize={30} minSize={20} maxSize={45}>
            <div className="panel right-panel">
              {/* Panel tabs */}
              <div className="panel-tabs">
                <button
                  className={`panel-tab ${rightView === 'chat' ? 'active' : ''}`}
                  onClick={() => handleRightViewChange('chat')}
                  title={t('chat.title')}
                >
                  <MessageCircle size={20} strokeWidth={1} />
                </button>
                <button
                  className={`panel-tab ${rightView === 'corpus' ? 'active' : ''}`}
                  onClick={() => handleRightViewChange('corpus')}
                  title={t('corpus.title')}
                >
                  <Network size={20} strokeWidth={1} />
                </button>
                <button
                  className={`panel-tab ${rightView === 'journal' ? 'active' : ''}`}
                  onClick={() => handleRightViewChange('journal')}
                  title={t('journal.title')}
                >
                  <BookMarked size={20} strokeWidth={1} />
                </button>
              </div>

              {/* Panel content */}
              <div className="panel-content">
                {rightView === 'chat' && <ChatInterface />}
                {rightView === 'corpus' && <CorpusExplorerPanel />}
                {rightView === 'journal' && <JournalPanel />}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      {/* PDF Export Modal */}
      <PDFExportModal isOpen={showExportModal} onClose={() => setShowExportModal(false)} />

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettingsModal} onClose={() => setShowSettingsModal(false)} />

      {/* Methodology Modal */}
      <MethodologyModal
        isOpen={showMethodologyModal}
        onClose={() => {
          setShowMethodologyModal(false);
          setMethodologyInitialFeature(undefined);
        }}
        initialFeature={methodologyInitialFeature}
      />

      {/* About Modal */}
      <AboutModal isOpen={showAboutModal} onClose={() => setShowAboutModal(false)} />
    </div>
  );
};
