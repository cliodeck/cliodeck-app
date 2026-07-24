import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Régression #27 : « unlink vault » supprimait le fichier brain.db entier,
// emportant les index PDF/Tropy et le journal. La purge doit être scopée
// aux tables obsidian_* et laisser les autres domaines intacts.
describe.skipIf(!sqliteAvailable)('ObsidianVaultStore.purgeObsidianData (#27)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-purge-'));
    dbPath = path.join(dir, 'brain.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops only the obsidian_* tables, keeps other domains and the file', async () => {
    const { ObsidianVaultStore } = await import('../ObsidianVaultStore.js');
    const Database = (await import('better-sqlite3')).default;

    // Peuple le domaine obsidian via le store réel…
    const store = new ObsidianVaultStore({ dbPath, dimension: 4 });
    store.upsertNote({
      id: 'n1',
      relativePath: 'note.md',
      vaultPath: '/vault',
      title: 'Note',
      tags: [],
      frontmatter: {},
      wikilinks: [],
      fileHash: 'h',
      fileMtime: 1,
      indexedAt: '2026-01-01T00:00:00Z',
    });
    store.close();

    // …et simule un autre domaine partageant le même fichier.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE IF NOT EXISTS pdf_documents (id TEXT PRIMARY KEY);
              INSERT INTO pdf_documents (id) VALUES ('doc1');`);
    raw.close();

    ObsidianVaultStore.purgeObsidianData(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);
    const check = new Database(dbPath);
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name LIKE 'obsidian_%'")
      .all() as Array<{ name: string }>;
    const pdfCount = check.prepare('SELECT COUNT(*) AS c FROM pdf_documents').get() as {
      c: number;
    };
    check.close();

    expect(tables).toHaveLength(0);
    expect(pdfCount.c).toBe(1);
  });

  it('is a no-op when the db file does not exist', async () => {
    const { ObsidianVaultStore } = await import('../ObsidianVaultStore.js');
    expect(() => ObsidianVaultStore.purgeObsidianData(dbPath)).not.toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
