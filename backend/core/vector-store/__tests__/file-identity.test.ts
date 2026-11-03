/**
 * Identité d'un fichier indexé (#123) : deux chemins qui ne diffèrent que par
 * la casse désignaient deux documents, alors qu'ils désignent un seul fichier
 * sur un disque insensible à la casse (APFS par défaut). Ici, un `realpath`
 * simulé joue ce disque : ces tests tournent partout, CI Linux comprise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { symlinkAvailable } from '../../../__tests__/helpers/native-guards';
import { fileIdentity, groupByFile, isInside, mayBeSameFile, sameFile } from '../file-identity';

/** Disque insensible à la casse : un seul fichier, enregistré sous cette casse-là. */
const ON_DISK = '/projet/PDFs/Hughes‐Warrington_-_2025_-_ETHICS_FOR_ARTIFICIAL_HISTORIANS.pdf';
const caseInsensitiveDisk = (p: string): string => {
  if (p.toLowerCase() === ON_DISK.toLowerCase()) return ON_DISK;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

describe('fileIdentity', () => {
  it('rend le chemin tel qu’enregistré sur le disque, quelle que soit la casse demandée', () => {
    expect(fileIdentity(ON_DISK.replace('ETHICS_FOR_ARTIFICIAL_HISTORIANS', 'Ethics_for_artificial_historians'), caseInsensitiveDisk)).toBe(ON_DISK);
  });

  it('retombe sur le chemin tel quel pour un fichier disparu', () => {
    expect(fileIdentity('/projet/PDFs/Disparu.pdf', caseInsensitiveDisk)).toBe('/projet/PDFs/Disparu.pdf');
  });
});

describe('groupByFile', () => {
  it('regroupe les documents dont les chemins ne diffèrent que par la casse (cas réel de #123)', () => {
    const rows = [
      { id: 'recent', file_path: ON_DISK },
      { id: 'ancien', file_path: ON_DISK.replace('ETHICS_FOR_ARTIFICIAL_HISTORIANS', 'Ethics_for_artificial_historians') },
      // Autre article : tiret ASCII, autre fichier.
      { id: 'autre', file_path: '/projet/PDFs/Hughes-Warrington_-_2025_-_Ethics_for_artificial_historians.pdf' },
    ];
    const groups = groupByFile(rows, caseInsensitiveDisk);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([['recent', 'ancien'], ['autre']]);
  });

  it('ne regroupe pas deux fichiers disparus aux chemins différents', () => {
    const groups = groupByFile(
      [
        { id: 'a', file_path: '/projet/PDFs/A.pdf' },
        { id: 'b', file_path: '/projet/PDFs/a.pdf' },
      ],
      caseInsensitiveDisk
    );
    expect(groups).toHaveLength(2);
  });
});

describe('mayBeSameFile', () => {
  it('compare le nom de fichier à la casse et à la forme Unicode près', () => {
    expect(mayBeSameFile('/a/ETHICS.pdf', '/b/Ethics.pdf')).toBe(true);
    // « é » précomposé (NFC) contre e + accent combinant (NFD).
    expect(mayBeSameFile('/a/annoté.pdf', '/a/annoté.pdf')).toBe(true);
    expect(mayBeSameFile('/a/Hughes‐Warrington.pdf', '/a/Hughes-Warrington.pdf')).toBe(false);
  });
});

/** Un disque où rien n'existe : le contrôle ne repose alors que sur les chemins. */
const noDisk = (): string => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

describe('sameFile, sans disque', () => {
  it('casse : le disque tranche', () => {
    const ailleurs = ON_DISK.replace('ETHICS_FOR_ARTIFICIAL_HISTORIANS', 'Ethics_for_artificial_historians');
    expect(sameFile(ON_DISK, ailleurs, caseInsensitiveDisk)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('casse : deux fichiers disparus aux chemins différents ne se confondent pas', () => {
    expect(sameFile('/projet/A.pdf', '/projet/a.pdf', noDisk)).toBe(false);
  });

  it('forme Unicode : « é » précomposé et décomposé désignent le même nom', () => {
    expect(sameFile('/projet/annot\u00e9.pdf', '/projet/annote\u0301.pdf', noDisk)).toBe(true);
    expect(sameFile('/projet/annot\u00e9.pdf', '/projet/annote.pdf', noDisk)).toBe(false);
  });

  it('Windows : séparateurs mixtes, casse du lecteur et du nom', () => {
    expect(sameFile('C:\\Projet/chapters\\01.md', 'c:/projet/CHAPTERS/01.md', noDisk)).toBe(true);
    expect(sameFile('C:\\Projet\\01.md', 'D:\\Projet\\01.md', noDisk)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('POSIX : une barre oblique inverse fait partie du nom', () => {
    expect(sameFile('/projet/a\\b.md', '/projet/a/b.md', noDisk)).toBe(false);
  });
});

describe('isInside, sans disque', () => {
  it('compare par segments : /a/b ne contient pas /a/bc', () => {
    expect(isInside('/a/b', '/a/bc/x.md', { realpath: noDisk })).toBe(false);
    expect(isInside('/a/b', '/a/b/x.md', { realpath: noDisk })).toBe(true);
  });

  it('un nom qui commence par deux points reste dedans ; `..` en sort', () => {
    expect(isInside('/a/b', '/a/b/..foo', { realpath: noDisk })).toBe(true);
    expect(isInside('/a/b', '/a/b/..foo/x.md', { realpath: noDisk })).toBe(true);
    expect(isInside('/a/b', '/a/b/../x.md', { realpath: noDisk })).toBe(false);
    expect(isInside('/a/b', '/a', { realpath: noDisk })).toBe(false);
  });

  it('la racine elle-même : seulement si on le demande', () => {
    expect(isInside('/a/b', '/a/b', { realpath: noDisk })).toBe(false);
    expect(isInside('/a/b', '/a/b/', { realpath: noDisk })).toBe(false);
    expect(isInside('/a/b', '/a/b', { realpath: noDisk, allowRoot: true })).toBe(true);
  });

  it('casse différente sur un disque qui l’ignore : pas de faux refus', () => {
    const disk = (p: string): string => {
      const known = ['/Projet', '/Projet/chapters', '/Projet/chapters/01.md'];
      const hit = known.find((k) => k.toLowerCase() === p.toLowerCase());
      if (hit) return hit;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(isInside('/PROJET', '/projet/CHAPTERS/01.md', { realpath: disk })).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('casse différente sur un disque qui la distingue : deux dossiers, donc dehors', () => {
    const disk = (p: string): string => p;
    expect(isInside('/Projet', '/projet/01.md', { realpath: disk })).toBe(false);
  });

  it('NFC contre NFD, même sur un système de fichiers qui ne normalise pas', () => {
    const disk = (p: string): string => p;
    expect(isInside('/\u00c9t\u00e9', '/E\u0301te\u0301/01.md', { realpath: disk })).toBe(true);
  });

  it('Windows : séparateurs mixtes et casse', () => {
    expect(isInside('C:\\Projet', 'C:/Projet\\chapters/01.md', { realpath: noDisk })).toBe(true);
    expect(isInside('C:\\Projet', 'c:/projet/chapters/01.md', { realpath: noDisk })).toBe(true);
    expect(isInside('C:/Projet/', 'C:\\Projet\\01.md', { realpath: noDisk })).toBe(true);
    expect(isInside('C:\\Projet', 'C:\\Projet2\\01.md', { realpath: noDisk })).toBe(false);
    expect(isInside('C:\\Projet', 'D:\\Projet\\01.md', { realpath: noDisk })).toBe(false);
    expect(isInside('C:\\Projet', 'C:\\Projet\\..\\01.md', { realpath: noDisk })).toBe(false);
  });
});

describe.skipIf(!symlinkAvailable)('sur un vrai disque, avec de vrais liens', () => {
  let work: string;
  let projet: string;
  let dehors: string;

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'cliodeck-confinement-'));
    projet = path.join(work, 'projet');
    dehors = path.join(work, 'dehors');
    mkdirSync(path.join(projet, 'chapters'), { recursive: true });
    mkdirSync(dehors);
    writeFileSync(path.join(projet, 'chapters', '01.md'), '# Un');
    writeFileSync(path.join(dehors, 'secret.md'), 'SECRET');
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('témoin : le dossier temporaire de ce système passe souvent par un lien', () => {
    // /tmp vers /private/tmp, /var/folders vers /private/var/folders : le cas
    // courant du faux positif, que ce test garde sous les yeux.
    expect(isInside(work, path.join(projet, 'chapters', '01.md'))).toBe(true);
    expect(isInside(realpathSync(work), path.join(projet, 'chapters', '01.md'))).toBe(true);
    expect(isInside(work, path.join(realpathSync(work), 'projet', 'chapters', '01.md'))).toBe(true);
  });

  describe('racine liée', () => {
    let alias: string;
    beforeEach(() => {
      alias = path.join(work, 'alias');
      symlinkSync(projet, alias);
    });

    it('un chapitre ordinaire reste dedans, par quelque côté qu’on le prenne', () => {
      expect(isInside(alias, path.join(alias, 'chapters', '01.md'))).toBe(true);
      expect(isInside(alias, path.join(projet, 'chapters', '01.md'))).toBe(true);
      expect(isInside(projet, path.join(alias, 'chapters', '01.md'))).toBe(true);
    });

    it('un fichier encore absent aussi', () => {
      expect(isInside(alias, path.join(alias, 'chapters', 'a-venir.md'))).toBe(true);
    });

    it('un lien sortant reste dehors', () => {
      symlinkSync(path.join(dehors, 'secret.md'), path.join(projet, 'chapters', 'piege.md'));
      expect(isInside(alias, path.join(alias, 'chapters', 'piege.md'))).toBe(false);
    });
  });

  it('un lien de fichier sortant : dehors, en absolu comme en relatif', () => {
    symlinkSync(path.join(dehors, 'secret.md'), path.join(projet, 'chapters', 'absolu.md'));
    symlinkSync('../../dehors/secret.md', path.join(projet, 'chapters', 'relatif.md'));
    expect(isInside(projet, path.join(projet, 'chapters', 'absolu.md'))).toBe(false);
    expect(isInside(projet, path.join(projet, 'chapters', 'relatif.md'))).toBe(false);
  });

  it('un lien de fichier interne : dedans', () => {
    symlinkSync('01.md', path.join(projet, 'chapters', 'copie.md'));
    expect(isInside(projet, path.join(projet, 'chapters', 'copie.md'))).toBe(true);
  });

  it('`chapters` lié à l’intérieur du projet : dedans', () => {
    const brouillons = path.join(projet, 'brouillons');
    mkdirSync(brouillons);
    writeFileSync(path.join(brouillons, '02.md'), '# Deux');
    rmSync(path.join(projet, 'chapters'), { recursive: true, force: true });
    symlinkSync(brouillons, path.join(projet, 'chapters'));
    expect(isInside(projet, path.join(projet, 'chapters', '02.md'))).toBe(true);
    expect(isInside(projet, path.join(projet, 'chapters', 'absent.md'))).toBe(true);
  });

  it('`chapters` lié hors du projet : dehors, fichier présent ou non', () => {
    rmSync(path.join(projet, 'chapters'), { recursive: true, force: true });
    symlinkSync(dehors, path.join(projet, 'chapters'));
    expect(isInside(projet, path.join(projet, 'chapters', 'secret.md'))).toBe(false);
    expect(isInside(projet, path.join(projet, 'chapters', 'absent.md'))).toBe(false);
  });

  it('un chemin absent dont seul le parent existe : dedans', () => {
    expect(isInside(projet, path.join(projet, 'chapters', 'a-venir.md'))).toBe(true);
    expect(isInside(projet, path.join(projet, 'nouveau', 'sous', 'a-venir.md'))).toBe(true);
  });

  it('un lien cassé vers l’extérieur : dehors', () => {
    symlinkSync(path.join(dehors, 'pas-encore.md'), path.join(projet, 'chapters', 'casse.md'));
    symlinkSync('../../dehors/pas-encore.md', path.join(projet, 'chapters', 'casse-relatif.md'));
    expect(isInside(projet, path.join(projet, 'chapters', 'casse.md'))).toBe(false);
    expect(isInside(projet, path.join(projet, 'chapters', 'casse-relatif.md'))).toBe(false);
  });

  it('un lien cassé vers l’intérieur : dedans', () => {
    symlinkSync('pas-encore.md', path.join(projet, 'chapters', 'casse.md'));
    expect(isInside(projet, path.join(projet, 'chapters', 'casse.md'))).toBe(true);
  });

  it('une chaîne de liens qui finit dehors : dehors', () => {
    symlinkSync(path.join(dehors, 'pas-encore.md'), path.join(projet, 'chapters', 'etape2.md'));
    symlinkSync('etape2.md', path.join(projet, 'chapters', 'etape1.md'));
    expect(isInside(projet, path.join(projet, 'chapters', 'etape1.md'))).toBe(false);
  });

  it('une boucle de liens ne mène nulle part : refusée, sans tourner sans fin', () => {
    symlinkSync('boucle.md', path.join(projet, 'chapters', 'boucle.md'));
    expect(isInside(projet, path.join(projet, 'chapters', 'boucle.md'))).toBe(false);
  });

  it('casse différente sur le vrai disque, s’il l’ignore', () => {
    const autreCasse = path.join(projet, 'CHAPTERS', '01.md');
    if (!existsSync(autreCasse)) return; // disque sensible à la casse : rien à vérifier
    expect(isInside(projet, autreCasse)).toBe(true);
    expect(isInside(projet.toUpperCase(), path.join(projet, 'chapters', '01.md'))).toBe(
      existsSync(projet.toUpperCase())
    );
  });

  it('NFC contre NFD sur le vrai disque, s’il ne les distingue pas', () => {
    const nfd = path.join(work, '\u00c9t\u00e9'.normalize('NFD'));
    const nfc = path.join(work, '\u00c9t\u00e9'.normalize('NFC'));
    mkdirSync(nfd);
    writeFileSync(path.join(nfd, '01.md'), '# Un');
    if (!existsSync(nfc)) return; // ce système distingue les deux formes
    expect(isInside(nfc, path.join(nfd, '01.md'))).toBe(true);
    expect(isInside(nfd, path.join(nfc, '01.md'))).toBe(true);
  });

  it('sameFile suit les liens, y compris vers un fichier encore absent', () => {
    symlinkSync(projet, path.join(work, 'alias'));
    symlinkSync('01.md', path.join(projet, 'chapters', 'copie.md'));
    expect(sameFile(path.join(work, 'alias'), projet)).toBe(true);
    expect(sameFile(path.join(projet, 'chapters', 'copie.md'), path.join(projet, 'chapters', '01.md'))).toBe(true);
    expect(sameFile(path.join(work, 'alias', 'a-venir.md'), path.join(projet, 'a-venir.md'))).toBe(true);
    expect(sameFile(projet, dehors)).toBe(false);
  });
});
