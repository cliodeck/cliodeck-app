export function createCitation(data) {
    return {
        ...data,
        get displayString() {
            return `${this.author} (${this.year})`;
        },
        get details() {
            const parts = [];
            if (this.journal)
                parts.push(this.journal);
            if (this.publisher)
                parts.push(this.publisher);
            if (this.booktitle)
                parts.push(`in ${this.booktitle}`);
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
