export interface ZoteroAttachmentInfo {
    key: string;
    filename: string;
    contentType: string;
    downloaded: boolean;
    dateModified?: string;
    md5?: string;
}
export interface Citation {
    id: string;
    key?: string;
    type: string;
    author: string;
    year: string;
    title: string;
    shortTitle?: string;
    journal?: string;
    publisher?: string;
    booktitle?: string;
    file?: string;
    zoteroKey?: string;
    zoteroAttachments?: ZoteroAttachmentInfo[];
    tags?: string[];
    keywords?: string;
    notes?: string;
    customFields?: Record<string, string>;
    dateAdded?: string;
    dateModified?: string;
    get displayString(): string;
    get details(): string | null;
    get hasPDF(): boolean;
    get hasZoteroPDFs(): boolean;
}
export declare function createCitation(data: Omit<Citation, 'displayString' | 'details' | 'hasPDF' | 'hasZoteroPDFs'>): Citation;
