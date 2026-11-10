import { create } from 'zustand';

import { createCitationSlice } from './bibliography/citationSlice';
import { createIndexingSlice, idleBatchIndexing } from './bibliography/indexingSlice';
import { createZoteroSlice } from './bibliography/zoteroSlice';
import { createReadingNotesSlice } from './bibliography/readingNotesSlice';
import type { BibliographyState } from './bibliography/types';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

// Re-export types so existing consumer imports remain valid
export type {
  ZoteroAttachmentInfo,
  ZoteroTag,
  ZoteroNote,
  ReadingNoteSummary,
  Citation,
  IndexingProgress,
  BatchIndexingState,
} from './bibliography/types';

// MARK: - Store (composed from slices)

export const useBibliographyStore = create<BibliographyState>((...args) => ({
  ...createCitationSlice(...args),
  ...createIndexingSlice(...args),
  ...createZoteroSlice(...args),
  ...createReadingNotesSlice(...args),
}));

/**
 * Tout ce qui vient du projet ouvert, dans chaque tranche : références, bandeau, sélection, recherche
 * et filtre de tags, PDF indexés, lot en cours, notes de lecture. Le tri et l'affichage des tags
 * automatiques sont des préférences de l'auteur, et restent.
 */
function emptyProjectBibliography(): Partial<BibliographyState> {
  return {
    citations: [],
    filteredCitations: [],
    bibliographyProblem: null,
    selectedCitationId: null,
    searchQuery: '',
    selectedTags: [],
    indexedFilePaths: new Set<string>(),
    indexedBibtexKeys: new Set<string>(),
    batchIndexing: idleBatchIndexing(),
    readingNotes: [],
  };
}

// Un projet sans `.bib` gardait les références du précédent : son panneau les listait, « Télécharger
// les PDF manquants » et « Indexer tous les PDF » les traitaient dans son dossier (S07-1-31). Les lots
// en vol s'arrêtent d'eux-mêmes (`stillIn`, S18-2-0) sans plus rien écrire ici.
projectLifecycle.onReset('bibliography', () => useBibliographyStore.setState(emptyProjectBibliography()));
