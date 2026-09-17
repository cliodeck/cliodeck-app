/**
 * Bilan de santé d'un projet : chaque invariant doit repérer l'écart qu'il
 * vise, et le bilan ne doit rien écrire (ni dans la base, ni à côté).
 *
 * Projet synthétique : brain.db créé avec node:sqlite (pas de binding natif,
 * donc pas de garde d'ABI), fichiers écrits dans un dossier temporaire.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { bibEntryKeys, openBrainDb, runHealthChecks } from '../project-health/checks.mjs';

type Finding = { domaine: string; niveau: 'ok' | 'ecart' | 'info'; message: string; aide?: string };

let root = '';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const write = (rel: string, content: string) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

function createBrain(setup: (db: DatabaseSync) => void): string {
  const dbPath = path.join(root, '.cliodeck', 'brain.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE pdf_documents (id TEXT PRIMARY KEY, file_path TEXT);
    CREATE TABLE pdf_chunks (id TEXT PRIMARY KEY, document_id TEXT, embedding BLOB);
    CREATE TABLE tropy_projects (id TEXT PRIMARY KEY, tpy_path TEXT, name TEXT, last_sync TEXT, auto_sync INTEGER);
    CREATE TABLE tropy_sources (id TEXT PRIMARY KEY, transcription TEXT);
    CREATE TABLE tropy_chunks (id TEXT PRIMARY KEY, source_id TEXT, embedding BLOB);
    CREATE TABLE manuscript_chapters (id TEXT PRIMARY KEY, relative_path TEXT, content_hash TEXT);
    CREATE TABLE manuscript_chunks (id TEXT PRIMARY KEY, chapter_id TEXT, embedding BLOB);
    CREATE TABLE reading_notes (id TEXT PRIMARY KEY, relative_path TEXT, content_hash TEXT);
    CREATE TABLE reading_notes_chunks (id TEXT PRIMARY KEY, note_id TEXT, embedding BLOB);
  `);
  setup(db);
  db.close();
  return dbPath;
}

async function check(): Promise<Finding[]> {
  const { db } = await openBrainDb(path.join(root, '.cliodeck', 'brain.db'));
  try {
    return runHealthChecks(root, db) as Finding[];
  } finally {
    db.close();
  }
}

const ecarts = (f: Finding[], domaine: string) => f.filter((x) => x.domaine === domaine && x.niveau === 'ecart');
const vec = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-health-'));
  write('project.json', JSON.stringify({ name: 'Test', type: 'article', bibliographySource: { type: 'zotero', filePath: 'bibliography.bib' } }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bilan de santé — projet sain', () => {
  it('ne relève aucun écart quand tout est aligné', async () => {
    const pdf = write('PDFs/a.pdf', '%PDF-1.4');
    const doc = write('document.md', '# Texte\n');
    const note = write('reading-notes/Braudel_1949.md', '---\ncitekey: Braudel_1949\n---\nNote.');
    write('bibliography.bib', '@book{Braudel_1949,\n title={La Méditerranée}\n}\n');
    const tpy = write('archives/p.tpy', 'x');
    createBrain((db) => {
      db.prepare('INSERT INTO pdf_documents VALUES (?, ?)').run('d1', pdf);
      db.prepare('INSERT INTO pdf_chunks VALUES (?, ?, ?)').run('c1', 'd1', vec);
      db.prepare('INSERT INTO tropy_projects VALUES (?, ?, ?, ?, ?)').run('p1', tpy, 'p', 'now', 0);
      db.prepare('INSERT INTO tropy_sources VALUES (?, ?)').run('s1', 'transcription');
      db.prepare('INSERT INTO tropy_chunks VALUES (?, ?, ?)').run('t1', 's1', vec);
      db.prepare('INSERT INTO manuscript_chapters VALUES (?, ?, ?)').run('m1', 'document.md', sha(fs.readFileSync(doc, 'utf8')));
      db.prepare('INSERT INTO manuscript_chunks VALUES (?, ?, ?)').run('mc1', 'm1', vec);
      db.prepare('INSERT INTO reading_notes VALUES (?, ?, ?)').run('n1', 'reading-notes/Braudel_1949.md', sha(fs.readFileSync(note, 'utf8')));
      db.prepare('INSERT INTO reading_notes_chunks VALUES (?, ?, ?)').run('nc1', 'n1', vec);
    });
    const findings = await check();
    expect(findings.filter((f) => f.niveau === 'ecart')).toEqual([]);
  });
});

describe('bilan de santé — chaque invariant repère son écart', () => {
  it('PDF : doublons, fichier disparu, extrait sans embedding, document vide', async () => {
    const pdf = write('PDFs/a.pdf', '%PDF-1.4');
    createBrain((db) => {
      db.prepare('INSERT INTO pdf_documents VALUES (?, ?)').run('d1', pdf);
      db.prepare('INSERT INTO pdf_documents VALUES (?, ?)').run('d2', pdf);
      db.prepare('INSERT INTO pdf_documents VALUES (?, ?)').run('d3', path.join(root, 'PDFs/parti.pdf'));
      db.prepare('INSERT INTO pdf_chunks VALUES (?, ?, ?)').run('c1', 'd1', null);
      db.prepare('INSERT INTO pdf_chunks VALUES (?, ?, ?)').run('c2', 'd3', vec);
    });
    const messages = ecarts(await check(), 'pdf').map((f) => f.message).join('\n');
    expect(messages).toMatch(/3 documents pour 2 fichiers/);
    expect(messages).toMatch(/fichier n’existe plus : parti\.pdf/);
    expect(messages).toMatch(/1 sans embedding/);
    expect(messages).toMatch(/1 document\(s\) sans aucun extrait/);
  });

  it('Tropy : transcription sans extraits, et projet lié en double', async () => {
    const tpy = write('archives/p.tpy', 'x');
    createBrain((db) => {
      db.prepare('INSERT INTO tropy_projects VALUES (?, ?, ?, ?, ?)').run('p1', tpy, 'p', 'now', 0);
      db.prepare('INSERT INTO tropy_projects VALUES (?, ?, ?, ?, ?)').run('p2', tpy, 'p', 'now', 0);
      db.prepare('INSERT INTO tropy_sources VALUES (?, ?)').run('s1', 'une transcription payée en heures d’OCR');
    });
    const messages = ecarts(await check(), 'tropy').map((f) => f.message).join('\n');
    expect(messages).toMatch(/2 lignes pour le même projet Tropy/);
    expect(messages).toMatch(/1 source\(s\) transcrite\(s\) sans aucun extrait/);
  });

  it('bibliographie : clés en double et clés que pandoc peut rejeter', async () => {
    write('bibliography.bib', [
      '@comment{ignoré}',
      '@book{Dupont_1990, title={A}}',
      '@article{Dupont_1990, title={B}}',
      '@book{Börnchen_2025, title={C}}',
    ].join('\n'));
    createBrain(() => {});
    const messages = ecarts(await check(), 'bibliographie').map((f) => f.message).join('\n');
    expect(messages).toMatch(/3 entrée\(s\).*clés en double : Dupont_1990/);
    expect(messages).toMatch(/1 clé\(s\) hors ASCII sûr : Börnchen_2025/);
  });

  it('manuscrit et notes : index qui ne correspond plus au texte', async () => {
    write('document.md', '# Version modifiée\n');
    write('reading-notes/Braudel_1949.md', 'nouvelle version');
    createBrain((db) => {
      db.prepare('INSERT INTO manuscript_chapters VALUES (?, ?, ?)').run('m1', 'document.md', sha('# Ancienne version\n'));
      db.prepare('INSERT INTO reading_notes VALUES (?, ?, ?)').run('n1', 'reading-notes/Braudel_1949.md', sha('ancienne'));
    });
    const findings = await check();
    expect(ecarts(findings, 'manuscrit').map((f) => f.message).join()).toMatch(/1\/1 pièce\(s\) dont l’index ne correspond pas/);
    expect(ecarts(findings, 'notes').map((f) => f.message).join()).toMatch(/1\/1 note\(s\) non indexée\(s\) ou modifiée\(s\)/);
  });
});

describe('bilan de santé — un même fichier sous deux chemins (#123)', () => {
  it('signale deux documents qui désignent le même fichier, et ne compte pas ce fichier comme non indexé', async () => {
    const real = write('PDFs/Hughes_2025.pdf', '%PDF-1.4');
    const link = path.join(root, 'PDFs', 'lien-vers-hughes.pdf');
    fs.symlinkSync(real, link);
    createBrain((db) => {
      db.prepare('INSERT INTO pdf_documents VALUES (?, ?)').run('d1', real);
      db.prepare('INSERT INTO pdf_documents VALUES (?, ?)').run('d2', link);
      db.prepare('INSERT INTO pdf_chunks VALUES (?, ?, ?)').run('c1', 'd1', vec);
      db.prepare('INSERT INTO pdf_chunks VALUES (?, ?, ?)').run('c2', 'd2', vec);
    });

    const findings = await check();
    const pdf = ecarts(findings, 'pdf');
    expect(pdf.some((f) => f.message.startsWith('2 documents pour 1 fichiers'))).toBe(true);
    const listed = findings.find((f) => f.domaine === 'pdf' && f.message.includes('PDF dans le dossier'));
    expect(listed?.message).toContain('dont 0 non indexé');
  });
});

describe('bilan de santé — lecture seule stricte', () => {
  it('ne crée ni -wal ni -shm et ne modifie pas la base', async () => {
    const dbPath = createBrain((db) => {
      db.exec('PRAGMA journal_mode = WAL');
      db.prepare('INSERT INTO tropy_sources VALUES (?, ?)').run('s1', 'x');
    });
    for (const side of ['-wal', '-shm']) fs.rmSync(dbPath + side, { force: true });
    const before = sha(fs.readFileSync(dbPath).toString('latin1'));
    await check();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(sha(fs.readFileSync(dbPath).toString('latin1'))).toBe(before);
  });
});

describe('bibEntryKeys', () => {
  it('ignore @comment, @string et @preamble', () => {
    expect(bibEntryKeys('@string{x = "y"}\n@preamble{"p"}\n@misc{K1,\n}\n@Book( K2 ,\n)')).toEqual(['K1', 'K2']);
  });
});
