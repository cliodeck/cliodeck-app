import * as fs from 'fs/promises';
import * as path from 'path';
import { Citation } from '../types/citation.js';

/**
 * Information about an orphan PDF file
 */
export interface OrphanPDFInfo {
  filePath: string;
  fileName: string;
  size: number; // in bytes
  lastModified: Date;
}

/**
 * Result of orphan PDF detection scan
 */
export interface OrphanPDFScanResult {
  orphans: OrphanPDFInfo[];
  totalOrphans: number;
  totalSize: number; // total size of all orphans in bytes
  scannedFiles: number;
  linkedFiles: number;
}

/**
 * Options for orphan PDF detection
 */
export interface OrphanDetectionOptions {
  projectPath: string;
  citations: Citation[];
  includeSubdirectories?: boolean; // default: true
  pdfSubdirectory?: string; // subdirectory to scan (e.g., 'pdfs'), if not provided scans whole project
}

/**
 * Service for detecting and managing orphan PDF files
 *
 * An orphan PDF is a PDF file in the project directory that is not linked
 * to any citation in the bibliography.
 */
export class OrphanPDFDetector {
  /**
   * Detect orphan PDFs in the project directory
   */
  async detectOrphans(options: OrphanDetectionOptions): Promise<OrphanPDFScanResult> {
    const { projectPath, citations, includeSubdirectories = true, pdfSubdirectory } = options;

    // Build set of linked PDF paths for O(1) lookup
    const linkedPaths = new Set<string>();
    citations.forEach((citation) => {
      if (citation.file) {
        // Normalize paths to absolute paths
        const absolutePath = path.isAbsolute(citation.file)
          ? citation.file
          : path.join(projectPath, citation.file);
        linkedPaths.add(path.normalize(absolutePath));
      }
    });

    // Determine scan directory
    const scanDir = pdfSubdirectory
      ? path.join(projectPath, pdfSubdirectory)
      : projectPath;

    // Check if scan directory exists
    try {
      await fs.access(scanDir);
    } catch (error) {
      // Directory doesn't exist, return empty result
      return {
        orphans: [],
        totalOrphans: 0,
        totalSize: 0,
        scannedFiles: 0,
        linkedFiles: linkedPaths.size,
      };
    }

    // Scan for PDF files
    const pdfFiles = await this.scanForPDFs(scanDir, includeSubdirectories);

    // Identify orphans
    const orphans: OrphanPDFInfo[] = [];
    let totalSize = 0;

    for (const pdfPath of pdfFiles) {
      const normalizedPath = path.normalize(pdfPath);

      // Check if this PDF is linked to any citation
      if (!linkedPaths.has(normalizedPath)) {
        try {
          const stats = await fs.stat(pdfPath);
          const orphan: OrphanPDFInfo = {
            filePath: pdfPath,
            fileName: path.basename(pdfPath),
            size: stats.size,
            lastModified: stats.mtime,
          };
          orphans.push(orphan);
          totalSize += stats.size;
        } catch (error) {
          // File might have been deleted between scan and stat, skip it
          console.warn(`Failed to stat file ${pdfPath}:`, error);
        }
      }
    }

    return {
      orphans,
      totalOrphans: orphans.length,
      totalSize,
      scannedFiles: pdfFiles.length,
      linkedFiles: linkedPaths.size,
    };
  }

  /**
   * Delete orphan PDF files
   *
   * @param filePaths Array of absolute file paths to delete
   * @returns Result with success/failure counts
   */
  async deleteOrphans(filePaths: string[]): Promise<{
    deleted: number;
    failed: { path: string; error: string }[];
  }> {
    const failed: { path: string; error: string }[] = [];
    let deleted = 0;

    for (const filePath of filePaths) {
      try {
        // Additional safety check: verify file is a PDF
        if (!filePath.toLowerCase().endsWith('.pdf')) {
          failed.push({
            path: filePath,
            error: 'Not a PDF file',
          });
          continue;
        }

        // Check file exists before deletion
        try {
          await fs.access(filePath);
        } catch {
          failed.push({
            path: filePath,
            error: 'File not found',
          });
          continue;
        }

        // Delete the file
        await fs.unlink(filePath);
        deleted++;
      } catch (error) {
        failed.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { deleted, failed };
  }

  /**
   * Move orphan PDFs to a subdirectory (safer than deletion)
   *
   * @param filePaths Array of absolute file paths to move
   * @param projectPath Project root directory
   * @param archiveSubdir Subdirectory name for archived files (default: 'orphan_pdfs')
   * @returns Result with success/failure counts
   */
  async archiveOrphans(
    filePaths: string[],
    projectPath: string,
    archiveSubdir: string = 'orphan_pdfs'
  ): Promise<{
    archived: number;
    failed: { path: string; error: string }[];
    archivePath: string;
  }> {
    const archivePath = path.join(projectPath, archiveSubdir);
    const failed: { path: string; error: string }[] = [];
    let archived = 0;

    // Create archive directory if it doesn't exist
    try {
      await fs.mkdir(archivePath, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create archive directory: ${error}`);
    }

    for (const filePath of filePaths) {
      try {
        // Additional safety check: verify file is a PDF
        if (!filePath.toLowerCase().endsWith('.pdf')) {
          failed.push({
            path: filePath,
            error: 'Not a PDF file',
          });
          continue;
        }

        // Check file exists
        try {
          await fs.access(filePath);
        } catch {
          failed.push({
            path: filePath,
            error: 'File not found',
          });
          continue;
        }

        const fileName = path.basename(filePath);
        const targetPath = path.join(archivePath, fileName);

        // If target exists, add timestamp to avoid collision
        let finalTargetPath = targetPath;
        try {
          await fs.access(finalTargetPath);
          const timestamp = Date.now();
          const ext = path.extname(fileName);
          const baseName = path.basename(fileName, ext);
          finalTargetPath = path.join(archivePath, `${baseName}_${timestamp}${ext}`);
        } catch {
          // File doesn't exist, use original target path
        }

        // Move the file
        await fs.rename(filePath, finalTargetPath);
        archived++;
      } catch (error) {
        failed.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { archived, failed, archivePath };
  }

  /**
   * Recursively scan directory for PDF files
   *
   * @param dirPath Directory to scan
   * @param recursive Whether to scan subdirectories
   * @returns Array of absolute PDF file paths
   */
  private async scanForPDFs(dirPath: string, recursive: boolean): Promise<string[]> {
    const pdfFiles: string[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules, .git, and hidden directories
          if (
            entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name.startsWith('.')
          ) {
            continue;
          }

          if (recursive) {
            const subDirPDFs = await this.scanForPDFs(fullPath, recursive);
            pdfFiles.push(...subDirPDFs);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
          pdfFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dirPath}:`, error);
    }

    return pdfFiles;
  }

  /**
   * Format file size to human-readable string
   */
  static formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
  }
}
