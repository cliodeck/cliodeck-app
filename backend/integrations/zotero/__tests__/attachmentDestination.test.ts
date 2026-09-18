import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  assertInside,
  chooseAttachmentDestination,
  sanitizeAttachmentFilename,
  suffixedAttachmentFilename,
} from '../attachmentDestination';

const DIR = '/projet/PDFs';
const NAME = '2023 - Documents sauvegardés.pdf';
const identity = (p: string) => p;

describe('chooseAttachmentDestination (#131)', () => {
  it('nom libre → nom simple', () => {
    const d = chooseAttachmentDestination({ pdfDir: DIR, filename: NAME, attachmentKey: 'A', owners: [], exists: () => false, identity });
    expect(d).toEqual({ kind: 'write', path: path.join(DIR, '2023_-_Documents_sauvegardés.pdf'), reason: 'free' });
  });

  it('fichier de cette même pièce jointe → réécrit à sa place', () => {
    const own = path.join(DIR, '2023_-_Documents_sauvegardés.pdf');
    const d = chooseAttachmentDestination({ pdfDir: DIR, filename: NAME, attachmentKey: 'A', owners: [{ attachmentKey: 'A', localPath: own }], exists: () => true, identity });
    expect(d).toMatchObject({ kind: 'write', path: own, reason: 'own' });
  });

  it('fichier d’une autre pièce jointe → nom suffixé par la clé, jamais le même chemin', () => {
    const other = path.join(DIR, '2023_-_Documents_sauvegardés.pdf');
    const d = chooseAttachmentDestination({ pdfDir: DIR, filename: NAME, attachmentKey: 'GC9BPFL6', owners: [{ attachmentKey: 'QQBJJVQY', localPath: other }], exists: () => true, identity });
    expect(d).toMatchObject({ kind: 'write', path: path.join(DIR, '2023_-_Documents_sauvegardés_GC9BPFL6.pdf'), reason: 'taken-by-other' });
  });

  it('propriétaire enregistré avec une autre casse : reconnu comme le même fichier', () => {
    const d = chooseAttachmentDestination({
      pdfDir: DIR,
      filename: NAME,
      attachmentKey: 'B',
      owners: [{ attachmentKey: 'A', localPath: path.join(DIR, '2023_-_DOCUMENTS_sauvegardés.pdf') }],
      exists: () => true,
      identity: (p) => p.toLowerCase(),
    });
    expect(d).toMatchObject({ reason: 'taken-by-other' });
  });

  it('fichier existant sans propriétaire → comparer avant de décider', () => {
    const d = chooseAttachmentDestination({ pdfDir: DIR, filename: NAME, attachmentKey: 'A', owners: [], exists: () => true, identity });
    expect(d.kind).toBe('compare');
  });
});

describe('noms de fichier', () => {
  it('garde le nettoyage historique et borne un nom suffixé à 200 caractères, extension comprise', () => {
    expect(sanitizeAttachmentFilename('a b:c?.pdf')).toBe('a_b_c_.pdf');
    const long = `${'x'.repeat(260)}.pdf`;
    const suffixed = suffixedAttachmentFilename(long, 'ABCD1234');
    expect(suffixed.length).toBeLessThanOrEqual(200);
    expect(suffixed.endsWith('_ABCD1234.pdf')).toBe(true);
  });
});

describe('clés et chemins hostiles', () => {
  it('refuse une clé de pièce jointe qui n’a pas la forme d’une clé Zotero', () => {
    for (const key of ['../../autre-projet/x', 'a/b', '..', '', 'ABC DEF']) {
      expect(() => chooseAttachmentDestination({ pdfDir: DIR, filename: NAME, attachmentKey: key, owners: [], exists: () => false, identity })).toThrow(/invalide/);
      expect(() => suffixedAttachmentFilename(NAME, key)).toThrow(/invalide/);
    }
  });

  it('assertInside refuse tout chemin hors du dossier, y compris le dossier lui-même', () => {
    expect(() => assertInside(DIR, path.join(DIR, 'a.pdf'))).not.toThrow();
    expect(() => assertInside(DIR, path.join(DIR, '..'))).toThrow();
    expect(() => assertInside(DIR, path.join(DIR, '..', 'a.pdf'))).toThrow();
    expect(() => assertInside(DIR, DIR)).toThrow();
    expect(() => assertInside(DIR, '/etc/passwd')).toThrow();
  });
});
