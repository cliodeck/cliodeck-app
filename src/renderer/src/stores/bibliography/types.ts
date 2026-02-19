import type { StateCreator } from 'zustand';

// MARK: - Shared Types

export interface ZoteroAttachmentInfo {
  key: string; // Zotero attachment key
  filename: string;
  contentType: string;
  downloaded: boolean;
  localPath?: string; // Path to downloaded PDF
  dateModified?: string;
  md5?: string;
}

export interface Citation {
  id: string;
  key?: string; // Alternative BibTeX key
  type: string;
  author: string;
  year: string;
  title: string;
  shortTitle?: string;
  journal?: string;
  publisher?: string;
  booktitle?: string;
  file?: string;

  // Zotero metadata
  zoteroKey?: string; // Zotero item key
  zoteroAttachments?: ZoteroAttachmentInfo[]; // PDF attachments from Zotero

  // Tags and metadata
  tags?: string[];
  keywords?: string;
  notes?: string;
  customFields?: Record<string, string>;
  dateAdded?: string;
  dateModified?: string;
}

export interface IndexingProgress {
  citationId: string;
  title: string;
  progress: number;
  stage: string;
}

export interface BatchIndexingState {
  isIndexing: boolean;
  current: number;
  total: number;
  currentCitation?: IndexingProgress;
  skipped: number;
  indexed: number;
  errors: string[];
}

// MARK: - Slice State Interfaces

export interface CitationSliceState {
  // State
  citations: Citation[];
  filteredCitations: Citation[];
  selectedCitationId: string | null;
  searchQuery: string;
  sortBy: 'author' | 'year' | 'title';
  sortOrder: 'asc' | 'desc';
  selectedTags: string[];

  // Actions
  loadBibliography: (filePath: string) => Promise<void>;
  loadBibliographyWithMetadata: (filePath: string, projectPath: string) => Promise<void>;
  mergeBibliography: (filePath: string) => Promise<{ newCitations: number; duplicates: number; total: number }>;
  searchCitations: (query: string) => void;
  setSortBy: (field: 'author' | 'year' | 'title') => void;
  toggleSortOrder: () => void;
  selectCitation: (citationId: string) => void;
  insertCitation: (citationId: string) => void;
  updateCitationMetadata: (citationId: string, updates: Partial<Citation>) => void;
  getAllTags: () => string[];
  setTagsFilter: (tags: string[]) => void;
  clearTagsFilter: () => void;
  applyFilters: () => void;
}

export interface IndexingSliceState {
  // State
  indexedFilePaths: Set<string>;
  indexedBibtexKeys: Set<string>;
  batchIndexing: BatchIndexingState;

  // Actions
  indexPDFFromCitation: (citationId: string) => Promise<{ alreadyIndexed: boolean }>;
  reindexPDFFromCitation: (citationId: string) => Promise<void>;
  getDocumentIdForCitation: (citationId: string) => Promise<string | null>;
  indexAllPDFs: () => Promise<{ indexed: number; skipped: number; errors: string[] }>;
  refreshIndexedPDFs: () => Promise<void>;
  isFileIndexed: (filePath: string) => boolean;
  isBibtexKeyIndexed: (bibtexKey: string) => boolean;
}

export interface ZoteroSliceState {
  // Actions only (state is shared via other slices)
  downloadAndIndexZoteroPDF: (citationId: string, attachmentKey: string, projectPath: string) => Promise<void>;
  downloadAllMissingPDFs: (projectPath: string) => Promise<{ downloaded: number; skipped: number; errors: string[] }>;
}

// Combined state (all slices merged)
export type BibliographyState = CitationSliceState & IndexingSliceState & ZoteroSliceState;

// Zustand slice creator type - each slice gets set/get for the full combined state
export type BibliographySliceCreator<T> = StateCreator<BibliographyState, [], [], T>;
