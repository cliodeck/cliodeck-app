/**
 * TextPreprocessor - Clean and normalize text before chunking
 *
 * Features:
 * - OCR artifact cleanup (invalid characters, split words)
 * - Header/footer detection and removal
 * - Page number removal
 * - Whitespace normalization
 */
const DEFAULT_CONFIG = {
    enableOCRCleanup: true,
    enableHeaderFooterRemoval: true,
    enablePageNumberRemoval: true,
    headerFooterThreshold: 0.5, // Text must appear on 50%+ of pages
};
export class TextPreprocessor {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Run full preprocessing pipeline on pages
     */
    preprocess(pages, options) {
        const config = { ...this.config, ...options };
        const stats = {
            headersRemoved: 0,
            footersRemoved: 0,
            pageNumbersRemoved: 0,
            charactersRemoved: 0,
            originalLength: pages.reduce((sum, p) => sum + p.text.length, 0),
            processedLength: 0,
        };
        let result = pages;
        // Step 1: Detect and remove headers/footers
        if (config.enableHeaderFooterRemoval) {
            const headerFooterResult = this.removeHeadersFooters(result, config.headerFooterThreshold);
            result = headerFooterResult.pages;
            stats.headersRemoved = headerFooterResult.headersRemoved;
            stats.footersRemoved = headerFooterResult.footersRemoved;
        }
        // Step 2: Clean each page's text
        result = result.map((page) => {
            let text = page.text;
            const originalLength = text.length;
            // Page number removal
            if (config.enablePageNumberRemoval) {
                const cleaned = this.removePageNumbers(text);
                if (cleaned.length < text.length) {
                    stats.pageNumbersRemoved++;
                }
                text = cleaned;
            }
            // OCR cleanup
            if (config.enableOCRCleanup) {
                text = this.cleanOCRArtifacts(text);
            }
            stats.charactersRemoved += originalLength - text.length;
            return { ...page, text };
        });
        stats.processedLength = result.reduce((sum, p) => sum + p.text.length, 0);
        return { pages: result, stats };
    }
    /**
     * Clean OCR artifacts from text
     */
    cleanOCRArtifacts(text) {
        let cleaned = text;
        // Remove non-printable characters (except newlines and tabs)
        cleaned = cleaned.replace(/[^\p{L}\p{N}\p{P}\p{S}\s]/gu, '');
        // Fix common OCR issues: separated letters (e.g., "h e l l o" -> "hello")
        // Only for sequences of single letters separated by spaces
        cleaned = cleaned.replace(/\b(\p{L})\s+(?=\p{L}\s+\p{L}\b)/gu, '$1');
        // Remove pipe/line artifacts (common in scanned docs)
        cleaned = cleaned.replace(/[|l1I]{5,}/g, '');
        // Remove separator lines (dashes, underscores)
        cleaned = cleaned.replace(/[-_=]{5,}/g, '');
        // Collapse multiple spaces
        cleaned = cleaned.replace(/ {2,}/g, ' ');
        // Normalize newlines (max 2 consecutive)
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        // Remove lines that are only numbers or punctuation (likely OCR noise)
        cleaned = cleaned.replace(/^[0-9\s.,;:!?-]+$/gm, '');
        // Clean up empty lines
        cleaned = cleaned.replace(/^\s*\n/gm, '\n');
        return cleaned.trim();
    }
    /**
     * Remove page numbers from text
     */
    removePageNumbers(text) {
        // Match isolated numbers at start/end of lines (common page number positions)
        // Pattern: line with only a number (with optional whitespace)
        let cleaned = text.replace(/^\s*\d{1,4}\s*$/gm, '');
        // Pattern: "Page X" or "- X -" style page numbers
        cleaned = cleaned.replace(/^\s*[-–—]\s*\d+\s*[-–—]\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Page\s+\d+\s*$/gim, '');
        return cleaned;
    }
    /**
     * Detect and remove repeated headers/footers
     */
    removeHeadersFooters(pages, threshold = 0.5) {
        if (pages.length < 3) {
            // Not enough pages to detect patterns
            return { pages, headersRemoved: 0, footersRemoved: 0 };
        }
        const minOccurrences = Math.ceil(pages.length * threshold);
        // Extract first and last lines from each page
        const headers = [];
        const footers = [];
        for (const page of pages) {
            const lines = page.text.split('\n').filter((l) => l.trim().length > 0);
            if (lines.length > 0) {
                // Get first 2 lines (potential header)
                headers.push(this.normalizeLineForComparison(lines[0]));
                if (lines.length > 1) {
                    headers.push(this.normalizeLineForComparison(lines[1]));
                }
                // Get last 2 lines (potential footer)
                footers.push(this.normalizeLineForComparison(lines[lines.length - 1]));
                if (lines.length > 1) {
                    footers.push(this.normalizeLineForComparison(lines[lines.length - 2]));
                }
            }
        }
        // Count occurrences
        const headerCounts = this.countOccurrences(headers);
        const footerCounts = this.countOccurrences(footers);
        // Find repeated headers/footers
        const repeatedHeaders = new Set();
        const repeatedFooters = new Set();
        for (const [text, count] of headerCounts) {
            if (count >= minOccurrences && text.length > 3) {
                repeatedHeaders.add(text);
            }
        }
        for (const [text, count] of footerCounts) {
            if (count >= minOccurrences && text.length > 3) {
                repeatedFooters.add(text);
            }
        }
        // Remove detected headers/footers from pages
        let headersRemoved = 0;
        let footersRemoved = 0;
        const cleanedPages = pages.map((page) => {
            const lines = page.text.split('\n');
            const cleanedLines = [];
            for (let i = 0; i < lines.length; i++) {
                const normalized = this.normalizeLineForComparison(lines[i]);
                // Check if it's a repeated header (first 2 lines)
                if (i < 2 && repeatedHeaders.has(normalized)) {
                    headersRemoved++;
                    continue;
                }
                // Check if it's a repeated footer (last 2 lines)
                if (i >= lines.length - 2 && repeatedFooters.has(normalized)) {
                    footersRemoved++;
                    continue;
                }
                cleanedLines.push(lines[i]);
            }
            return { ...page, text: cleanedLines.join('\n') };
        });
        return { pages: cleanedPages, headersRemoved, footersRemoved };
    }
    // MARK: - Private Helpers
    /**
     * Normalize a line for comparison (case-insensitive, ignore page numbers)
     */
    normalizeLineForComparison(line) {
        return line
            .toLowerCase()
            .replace(/\d+/g, '#') // Replace numbers with placeholder
            .replace(/\s+/g, ' ')
            .trim();
    }
    /**
     * Count occurrences of each string
     */
    countOccurrences(items) {
        const counts = new Map();
        for (const item of items) {
            counts.set(item, (counts.get(item) || 0) + 1);
        }
        return counts;
    }
    /**
     * Simple cleanup without full preprocessing
     */
    quickClean(text) {
        return text
            .replace(/\s+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
}
