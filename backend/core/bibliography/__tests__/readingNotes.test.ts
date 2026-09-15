import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  READING_NOTES_DIR,
  ensureReadingNote,
  findReadingNote,
  followRenamedCitekeys,
  listReadingNotes,
  noteFileName,
  readReadingNote,
  setProjectTags,
} from '../readingNotes';

const braudel = {
  citekey: 'Braudel_1949',
  zoteroKey: 'ABCD1234',
  title: 'La Méditerranée et le monde méditerranéen : à l’époque de Philippe II',
  author: 'Braudel, Fernand',
  year: '1949',
};

describe('notes de lecture', () => {
  let project: string;
  const notesDir = () => path.join(project, READING_NOTES_DIR);

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), 'cliodeck-notes-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('crée une note lisible, identifiée par son front matter', async () => {
    const file = await ensureReadingNote(project, braudel);

    expect(file).toBe(path.join(notesDir(), 'Braudel_1949.md'));
    const content = readFileSync(file, 'utf-8');
    expect(content).toMatch(/^---\ncitekey: Braudel_1949\nzotero_key: ABCD1234\ntitle: /);
    expect(content).toContain('# Braudel, Fernand — La Méditerranée');
    expect(await listReadingNotes(project)).toEqual([
      { file, citekey: 'Braudel_1949', zoteroKey: 'ABCD1234', tags: [] },
    ]);
  });

  it('ne réécrit jamais une note existante en l’ouvrant', async () => {
    const file = await ensureReadingNote(project, braudel);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}Longue durée, conjoncture, événement.\n`);
    const before = readFileSync(file, 'utf-8');

    expect(await ensureReadingNote(project, braudel)).toBe(file);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('écrit les étiquettes du projet sans toucher au texte ni aux ajouts manuels', async () => {
    const file = await ensureReadingNote(project, braudel);
    const edited = readFileSync(file, 'utf-8').replace('---\n', '---\nlu_le: 2026-09-14\n') + 'Ma lecture.\n';
    writeFileSync(file, edited);

    const info = await setProjectTags(project, braudel, ['chapitre-2', ' contre-argument ', 'chapitre-2']);

    expect(info.tags).toEqual(['chapitre-2', 'contre-argument']);
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('tags:\n  - chapitre-2\n  - contre-argument');
    // Valeur saisie à la main, rendue à l'identique.
    expect(content).toContain('lu_le: 2026-09-14\n');
    expect(content.endsWith('Ma lecture.\n')).toBe(true);
  });

  it('retire la clé `tags` quand il n’y a plus d’étiquette', async () => {
    await setProjectTags(project, braudel, ['chapitre-2']);
    await setProjectTags(project, braudel, []);

    const content = readFileSync(path.join(notesDir(), 'Braudel_1949.md'), 'utf-8');
    expect(content).not.toContain('tags');
  });

  it('retrouve une note renommée à la main par sa clé Zotero', async () => {
    const file = await ensureReadingNote(project, braudel);
    const renamed = path.join(notesDir(), 'Braudel — Méditerranée.md');
    renameSync(file, renamed);

    const notes = await listReadingNotes(project);

    expect(findReadingNote(notes, { citekey: 'Autre_clé', zoteroKey: 'ABCD1234' })?.file).toBe(renamed);
  });

  it('ne confond pas deux œuvres qui ont eu la même clé de citation', async () => {
    await ensureReadingNote(project, braudel);
    const notes = await listReadingNotes(project);

    expect(findReadingNote(notes, { citekey: 'Braudel_1949', zoteroKey: 'AUTRE999' })).toBeUndefined();
  });

  it('suit une clé refaite par la synchronisation : front matter et nom de fichier', async () => {
    await setProjectTags(project, { ...braudel, citekey: 'Braudel_' }, ['à-relire']);

    await followRenamedCitekeys(project, [{ zoteroKey: 'ABCD1234', from: 'Braudel_', to: 'Braudel_1949' }]);

    const notes = await listReadingNotes(project);
    expect(notes).toHaveLength(1);
    expect(path.basename(notes[0].file)).toBe('Braudel_1949.md');
    expect(notes[0].citekey).toBe('Braudel_1949');
    expect(notes[0].tags).toEqual(['à-relire']);
  });

  it('ne renomme pas un fichier dont le nom a été choisi à la main', async () => {
    const file = await ensureReadingNote(project, { ...braudel, citekey: 'Braudel_' });
    const mine = path.join(notesDir(), 'ma-lecture-de-braudel.md');
    renameSync(file, mine);

    await followRenamedCitekeys(project, [{ zoteroKey: 'ABCD1234', from: 'Braudel_', to: 'Braudel_1949' }]);

    expect(existsSync(mine)).toBe(true);
    expect(readFileSync(mine, 'utf-8')).toContain('citekey: Braudel_1949');
  });

  it('n’écrase pas un fichier du même nom écrit à la main', async () => {
    mkdirSync(notesDir(), { recursive: true });
    writeFileSync(path.join(notesDir(), 'Braudel_1949.md'), 'Brouillon sans front matter.\n');

    const file = await ensureReadingNote(project, braudel);

    expect(path.basename(file)).toBe('Braudel_1949-2.md');
    expect(readFileSync(path.join(notesDir(), 'Braudel_1949.md'), 'utf-8')).toBe('Brouillon sans front matter.\n');
  });

  it('ignore les fichiers illisibles au lieu de tout faire échouer', async () => {
    mkdirSync(notesDir(), { recursive: true });
    writeFileSync(path.join(notesDir(), 'casse.md'), '---\ntags: [non fermé\n---\nTexte\n');
    await ensureReadingNote(project, braudel);

    const notes = await listReadingNotes(project);

    expect(notes.map((n) => n.citekey)).toEqual(['Braudel_1949']);
  });

  it('refuse de réécrire une note au front matter illisible', async () => {
    const file = await ensureReadingNote(project, braudel);
    writeFileSync(file, '---\ncitekey: Braudel_1949\nzotero_key: ABCD1234\ntags: [non fermé\n---\nTexte précieux\n');

    await expect(setProjectTags(project, braudel, ['x'])).rejects.toThrow(/illisible/);
    expect(readFileSync(file, 'utf-8')).toContain('Texte précieux');
    // Et pas de seconde note créée à côté.
    expect(existsSync(path.join(notesDir(), 'Braudel_1949-2.md'))).toBe(false);
  });

  it('donne des noms de fichier valides sous Windows', () => {
    expect(noteFileName('doi:10.1000/xyz')).toBe('doi-10.1000-xyz.md');
    expect(noteFileName('..')).toBe('reference.md');
  });
});

describe('lecture d’une note pour l’indexer', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), 'cliodeck-notes-read-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('rend identité, étiquettes, corps et ligne de départ du corps', async () => {
    await setProjectTags(project, braudel, ['chapitre-2']);
    const file = path.join(project, READING_NOTES_DIR, 'Braudel_1949.md');
    writeFileSync(file, `${readFileSync(file, 'utf-8')}La longue durée.\n`);

    const note = await readReadingNote(file);

    expect(note).toMatchObject({ citekey: 'Braudel_1949', zoteroKey: 'ABCD1234', tags: ['chapitre-2'] });
    expect(note?.title).toContain('La Méditerranée');
    expect(note?.body.trim().endsWith('La longue durée.')).toBe(true);
    // La ligne indiquée est bien celle du corps dans le fichier.
    const lines = readFileSync(file, 'utf-8').split('\n');
    expect(lines.slice(note!.bodyStartLine - 1).join('\n')).toBe(note!.body);
  });

  it('ignore un fichier qui n’est pas une note de ClioDeck', async () => {
    mkdirSync(path.join(project, READING_NOTES_DIR), { recursive: true });
    const file = path.join(project, READING_NOTES_DIR, 'brouillon.md');
    writeFileSync(file, 'Juste du texte.\n');
    expect(await readReadingNote(file)).toBeNull();
  });
});
