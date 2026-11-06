/**
 * S09-1-13 : un coffre qui contient le projet indexait `reading-notes/*.md` et `document.md`
 * comme notes Obsidian. Le lecteur les laisse de côté ; les autres notes du coffre restent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ObsidianVaultReader } from '../ObsidianVaultReader.js';
import { authorTextInVault } from '../author-text-exclusions.js';

let vault = '';

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-lecteur-'));
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const target = path.join(vault, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('ObsidianVaultReader — coffre qui contient le projet', () => {
  it('le scan laisse reading-notes et document.md, garde les autres notes', async () => {
    write('Journal/2026-11-06.md', '# Journal\n');
    write('these/reading-notes/Braudel_1949.md', '# Braudel\n');
    write('these/document.md', '# Article\n');
    write('these/idees.md', '# Idées\n');
    write('these/reading-notes-archive/vieux.md', '# Vieux\n');

    const project = path.join(vault, 'these');
    const reader = new ObsidianVaultReader(vault, [], authorTextInVault(vault, project));
    const scanned = (await reader.scan()).map((e) => e.relativePath).sort();

    expect(scanned).toEqual([
      'Journal/2026-11-06.md',
      'these/idees.md',
      'these/reading-notes-archive/vieux.md',
    ]);
  });

  it('sans exclusion, rien ne change', async () => {
    write('a.md', '# A\n');
    write('reading-notes/b.md', '# B\n');
    const reader = new ObsidianVaultReader(vault);
    const scanned = (await reader.scan()).map((e) => e.relativePath).sort();
    expect(scanned).toEqual(['a.md', 'reading-notes/b.md']);
  });
});
