/**
 * `.cliodeck` lié hors du projet (D18), vu du cache de similarité : « Vider le cache » supprimait
 * le fichier de l'autre bout du lien, et une analyse l'y réécrivait. Vrai service, vrai disque.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

vi.mock('../pdf-service.js', () => ({ pdfService: {} }));
vi.mock('../project-manager.js', () => ({ projectManager: { getCurrentProjectPath: () => null } }));

import { similarityService, type SimilarityCache } from '../similarity-service.js';

let workDir: string;
let root: string;
let outside: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-lie-'));
  root = path.join(workDir, 'Thèse');
  outside = path.join(workDir, 'ailleurs');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!symlinkAvailable)('cache de similarité — .cliodeck lié hors du projet', () => {
  it('ni lu, ni réécrit, ni supprimé à l’autre bout', async () => {
    const theirs = path.join(outside, 'similarity_cache.json');
    const content = JSON.stringify({ documentHash: 'autre', segments: {} });
    fs.writeFileSync(theirs, content);
    fs.symlinkSync(outside, path.join(root, '.cliodeck'));

    expect(await similarityService.loadCache(root)).toBeNull();
    await similarityService.saveCache(root, { documentHash: 'x', segments: {} } as unknown as SimilarityCache);
    await similarityService.clearCache(root);

    expect(fs.readFileSync(theirs, 'utf8')).toBe(content);
  });

  it('témoin : un vrai dossier .cliodeck garde son cache', async () => {
    fs.mkdirSync(path.join(root, '.cliodeck'));
    await similarityService.saveCache(root, { documentHash: 'x', segments: {} } as unknown as SimilarityCache);
    expect(fs.existsSync(path.join(root, '.cliodeck', 'similarity_cache.json'))).toBe(true);
  });
});
