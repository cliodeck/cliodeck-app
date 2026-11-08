import { describe, it, expect } from 'vitest';
import { fromStoredPath, toStoredPath } from '../stored-path';

/**
 * Les PDF d'un projet se rangent relatifs à lui (S07-2-1). Écrits en absolu dans le `.bib` et dans
 * `bibliography-metadata.json`, ils ne se retrouvaient plus dès que le dossier du projet changeait
 * de nom ou de machine (Dropbox, autre nom d'utilisateur) ; le `.bib` partagé disait au passage le
 * chemin local de l'auteur. Les chemins de Windows sont simulés : ils s'analysent comme tels sur
 * tout système.
 */

/** Un disque où seuls ces fichiers existent. */
const disk =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p);

describe('toStoredPath', () => {
  it('un PDF du projet s’écrit relatif, en barres obliques normales', () => {
    expect(toStoredPath('/Users/jean/These/PDFs/Dupont.pdf', '/Users/jean/These')).toBe('PDFs/Dupont.pdf');
    expect(toStoredPath('/Users/jean/These/PDFs/Dupont.pdf', '/Users/jean/These/')).toBe('PDFs/Dupont.pdf');
  });

  it('un fichier hors du projet garde son chemin absolu', () => {
    expect(toStoredPath('/Users/jean/Zotero/storage/AB/a.pdf', '/Users/jean/These')).toBe('/Users/jean/Zotero/storage/AB/a.pdf');
  });

  it('un dossier voisin dont le nom prolonge celui du projet n’est pas le projet', () => {
    expect(toStoredPath('/projetX/PDFs/a.pdf', '/projet')).toBe('/projetX/PDFs/a.pdf');
    expect(toStoredPath('/projet-2026/PDFs/a.pdf', '/projet')).toBe('/projet-2026/PDFs/a.pdf');
  });

  it('un chemin qui ressort du projet par « .. » n’y est pas', () => {
    expect(toStoredPath('/projet/PDFs/../../ailleurs/a.pdf', '/projet')).toBe('/projet/PDFs/../../ailleurs/a.pdf');
  });

  it('chemin Windows : barres inverses ou normales, lettre de lecteur et casse indifférentes', () => {
    expect(toStoredPath('C:\\Users\\jean\\These\\PDFs\\Dupont.pdf', 'C:\\Users\\jean\\These')).toBe('PDFs/Dupont.pdf');
    expect(toStoredPath('C:/Users/jean/These/PDFs/Dupont.pdf', 'C:\\Users\\jean\\These')).toBe('PDFs/Dupont.pdf');
    expect(toStoredPath('c:\\users\\jean\\these\\PDFs\\a.pdf', 'C:\\Users\\jean\\These')).toBe('PDFs/a.pdf');
  });

  it('chemin Windows hors du projet : un dossier voisin, un autre lecteur', () => {
    expect(toStoredPath('C:\\Users\\jean\\TheseX\\PDFs\\a.pdf', 'C:\\Users\\jean\\These')).toBe('C:\\Users\\jean\\TheseX\\PDFs\\a.pdf');
    expect(toStoredPath('D:\\These\\PDFs\\a.pdf', 'C:\\These')).toBe('D:\\These\\PDFs\\a.pdf');
  });

  it('un chemin déjà relatif reste relatif, en barres obliques normales', () => {
    expect(toStoredPath('PDFs/a.pdf', '/projet')).toBe('PDFs/a.pdf');
    expect(toStoredPath('PDFs\\a.pdf', '/projet')).toBe('PDFs/a.pdf');
  });
});

describe('fromStoredPath', () => {
  it('relatif : rattaché au projet, où qu’il soit maintenant', () => {
    expect(fromStoredPath('PDFs/Dupont.pdf', '/Users/jean/These-2026', disk())).toBe('/Users/jean/These-2026/PDFs/Dupont.pdf');
  });

  it('absolu présent : tel quel', () => {
    const pdf = '/Users/jean/Zotero/storage/AB/a.pdf';
    expect(fromStoredPath(pdf, '/Users/jean/These', disk(pdf))).toBe(pdf);
  });

  it('absolu disparu, le PDF dans PDFs/ du projet renommé : rebasé', () => {
    const rebased = '/Users/jean/These-2026/PDFs/Dupont.pdf';
    expect(fromStoredPath('/Users/jean/These/PDFs/Dupont.pdf', '/Users/jean/These-2026', disk(rebased))).toBe(rebased);
  });

  it('chemin Windows écrit sur un autre poste, relu ici : rebasé par son nom', () => {
    const rebased = '/Users/jean/These/PDFs/Dupont.pdf';
    expect(fromStoredPath('C:\\Users\\jean\\These\\PDFs\\Dupont.pdf', '/Users/jean/These', disk(rebased))).toBe(rebased);
  });

  it('projet sous Windows : le chemin relatif y est rattaché avec ses barres', () => {
    expect(fromStoredPath('PDFs/Dupont.pdf', 'C:\\Users\\jean\\These', disk())).toBe('C:\\Users\\jean\\These\\PDFs\\Dupont.pdf');
  });

  it('fichier hors du projet, introuvable : conservé tel quel', () => {
    const pdf = '/Users/jean/Zotero/storage/AB/a.pdf';
    expect(fromStoredPath(pdf, '/Users/jean/These', disk())).toBe(pdf);
  });

  it('aller-retour : ce qui est rangé se relit à l’endroit d’où il vient', () => {
    const pdf = '/Users/jean/These/PDFs/Dupont et Durand.pdf';
    expect(fromStoredPath(toStoredPath(pdf, '/Users/jean/These'), '/Users/jean/These', disk())).toBe(pdf);
  });
});
