/**
 * S09-1-13 : un coffre Obsidian qui contient le projet faisait passer notes de lecture et
 * manuscrit par le canal « vault ». `authorTextInVault` dit au lecteur du coffre ce qu'il doit
 * laisser de côté, en chemins relatifs au coffre.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  authorTextInVault,
  isExcludedFromVault,
  makeOrphanAuthorTextTest,
} from '../author-text-exclusions.js';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-projet-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkProject(root: string, manifest?: unknown): void {
  fs.mkdirSync(path.join(root, 'reading-notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reading-notes', 'Braudel_1949.md'), '# Braudel\n');
  fs.writeFileSync(path.join(root, 'document.md'), '# Article\n');
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(manifest));
  }
}

describe('authorTextInVault', () => {
  it('projet sous le coffre : ses textes, relatifs au coffre', () => {
    const vault = path.join(tmp, 'Thèse');
    const project = path.join(vault, 'ClioDeck-projet');
    mkProject(project, { chapters: [{ filePath: 'annexes/sources.md' }] });

    const excluded = authorTextInVault(vault, project);
    expect(excluded).toEqual(
      expect.arrayContaining([
        'ClioDeck-projet/reading-notes',
        'ClioDeck-projet/chapters',
        'ClioDeck-projet/document.md',
        'ClioDeck-projet/slides.md',
        'ClioDeck-projet/abstract.md',
        'ClioDeck-projet/annexes/sources.md',
      ])
    );
    expect(isExcludedFromVault('ClioDeck-projet/reading-notes/Braudel_1949.md', excluded)).toBe(true);
    expect(isExcludedFromVault('Journal/2026-11-06.md', excluded)).toBe(false);
    // Par segments : un dossier voisin au nom prolongé n'est pas exclu.
    expect(isExcludedFromVault('ClioDeck-projet/reading-notes-brouillon/x.md', excluded)).toBe(false);
  });

  it('coffre égal au projet : les chemins sont ceux du projet', () => {
    mkProject(tmp);
    const excluded = authorTextInVault(tmp, tmp);
    expect(excluded).toEqual(
      expect.arrayContaining(['reading-notes', 'chapters', 'document.md', 'slides.md', 'abstract.md'])
    );
    expect(isExcludedFromVault('document.md', excluded)).toBe(true);
    expect(isExcludedFromVault('idees.md', excluded)).toBe(false);
  });

  it('coffre dans reading-notes : tout le coffre est le texte de l’auteur', () => {
    mkProject(tmp);
    const excluded = authorTextInVault(path.join(tmp, 'reading-notes'), tmp);
    expect(excluded).toEqual(['']);
    expect(isExcludedFromVault('Braudel_1949.md', excluded)).toBe(true);
  });

  it('coffre disjoint du projet : rien à exclure', () => {
    const vault = path.join(tmp, 'Obsidian');
    const project = path.join(tmp, 'Projets', 'these');
    fs.mkdirSync(vault, { recursive: true });
    mkProject(project);
    expect(authorTextInVault(vault, project)).toEqual([]);
  });

  it('coffre ouvert par un lien symbolique : le projet est reconnu dessous', () => {
    const vault = path.join(tmp, 'Thèse');
    const project = path.join(vault, 'ClioDeck-projet');
    mkProject(project);
    const link = path.join(tmp, 'lien-coffre');
    fs.symlinkSync(vault, link, 'dir');

    const excluded = authorTextInVault(link, project);
    expect(isExcludedFromVault('ClioDeck-projet/reading-notes/Braudel_1949.md', excluded)).toBe(true);
    expect(isExcludedFromVault('ClioDeck-projet/document.md', excluded)).toBe(true);
  });
});

describe('makeOrphanAuthorTextTest — coffre disparu', () => {
  it('reconnaît le texte de l’auteur sous un ancêtre du projet, note supprimée comprise', () => {
    const project = path.join(tmp, 'Coffre', 'these');
    mkProject(project);
    const isAuthorText = makeOrphanAuthorTextTest(project);
    expect(isAuthorText('these/reading-notes/Braudel_1949.md')).toBe(true);
    expect(isAuthorText('these/reading-notes/Supprimee_2001.md')).toBe(true);
    expect(isAuthorText('these/document.md')).toBe(true);
    expect(isAuthorText('reading-notes/Braudel_1949.md')).toBe(true); // coffre = projet
    expect(isAuthorText('Journal/2026-11-06.md')).toBe(false);
    expect(isAuthorText('these/notes-diverses.md')).toBe(false);
  });

  it('livre : les chapitres du manifeste, même hors de chapters/', () => {
    const project = path.join(tmp, 'Coffre', 'livre');
    fs.mkdirSync(path.join(project, 'texte'), { recursive: true });
    fs.writeFileSync(path.join(project, 'texte', 'intro.md'), '# Intro\n');
    fs.writeFileSync(
      path.join(project, 'project.json'),
      JSON.stringify({ type: 'book', chapters: [{ filePath: 'texte/intro.md' }] })
    );
    const isAuthorText = makeOrphanAuthorTextTest(project);
    expect(isAuthorText('livre/texte/intro.md')).toBe(true);
    expect(isAuthorText('livre/texte/autre.md')).toBe(false);
  });

  it('projet absent : rien n’est reconnu', () => {
    const isAuthorText = makeOrphanAuthorTextTest(path.join(tmp, 'nulle-part'));
    expect(isAuthorText('reading-notes/a.md')).toBe(false);
  });
});
