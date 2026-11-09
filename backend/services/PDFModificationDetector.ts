import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import type { Citation, ZoteroAttachmentInfo } from '../types/citation';
import { isPdfPath } from '../core/bibliography/pdf-attachment';
import { sameFile } from '../core/vector-store/file-identity';

/**
 * Information about a modified PDF
 */
export interface ModifiedPDFInfo {
  citationId: string;
  /** Avec `attachmentKey`, désigne la pièce jointe dont le projet retient la réponse (`signaledMd5`). */
  zoteroKey?: string;
  attachmentKey: string;
  citationTitle: string;
  filePath: string;
  reason: 'md5-changed' | 'file-modified';
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
 * Le MD5 auquel l'historien a déjà répondu pour cette pièce jointe (réindexé, ou ignoré), lu dans
 * les métadonnées du projet. Un PDF qui a toujours ce MD5 n'est plus signalé.
 */
export type SignaledMd5Lookup = (citation: Citation, attachmentKey: string) => string | undefined;

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
   * @param signaledMd5 ce que le projet a déjà signalé, par pièce jointe
   * @returns List of modified PDFs with details
   */
  async detectModifiedPDFs(
    citations: Citation[],
    signaledMd5: SignaledMd5Lookup = () => undefined
  ): Promise<PDFModificationResult> {
    const modifiedPDFs: ModifiedPDFInfo[] = [];
    let totalChecked = 0;

    for (const citation of citations) {
      // Un instantané HTML hérité n'est pas un PDF (CLAUDE.md §6) : comparé au MD5 du PDF joint, il
      // serait « modifié » à chaque vérification.
      const file = citation.file;
      if (!isPdfPath(file)) continue;

      // Sans pièce jointe qui corresponde au fichier, ou sans MD5 (Zotero en mode local), rien à comparer.
      const attachment = this.attachmentOf(citation, file);
      if (!attachment?.md5) continue;

      try {
        // Absent : réindexer n'y peut rien, ce n'est pas un PDF modifié.
        try {
          await fs.access(file);
        } catch {
          continue;
        }

        totalChecked++;
        const currentMD5 = await this.calculateMD5Stream(file);
        if (currentMD5 === attachment.md5) continue;
        // Déjà signalé avec ce contenu, et l'historien a répondu : il ne revient que si le fichier change encore.
        if (signaledMd5(citation, attachment.key) === currentMD5) continue;

        modifiedPDFs.push({
          citationId: citation.id,
          zoteroKey: citation.zoteroKey,
          attachmentKey: attachment.key,
          citationTitle: citation.title,
          filePath: file,
          reason: 'md5-changed',
          oldMD5: attachment.md5,
          newMD5: currentMD5,
        });
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
   * La pièce jointe dont `file` est le PDF, et aucune autre : celle qui l'a téléchargé (`localPath`,
   * résolu en absolu au chargement), sinon, parmi celles qui n'ont pas été téléchargées dans le
   * projet, celle qui porte son nom (le PDF de Zotero lui-même). Une pièce jointe téléchargée sous un
   * autre nom n'est pas celle d'un homonyme de `PDFs/` : ce serait comparer le PDF d'une autre
   * référence au MD5 de la sienne.
   */
  private attachmentOf(citation: Citation, file: string): ZoteroAttachmentInfo | undefined {
    const attachments = citation.zoteroAttachments ?? [];
    return (
      attachments.find((att) => att.localPath && sameFile(att.localPath, file)) ??
      attachments.find((att) => !att.localPath && att.filename === path.basename(file))
    );
  }

  /**
   * MD5 d'un fichier, lu en flux : un PDF de plusieurs centaines de Mo n'est jamais en mémoire d'un bloc.
   */
  private calculateMD5Stream(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = createReadStream(filePath);

      stream.on('data', (data) => {
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
}
