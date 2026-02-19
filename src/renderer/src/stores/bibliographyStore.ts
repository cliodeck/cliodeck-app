import { create } from 'zustand';

import { createCitationSlice } from './bibliography/citationSlice';
import { createIndexingSlice } from './bibliography/indexingSlice';
import { createZoteroSlice } from './bibliography/zoteroSlice';
import type { BibliographyState } from './bibliography/types';

// Re-export types so existing consumer imports remain valid
export type {
  ZoteroAttachmentInfo,
  Citation,
  IndexingProgress,
  BatchIndexingState,
} from './bibliography/types';

// MARK: - Store (composed from slices)

export const useBibliographyStore = create<BibliographyState>((...args) => ({
  ...createCitationSlice(...args),
  ...createIndexingSlice(...args),
  ...createZoteroSlice(...args),
}));
