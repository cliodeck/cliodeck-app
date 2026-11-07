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
  /** Vide pour un ouvrage dirigé : les noms sont alors dans `editor`. */
  author: string;
  /** Directeurs / éditeurs scientifiques, au format BibTeX. */
  editor?: string;
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
  /** Tags du fichier .bib, pour une référence sans lien Zotero. */
  tags?: string[];
  /** Tags Zotero de la notice — lecture seule. */
  zoteroTags?: ZoteroTag[];
  /** Notes Zotero de la notice — lecture seule. */
  zoteroNotes?: ZoteroNote[];
  keywords?: string;
  notes?: string;
  customFields?: Record<string, string>;
  dateAdded?: string;
  dateModified?: string;
}

/** Tag Zotero ; `automatic` : importé par Zotero depuis un site d'éditeur. */
export interface ZoteroTag {
  tag: string;
  automatic: boolean;
}

/** Note Zotero rattachée à la notice, en texte (lecture seule). */
export interface ZoteroNote {
  key: string;
  text: string;
}

/** Note de lecture du projet (fichier Markdown dans `reading-notes/`). */
export interface ReadingNoteSummary {
  file: string;
  citekey: string;
  zoteroKey?: string;
  /** Étiquettes du projet. */
  tags: string[];
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

/**
 * Le projet a changé en cours de route (S18-2-0) : l'action s'est arrêtée sans rien écrire ni
 * relire dans le nouveau projet. Un lot dit en plus combien d'éléments il n'a pas traités.
 */
export interface ProjectChangedOutcome {
  interrupted?: true;
  remaining?: number;
  /**
   * PDF téléchargés et rattachés dans le projet, mais pas indexés : une relance du téléchargement
   * les écarterait (leur notice a son fichier), « Indexer tous les PDFs » les reprend.
   */
  toIndex?: number;
}

/**
 * Le `.bib` attendu du projet ne s'est pas lu, ou pas en entier : le panneau le dit en bandeau,
 * au lieu de se montrer vide ou de taire ce qui manque (S07-1-11, S07-1-2). `partial` : le fichier
 * s'est lu, mais des entrées ou les métadonnées des PDF Zotero ne l'ont pas été.
 */
export type BibliographyProblem =
  | { kind: 'missing'; file: string }
  | { kind: 'unreadable'; file: string; reason: string; detail: string }
  | { kind: 'partial'; file: string; unreadKeys: string[]; metadataUnreadable: boolean };

// MARK: - Slice State Interfaces

export interface CitationSliceState {
  // State
  citations: Citation[];
  /** Remis à zéro à chaque ouverture de projet : le bandeau d'un projet ne passe jamais dans un autre. */
  bibliographyProblem: BibliographyProblem | null;
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
  indexPDFFromCitation: (citationId: string) => Promise<{ alreadyIndexed: boolean } & ProjectChangedOutcome>;
  reindexPDFFromCitation: (citationId: string) => Promise<ProjectChangedOutcome>;
  getDocumentIdForCitation: (citationId: string) => Promise<string | null>;
  /** Indexe les PDF des références du projet `projectPath`, tant qu'il reste le projet ouvert. */
  indexAllPDFs: (projectPath: string) => Promise<{ indexed: number; skipped: number; errors: string[] } & ProjectChangedOutcome>;
  refreshIndexedPDFs: () => Promise<void>;
  isFileIndexed: (filePath: string) => boolean;
  isBibtexKeyIndexed: (bibtexKey: string) => boolean;
}

export interface ZoteroSliceState {
  // Actions only (state is shared via other slices)
  downloadAndIndexZoteroPDF: (citationId: string, attachmentKey: string, projectPath: string) => Promise<ProjectChangedOutcome>;
  downloadAllMissingPDFs: (projectPath: string) => Promise<{ downloaded: number; skipped: number; errors: string[] } & ProjectChangedOutcome>;
}

export interface ReadingNotesSliceState {
  readingNotes: ReadingNoteSummary[];
  /** Afficher aussi les tags automatiques de Zotero (masqués par défaut). */
  showAutomaticZoteroTags: boolean;

  loadReadingNotes: () => Promise<void>;
  /** Remplace les étiquettes du projet d'une référence (crée la note au besoin). */
  setProjectTags: (citationId: string, tags: string[]) => Promise<void>;
  /** Chemin de la note de lecture, créée au besoin. */
  openReadingNote: (citationId: string) => Promise<string | null>;
  setShowAutomaticZoteroTags: (show: boolean) => void;
}

// Combined state (all slices merged)
export type BibliographyState = CitationSliceState & IndexingSliceState & ZoteroSliceState & ReadingNotesSliceState;

// Zustand slice creator type - each slice gets set/get for the full combined state
export type BibliographySliceCreator<T> = StateCreator<BibliographyState, [], [], T>;
