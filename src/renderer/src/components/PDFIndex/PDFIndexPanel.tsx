import React, { useState, useEffect, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PDFList } from './PDFList';
import { IndexingProgress } from './IndexingProgress';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useProjectStore } from '../../stores/projectStore';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { PDFRenameModal } from './PDFRenameModal';
import './PDFIndexPanel.css';

interface PDFDocument {
  id: string;
  title: string;
  author?: string;
  year?: string;
  bibtexKey?: string;
  pageCount: number;
  chunkCount?: number;
  indexedAt: Date;
}

interface IndexingState {
  isIndexing: boolean;
  currentFile?: string;
  progress: number;
  stage: string;
}

type SortField = 'author' | 'year' | 'title';
type SortOrder = 'asc' | 'desc';

export const PDFIndexPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { currentProject } = useProjectStore();
  const [documents, setDocuments] = useState<PDFDocument[]>([]);
  const [indexingState, setIndexingState] = useState<IndexingState>({
    isIndexing: false,
    progress: 0,
    stage: '',
  });
  const [stats, setStats] = useState({
    totalDocuments: 0,
    totalChunks: 0,
  });
  const [isCleaning, setIsCleaning] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('author');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  // Filter and sort documents
  const filteredDocuments = useMemo(() => {
    let filtered = documents;

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = documents.filter((doc) =>
        (doc.title?.toLowerCase().includes(query)) ||
        (doc.author?.toLowerCase().includes(query)) ||
        (doc.year?.includes(query)) ||
        (doc.bibtexKey?.toLowerCase().includes(query))
      );
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case 'author':
          comparison = (a.author || t('pdfIndex.unknownAuthor')).localeCompare(b.author || t('pdfIndex.unknownAuthor'));
          break;
        case 'year':
          comparison = (a.year || '').localeCompare(b.year || '');
          break;
        case 'title':
          comparison = (a.title || '').localeCompare(b.title || '');
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [documents, searchQuery, sortBy, sortOrder, t]);

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  };

  useEffect(() => {
    loadDocuments();
    loadStats();

    // Listen for indexing progress events
    const unsubscribe = window.electron.pdf.onIndexingProgress((progress) => {
      setIndexingState((prev) => ({
        ...prev,
        progress: progress.progress,
        stage: progress.message,
      }));
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const loadDocuments = async () => {
    try {
      const result = await window.electron.pdf.getAll();
      console.log('[PDFIndexPanel] getAll result:', result);
      if (result.success && Array.isArray(result.documents)) {
        setDocuments(result.documents);
      } else {
        console.error('[PDFIndexPanel] Invalid response from pdf.getAll:', result);
        setDocuments([]);
      }
    } catch (error) {
      console.error('[PDFIndexPanel] Failed to load documents:', error);
      setDocuments([]);
    }
  };

  const loadStats = async () => {
    try {
      const result = await window.electron.pdf.getStatistics();
      console.log('[PDFIndexPanel] getStatistics result:', result);
      if (result.success && result.statistics) {
        setStats({
          totalDocuments: result.statistics.totalDocuments,
          totalChunks: result.statistics.totalChunks,
        });
      } else {
        console.error('[PDFIndexPanel] Invalid response from pdf.getStatistics:', result);
        setStats({ totalDocuments: 0, totalChunks: 0 });
      }
    } catch (error) {
      console.error('[PDFIndexPanel] Failed to load stats:', error);
      setStats({ totalDocuments: 0, totalChunks: 0 });
    }
  };

  const handleAddPDF = async () => {
    // Check if a project is open BEFORE opening file dialog
    if (!currentProject) {
      alert(t('pdfIndex.noProjectOpen'));
      return;
    }

    try {
      const result = await window.electron.dialog.openFile({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        // Show rename modal instead of indexing directly
        setPendingFiles(result.filePaths);
        setShowRenameModal(true);
      }
    } catch (error) {
      console.error('Failed to add PDF:', error);
    }
  };

  const handleConfirmRename = async (renamedFiles: Map<string, string>) => {
    setShowRenameModal(false);

    // Index each PDF with its custom name
    for (const [filePath, customTitle] of renamedFiles.entries()) {
      await indexPDF(filePath, customTitle);
    }

    setPendingFiles([]);
  };

  const indexPDF = async (filePath: string, customTitle?: string) => {
    setIndexingState({
      isIndexing: true,
      currentFile: filePath,
      progress: 0,
      stage: 'Initialisation...',
    });

    try {
      // When adding PDF directly (not from bibliography), pass customTitle as bibliographyMetadata
      const bibliographyMetadata = customTitle ? { title: customTitle } : undefined;
      const result = await window.electron.pdf.index(filePath, undefined, bibliographyMetadata);

      // Check if indexing failed
      if (result && !result.success) {
        const errorMessage = result.error || t('pdfIndex.indexingError');
        alert(errorMessage);
        setIndexingState({
          isIndexing: false,
          progress: 0,
          stage: t('pdfIndex.indexingError'),
        });
        return;
      }

      await loadDocuments();
      await loadStats();

      setIndexingState({
        isIndexing: false,
        progress: 100,
        stage: 'Terminé',
      });
    } catch (error) {
      console.error('Indexing failed:', error);
      const errorMessage = error instanceof Error ? error.message : t('pdfIndex.indexingError');
      alert(`${t('pdfIndex.indexingError')}: ${errorMessage}`);
      setIndexingState({
        isIndexing: false,
        progress: 0,
        stage: t('pdfIndex.indexingError'),
      });
    }
  };

  const handleDeletePDF = async (documentId: string) => {
    if (!window.confirm(t('pdfIndex.deleteConfirm'))) {
      return;
    }

    try {
      await window.electron.pdf.delete(documentId);
      await loadDocuments();
      await loadStats();
    } catch (error) {
      console.error('Failed to delete document:', error);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if a project is open BEFORE processing dropped files
    if (!currentProject) {
      alert(t('pdfIndex.noProjectOpen'));
      return;
    }

    const files = Array.from(e.dataTransfer.files).filter((file) =>
      file.name.toLowerCase().endsWith('.pdf')
    );

    for (const file of files) {
      await indexPDF(file.path);
    }
  };

  const handleLearnMore = () => {
    window.dispatchEvent(new CustomEvent('show-methodology-modal', { detail: { feature: 'pdfIndex' } }));
  };

  const handleCleanOrphanedChunks = async () => {
    if (!window.confirm(t('pdfIndex.cleanOrphanedConfirm'))) {
      return;
    }

    setIsCleaning(true);
    try {
      const result = await window.electron.pdf.cleanOrphanedChunks();

      if (result.success) {
        console.log('✅ Orphaned chunks cleaned successfully');
        alert(`✅ ${t('pdfIndex.cleanSuccess')}`);
      } else {
        console.error('❌ Failed to clean orphaned chunks:', result.error);
        alert(`❌ ${t('pdfIndex.cleanError')}:\n${result.error}`);
      }

      // Reload statistics
      await loadStats();
    } catch (error) {
      console.error('Failed to clean orphaned chunks:', error);
      alert(t('pdfIndex.cleanError'));
    } finally {
      setIsCleaning(false);
    }
  };

  return (
    <div className="pdf-index-panel">
      {/* Header */}
      <div className="pdf-header">
        <div className="header-title">
          <h3>{t('pdfIndex.title')}</h3>
          <HelperTooltip
            content={t('pdfIndex.dropzone')}
            onLearnMore={handleLearnMore}
          />
        </div>
        <button className="toolbar-btn" onClick={handleAddPDF} title={t('pdfIndex.addPDF')}>
          <Plus size={20} strokeWidth={1} />
        </button>
      </div>

      {/* Stats */}
      <CollapsibleSection title={t('pdfIndex.statistics')} defaultExpanded={false}>
        <div className="pdf-stats">
          <div className="stat-item">
            <span className="stat-value">{stats.totalDocuments}</span>
            <span className="stat-label">{t('pdfIndex.documents')}</span>
          </div>
          <div className="stat-divider">|</div>
          <div className="stat-item">
            <span className="stat-value">{stats.totalChunks}</span>
            <span className="stat-label">{t('pdfIndex.chunks')}</span>
          </div>
        </div>
        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #444' }}>
          <button
            className="config-btn-small"
            onClick={handleCleanOrphanedChunks}
            disabled={isCleaning}
            style={{
              width: '100%',
              background: '#3c3c3c',
              color: '#ffffff',
              border: '1px solid #555',
              padding: '8px 12px',
              borderRadius: '4px',
              cursor: isCleaning ? 'not-allowed' : 'pointer',
              fontSize: '13px',
            }}
          >
            {isCleaning ? `⏳ ${t('pdfIndex.cleaning')}` : `🧹 ${t('pdfIndex.cleanOrphanedChunks')}`}
          </button>
        </div>
      </CollapsibleSection>

      {/* Indexing Progress */}
      {indexingState.isIndexing && (
        <IndexingProgress
          fileName={indexingState.currentFile || ''}
          progress={indexingState.progress}
          stage={indexingState.stage}
        />
      )}

      {/* Search & Filters */}
      <CollapsibleSection title={t('pdfIndex.searchAndFilters')} defaultExpanded={true}>
        <div className="pdf-controls">
          <div className="search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="search-input"
              placeholder={t('pdfIndex.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="sort-controls">
            <label className="sort-label">{t('bibliography.sortBy')}</label>
            <select
              className="sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortField)}
            >
              <option value="author">{t('bibliography.author')}</option>
              <option value="year">{t('bibliography.year')}</option>
              <option value="title">{t('bibliography.titleField')}</option>
            </select>
            <button className="sort-order-btn" onClick={toggleSortOrder} title={t('bibliography.sortBy')}>
              {sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>

        {/* Document Count */}
        <div className="document-count">
          {filteredDocuments.length} {t('pdfIndex.documents').toLowerCase()}
          {searchQuery && filteredDocuments.length !== documents.length && (
            <span className="filter-indicator"> ({t('pdfIndex.filtered')})</span>
          )}
        </div>
      </CollapsibleSection>

      {/* Document List */}
      <CollapsibleSection title={t('pdfIndex.documents')} defaultExpanded={true}>
        <div
          className="pdf-content"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {documents.length === 0 ? (
            <div className="pdf-empty">
              <div className="empty-icon">📂</div>
              <h4>{t('pdfIndex.noDocuments')}</h4>
              <p>{t('pdfIndex.dropzone')}</p>
            </div>
          ) : filteredDocuments.length === 0 ? (
            <div className="pdf-empty">
              <div className="empty-icon">🔍</div>
              <h4>{t('pdfIndex.noResults')}</h4>
              <p>{t('pdfIndex.tryDifferentSearch')}</p>
            </div>
          ) : (
            <PDFList documents={filteredDocuments} onDelete={handleDeletePDF} />
          )}
        </div>
      </CollapsibleSection>

      {/* PDF Rename Modal */}
      <PDFRenameModal
        isOpen={showRenameModal}
        onClose={() => {
          setShowRenameModal(false);
          setPendingFiles([]);
        }}
        files={pendingFiles}
        onConfirm={handleConfirmRename}
      />
    </div>
  );
};
