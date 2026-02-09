import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { Citation } from '../types/citation';

/**
 * Information about a modified PDF
 */
export interface ModifiedPDFInfo {
  citationId: string;
  citationTitle: string;
  filePath: string;
  reason: 'md5-changed' | 'file-modified' | 'file-missing';
  oldMD5?: string;
  newMD5?: string;
}

/**
 * Result of PDF modification detection
 */
export interface PDFModificationResult {
  modifiedPDFs: ModifiedPDFInfo[];
  totalChecked: number;
  totalModified: number;
}

/**
 * Service for detecting modified PDFs by comparing MD5 hashes
 *
 * Detects when local PDFs have been modified compared to their stored MD5 hashes.
 * This helps keep the RAG index up-to-date with the latest PDF content.
 */
export class PDFModificationDetector {
  /**
   * Check for modified PDFs in citations
   *
   * @param citations List of citations to check
   * @returns List of modified PDFs with details
   */
  async detectModifiedPDFs(citations: Citation[]): Promise<PDFModificationResult> {
    const modifiedPDFs: ModifiedPDFInfo[] = [];
    let totalChecked = 0;

    for (const citation of citations) {
      // Skip citations without PDF files
      if (!citation.file) continue;

      // Skip citations without Zotero attachments (no MD5 to compare)
      if (!citation.zoteroAttachments || citation.zoteroAttachments.length === 0) {
        continue;
      }

      totalChecked++;

      try {
        // Get stored MD5 hash from Zotero attachment
        const storedMD5 = this.getStoredMD5(citation);
        if (!storedMD5) continue;

        // Check if file exists
        try {
          await fs.access(citation.file);
        } catch {
          // File missing
          modifiedPDFs.push({
            citationId: citation.id,
            citationTitle: citation.title,
            filePath: citation.file,
            reason: 'file-missing',
            oldMD5: storedMD5,
          });
          continue;
        }

        // Calculate current MD5 hash
        const currentMD5 = await this.calculateMD5(citation.file);

        // Compare MD5 hashes
        if (storedMD5 !== currentMD5) {
          modifiedPDFs.push({
            citationId: citation.id,
            citationTitle: citation.title,
            filePath: citation.file,
            reason: 'md5-changed',
            oldMD5: storedMD5,
            newMD5: currentMD5,
          });
        }
      } catch (error) {
        console.error(`Failed to check PDF for citation ${citation.id}:`, error);
        // Continue checking other citations
      }
    }

    return {
      modifiedPDFs,
      totalChecked,
      totalModified: modifiedPDFs.length,
    };
  }

  /**
   * Get stored MD5 hash from citation's Zotero attachments
   */
  private getStoredMD5(citation: Citation): string | null {
    if (!citation.zoteroAttachments || citation.zoteroAttachments.length === 0) {
      return null;
    }

    // Find the attachment that matches the current file path
    const matchingAttachment = citation.zoteroAttachments.find((att: any) => {
      // The attachment should have the same filename
      if (att.filename && citation.file) {
        return citation.file.endsWith(att.filename);
      }
      return false;
    });

    if (matchingAttachment && matchingAttachment.md5) {
      return matchingAttachment.md5;
    }

    // If no matching attachment found, use the first attachment with MD5
    const firstWithMD5 = citation.zoteroAttachments.find((att: any) => att.md5);
    return firstWithMD5?.md5 || null;
  }

  /**
   * Calculate MD5 hash of a file
   */
  private async calculateMD5(filePath: string): Promise<string> {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const hash = crypto.createHash('md5');
      hash.update(fileBuffer);
      return hash.digest('hex');
    } catch (error) {
      console.error(`Failed to calculate MD5 for ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Calculate MD5 hash of a file (streaming for large files)
   */
  private async calculateMD5Stream(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = require('fs').createReadStream(filePath);

      stream.on('data', (data: Buffer) => {
        hash.update(data);
      });

      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });

      stream.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  /**
   * Update citation with new MD5 hash after re-indexation
   *
   * This would typically be called after successfully re-indexing a modified PDF
   * to update the stored MD5 hash to match the current file.
   */
  async updateMD5Hash(citation: Citation, filePath: string): Promise<string> {
    const newMD5 = await this.calculateMD5(filePath);

    // Update the citation's Zotero attachment MD5
    if (citation.zoteroAttachments && citation.zoteroAttachments.length > 0) {
      // Find matching attachment and update its MD5
      const matchingAttachment = citation.zoteroAttachments.find((att: any) => {
        if (att.filename && filePath) {
          return filePath.endsWith(att.filename);
        }
        return false;
      });

      if (matchingAttachment) {
        matchingAttachment.md5 = newMD5;
      } else {
        // Update first attachment with MD5
        const firstWithMD5 = citation.zoteroAttachments.find((att: any) => att.md5);
        if (firstWithMD5) {
          firstWithMD5.md5 = newMD5;
        }
      }
    }

    return newMD5;
  }
}
