/**
 * IPC handlers for source traceability (Brainstorm citation click-through).
 *
 * A retrieved RAG chunk is only trustworthy if the historian can jump back
 * to the exact page/photo/note it came from. These handlers are the thin
 * bridge between a `BrainstormSource` shown in the UI and the underlying
 * file, leveraging `shell.openPath` as a lowest-common-denominator opener.
 *
 * All handlers return `{ success, ...}` envelopes and fail soft — an
 * invalid or missing source is logged and surfaced to the renderer so
 * the UI can toast rather than crash. Path resolution is intentionally
 * conservative: we only open paths below the current project root, the
 * indexed PDF's original location, or the configured vault.
 *
 * Current behaviour (scaffold):
 *   - PDF: opens the PDF file via the OS default viewer. Jumping to a
 *     specific page requires a viewer that honours `#page=N`; most OS
 *     defaults do. Electron's `shell.openPath` ignores the fragment, so
 *     we also surface the computed URI in the response for the renderer
 *     to use with `shell.openExternal` when appropriate.
 *   - Tropy: returns the source record (with photo paths) for the
 *     renderer; deep-linking into the Tropy app itself is a TODO.
 *   - Obsidian: opens the note file via `shell.openPath`. An `obsidian://`
 *     URI variant is also returned so the renderer can attempt a deep
 *     link when the user has Obsidian installed.
 *
 * See docs/source-traceability.md for the roadmap.
 */

import { ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { projectManager } from '../../services/project-manager.js';
import { tropyService } from '../../services/tropy-service.js';
import { pdfService } from '../../services/pdf-service.js';
import { readWorkspaceConfig } from '../../../../backend/core/workspace/config.js';

interface VaultConfigBlock { path?: string }

function okFrom<T extends object>(data: T): { success: true } & T {
  return { success: true, ...data };
}
function errFrom(message: string): { success: false; error: string } {
  return { success: false, error: message };
}

/**
 * Open a PDF at a specific page. Uses the OS default viewer; page hashes
 * are included in the returned `uri` so the renderer can fall back to
 * `shell.openExternal` (which does honour `#page=N` in most browsers).
 */
async function openPdfAtPage(documentId: string, pageNumber?: number): Promise<{
  success: boolean;
  error?: string;
  filePath?: string;
  uri?: string;
}> {
  if (!documentId) return errFrom('missing documentId');
  try {
    const doc = await pdfService.getDocument(documentId);
    if (!doc) return errFrom('document_not_found');
    const filePath = doc.fileURL?.startsWith('file://')
      ? decodeURI(doc.fileURL.replace(/^file:\/\//, ''))
      : doc.fileURL;
    if (!filePath || !fs.existsSync(filePath)) {
      return errFrom('pdf_file_missing');
    }
    const uri = pageNumber
      ? `file://${filePath}#page=${pageNumber}`
      : `file://${filePath}`;
    const openErr = await shell.openPath(filePath);
    if (openErr) {
      console.warn('[sources] shell.openPath returned:', openErr);
      return { success: false, error: openErr, filePath, uri };
    }
    return okFrom({ filePath, uri });
  } catch (e) {
    console.error('[sources] openPdfAtPage failed:', e);
    return errFrom(e instanceof Error ? e.message : String(e));
  }
}

async function revealTropyItem(itemId: string): Promise<{
  success: boolean;
  error?: string;
  source?: unknown;
  firstPhotoPath?: string;
}> {
  if (!itemId) return errFrom('missing itemId');
  try {
    const source = tropyService.getSource(itemId);
    if (!source) return errFrom('tropy_source_not_found');
    // Best-effort: try to read the first photo from the DB to surface a
    // filesystem path the renderer can preview. Not all tropyService
    // builds expose getPhotos publicly; we degrade gracefully.
    let firstPhotoPath: string | undefined;
    try {
      const maybe = (
        tropyService as unknown as { getPhotos?: (id: string) => Array<{ path?: string }> }
      ).getPhotos?.(itemId);
      firstPhotoPath = maybe?.[0]?.path;
      if (firstPhotoPath && fs.existsSync(firstPhotoPath)) {
        // Reveal in OS file manager rather than open, so the user sees the
        // item in context (Tropy keeps sibling sidecar files).
        shell.showItemInFolder(firstPhotoPath);
      }
    } catch {
      // photo lookup is best-effort.
    }
    // TODO: deep-link into Tropy desktop app when a tropy:// scheme becomes
    // available (tracked in docs/source-traceability.md).
    return okFrom({ source, firstPhotoPath });
  } catch (e) {
    console.error('[sources] revealTropyItem failed:', e);
    return errFrom(e instanceof Error ? e.message : String(e));
  }
}

async function openObsidianNote(
  relativePath: string,
  lineNumber?: number
): Promise<{
  success: boolean;
  error?: string;
  absPath?: string;
  uri?: string;
}> {
  if (!relativePath) return errFrom('missing relativePath');
  const root = projectManager.getCurrentProjectPath();
  if (!root) return errFrom('no_project');
  try {
    const cfg = await readWorkspaceConfig(root);
    const vaultPath = (cfg.vault as VaultConfigBlock | undefined)?.path;
    if (!vaultPath) return errFrom('no_vault_configured');
    const absPath = path.resolve(vaultPath, relativePath);
    // Path-traversal guard: the resolved path must stay under the vault.
    if (!absPath.startsWith(path.resolve(vaultPath) + path.sep)) {
      return errFrom('path_outside_vault');
    }
    if (!fs.existsSync(absPath)) return errFrom('note_not_found');
    // Obsidian URI scheme: encode vault name + file path.
    const vaultName = path.basename(vaultPath);
    const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(
      relativePath.replace(/\.md$/i, '')
    )}`;
    // Try the Obsidian deep link first; if the user has Obsidian, it will
    // jump to the note (and honour the line anchor once Obsidian supports
    // it). Fall back to the bare file on any failure.
    try {
      await shell.openExternal(uri);
    } catch {
      const err = await shell.openPath(absPath);
      if (err) return { success: false, error: err, absPath, uri };
    }
    // lineNumber is informational until Obsidian exposes a #L anchor in
    // its URI scheme.
    void lineNumber;
    return okFrom({ absPath, uri });
  } catch (e) {
    console.error('[sources] openObsidianNote failed:', e);
    return errFrom(e instanceof Error ? e.message : String(e));
  }
}

export function setupSourcesHandlers(): void {
  ipcMain.handle('sources:open-pdf', async (_e, rawId: unknown, rawPage?: unknown) => {
    const id = typeof rawId === 'string' ? rawId : '';
    const page = typeof rawPage === 'number' ? rawPage : undefined;
    return openPdfAtPage(id, page);
  });

  ipcMain.handle('sources:reveal-tropy', async (_e, rawId: unknown) => {
    const id = typeof rawId === 'string' ? rawId : '';
    return revealTropyItem(id);
  });

  ipcMain.handle('sources:open-note', async (_e, rawRel: unknown, rawLine?: unknown) => {
    const rel = typeof rawRel === 'string' ? rawRel : '';
    const line = typeof rawLine === 'number' ? rawLine : undefined;
    return openObsidianNote(rel, line);
  });
}

// Exposed for unit tests.
export const __test = { openPdfAtPage, revealTropyItem, openObsidianNote };
