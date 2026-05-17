import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseObsidianNote, importVaultAsIdeas } from '../obsidian-to-ideas.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-ideas-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseObsidianNote', () => {
  it('extracts title from filename', () => {
    const file = path.join(tmpDir, 'My Note.md');
    fs.writeFileSync(file, 'Hello world');
    const idea = parseObsidianNote(file);
    expect(idea.title).toBe('My Note');
  });

  it('extracts frontmatter tags (array format)', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, '---\ntags: [history, wwi, france]\n---\nContent here');
    const idea = parseObsidianNote(file);
    expect(idea.tags).toContain('history');
    expect(idea.tags).toContain('wwi');
    expect(idea.tags).toContain('france');
  });

  it('extracts frontmatter tags (list format)', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, '---\ntags:\n  - revolution\n  - 1789\n---\nBody');
    const idea = parseObsidianNote(file);
    expect(idea.tags).toContain('revolution');
    expect(idea.tags).toContain('1789');
  });

  it('extracts inline #tags from body', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, 'This is about #history and #france in the #nineteenth-century');
    const idea = parseObsidianNote(file);
    expect(idea.tags).toContain('history');
    expect(idea.tags).toContain('france');
    expect(idea.tags).toContain('nineteenth-century');
  });

  it('extracts wikilinks', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, 'See [[Karl Marx]] and [[Das Kapital|Capital]].');
    const idea = parseObsidianNote(file);
    expect(idea.wikilinks).toContain('Karl Marx');
    expect(idea.wikilinks).toContain('Das Kapital');
  });

  it('deduplicates tags from frontmatter and body', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, '---\ntags: [history]\n---\nMore about #history here');
    const idea = parseObsidianNote(file);
    expect(idea.tags.filter((t) => t === 'history')).toHaveLength(1);
  });

  it('strips frontmatter from content', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, '---\ntags: [a]\n---\nActual content');
    const idea = parseObsidianNote(file);
    expect(idea.content).toBe('Actual content');
    expect(idea.content).not.toContain('---');
  });
});

describe('importVaultAsIdeas', () => {
  it('imports all .md files from a vault', async () => {
    fs.writeFileSync(path.join(tmpDir, 'note1.md'), 'First note');
    fs.writeFileSync(path.join(tmpDir, 'note2.md'), 'Second note');
    fs.mkdirSync(path.join(tmpDir, '.obsidian'));
    fs.writeFileSync(path.join(tmpDir, '.obsidian', 'app.json'), '{}');

    const ideas = await importVaultAsIdeas(tmpDir);
    expect(ideas).toHaveLength(2);
  });

  it('skips .obsidian and .trash directories', async () => {
    fs.writeFileSync(path.join(tmpDir, 'good.md'), 'Keep');
    fs.mkdirSync(path.join(tmpDir, '.obsidian'));
    fs.writeFileSync(path.join(tmpDir, '.obsidian', 'skip.md'), 'Skip me');
    fs.mkdirSync(path.join(tmpDir, '.trash'));
    fs.writeFileSync(path.join(tmpDir, '.trash', 'deleted.md'), 'Deleted');

    const ideas = await importVaultAsIdeas(tmpDir);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].title).toBe('good');
  });

  it('respects maxFiles limit', async () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `note${i}.md`), `Content ${i}`);
    }
    const ideas = await importVaultAsIdeas(tmpDir, { maxFiles: 3 });
    expect(ideas).toHaveLength(3);
  });
});
