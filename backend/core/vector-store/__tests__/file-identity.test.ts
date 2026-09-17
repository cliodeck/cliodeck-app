/**
 * Identité d'un fichier indexé (#123) : deux chemins qui ne diffèrent que par
 * la casse désignaient deux documents, alors qu'ils désignent un seul fichier
 * sur un disque insensible à la casse (APFS par défaut). Ici, un `realpath`
 * simulé joue ce disque : ces tests tournent partout, CI Linux comprise.
 */
import { describe, expect, it } from 'vitest';
import { fileIdentity, groupByFile, mayBeSameFile } from '../file-identity';

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
