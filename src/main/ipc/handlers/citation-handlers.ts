/**
 * Citation IPC handlers
 *
 * Surfaces {@link CitationEngine} (CSL formatting via citeproc-js) to the renderer:
 *   - citation:listStyles  → discover CSL styles bundled in resources/csl
 *   - citation:listLocales → discover locale files (locales-xx-XX.xml)
 *   - citation:format      → format a list of CSL-JSON items
 *   - citation:preview     → resolve a bibKey via bibliographyService, format one entry
 *
 * A single {@link CitationEngine} is shared across handlers (lazy init) so that
 * style/locale XML caches are reused between calls.
 */
import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { bibliographyService } from '../../services/bibliography-service.js';
import {
  CitationEngine,
  type CSLItem,
} from '../../../../backend/core/citation/CitationEngine.js';
import { citationToCSL } from '../../../../backend/core/citation/citationFromZotero.js';

/** Resolve the `resources/csl` folder for both dev and packaged builds. */
export function resolveCSLResourcesRoot(): string {
  // In packaged builds, electron-builder copies `resources/` under
  // process.resourcesPath. In dev we fall back to the repo root.
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'csl');
  }
  return path.join(process.cwd(), 'resources', 'csl');
}

let engineSingleton: CitationEngine | null = null;
function getEngine(): CitationEngine {
  if (!engineSingleton) {
    engineSingleton = new CitationEngine(resolveCSLResourcesRoot());
  }
  return engineSingleton;
}

/** Test-only: reset the engine singleton (used by __tests__). */
export function __resetCitationEngineForTests(): void {
  engineSingleton = null;
}

/** Test-only: inject a pre-built engine (used by __tests__). */
export function __setCitationEngineForTests(engine: CitationEngine | null): void {
  engineSingleton = engine;
}

interface StyleEntry {
  id: string;
  label: string;
}

/** Humanize a CSL style id for display: 'chicago-note-bibliography' → 'Chicago Note Bibliography'. */
function humanizeStyleId(id: string): string {
  return id
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function listCSLStyles(resourcesRoot: string): StyleEntry[] {
  if (!fs.existsSync(resourcesRoot)) return [];
  return fs
    .readdirSync(resourcesRoot)
    .filter((f) => f.endsWith('.csl'))
    .map((f) => f.slice(0, -'.csl'.length))
    .map((id) => ({ id, label: humanizeStyleId(id) }));
}

/** Scan resourcesRoot for `locales-xx-XX.xml` files. */
export function listCSLLocales(resourcesRoot: string): string[] {
  if (!fs.existsSync(resourcesRoot)) return [];
  return fs
    .readdirSync(resourcesRoot)
    .filter((f) => f.startsWith('locales-') && f.endsWith('.xml'))
    .map((f) => f.slice('locales-'.length, -'.xml'.length));
}

export function setupCitationHandlers(): void {
  ipcMain.handle('citation:listStyles', async () => {
    try {
      const styles = listCSLStyles(resolveCSLResourcesRoot());
      return successResponse({ styles });
    } catch (error) {
      console.error('❌ citation:listStyles error:', error);
      return { ...errorResponse(error), styles: [] };
    }
  });

  ipcMain.handle('citation:listLocales', async () => {
    try {
      const locales = listCSLLocales(resolveCSLResourcesRoot());
      return successResponse({ locales });
    } catch (error) {
      console.error('❌ citation:listLocales error:', error);
      return { ...errorResponse(error), locales: [] };
    }
  });

  ipcMain.handle(
    'citation:format',
    async (
      _event,
      rawItems: unknown,
      rawStyleId: unknown,
      rawLocale: unknown
    ) => {
      try {
        if (!Array.isArray(rawItems)) {
          throw new Error('citation:format — items must be an array');
        }
        if (typeof rawStyleId !== 'string' || !rawStyleId) {
          throw new Error('citation:format — styleId must be a non-empty string');
        }
        const locale =
          typeof rawLocale === 'string' && rawLocale ? rawLocale : 'en-US';
        const result = getEngine().formatCitation(
          rawItems as CSLItem[],
          rawStyleId,
          locale as 'fr-FR' | 'en-US'
        );
        return successResponse(result);
      } catch (error) {
        console.error('❌ citation:format error:', error);
        return { ...errorResponse(error), footnotes: [], bibliography: [] };
      }
    }
  );

  ipcMain.handle(
    'citation:preview',
    async (
      _event,
      rawBibKey: unknown,
      rawStyleId: unknown,
      rawLocale: unknown
    ) => {
      try {
        if (typeof rawBibKey !== 'string' || !rawBibKey) {
          throw new Error('citation:preview — bibKey must be a non-empty string');
        }
        if (typeof rawStyleId !== 'string' || !rawStyleId) {
          throw new Error('citation:preview — styleId must be a non-empty string');
        }
        const locale =
          typeof rawLocale === 'string' && rawLocale ? rawLocale : 'en-US';

        const all = bibliographyService.getCitations();
        const hit = all.find((c) => c.key === rawBibKey || c.id === rawBibKey);
        if (!hit) {
          throw new Error(`citation:preview — unknown bibKey "${rawBibKey}"`);
        }
        const cslItem = citationToCSL(hit);
        const result = getEngine().formatCitation(
          [cslItem],
          rawStyleId,
          locale as 'fr-FR' | 'en-US'
        );
        return successResponse({
          footnote: result.footnotes[0] ?? '',
          bibliography: result.bibliography[0] ?? '',
        });
      } catch (error) {
        console.error('❌ citation:preview error:', error);
        return { ...errorResponse(error), footnote: '', bibliography: '' };
      }
    }
  );

  console.log('✅ Citation handlers registered');
}
