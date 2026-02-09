export interface ZoteroAttachmentInfo {
  key: string; // Zotero attachment key
  filename: string;
  contentType: string;
  downloaded: boolean;
  dateModified?: string;
  md5?: string;
}

export interface Citation {
  id: string; // Clé BibTeX
  key?: string; // Alternative BibTeX key (for compatibility)
  type: string; // @book, @article, @incollection, etc.
  author: string;
  year: string;
  title: string;
  shortTitle?: string;
  journal?: string;
  publisher?: string;
  booktitle?: string;
  file?: string; // Chemin vers le PDF (local)

  // Zotero metadata
  zoteroKey?: string; // Zotero item key
  zoteroAttachments?: ZoteroAttachmentInfo[]; // PDF attachments from Zotero

  // Tags and metadata
  tags?: string[]; // User-defined tags
  keywords?: string; // BibTeX keywords field
  notes?: string; // User notes
  customFields?: Record<string, string>; // Custom metadata fields
  dateAdded?: string; // ISO date when citation was added
  dateModified?: string; // ISO date when citation was last modified

  // Computed properties
  get displayString(): string;
  get details(): string | null;
  get hasPDF(): boolean;
  get hasZoteroPDFs(): boolean;
}

export function createCitation(data: Omit<Citation, 'displayString' | 'details' | 'hasPDF' | 'hasZoteroPDFs'>): Citation {
  return {
    ...data,
    get displayString() {
      return `${this.author} (${this.year})`;
    },
    get details() {
      const parts: string[] = [];
      if (this.journal) parts.push(this.journal);
      if (this.publisher) parts.push(this.publisher);
      if (this.booktitle) parts.push(`in ${this.booktitle}`);
      return parts.length > 0 ? parts.join(', ') : null;
    },
    get hasPDF() {
      return !!this.file;
    },
    get hasZoteroPDFs() {
      return !!this.zoteroAttachments && this.zoteroAttachments.length > 0;
    },
  };
}
