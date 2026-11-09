/**
 * Un PDF n'est « modifié » que comparé au MD5 de sa propre pièce jointe Zotero (Q22, S03-1-4).
 *
 * Le détecteur testait `!citation.file` au lieu d'`isPdfPath`, et se rabattait sur « la première
 * pièce jointe qui a un MD5 » quand aucune ne correspondait au fichier : un instantané HTML hérité
 * (`PDFs/1706.html`), ou un PDF qui n'est pas celui de la pièce jointe, était comparé au MD5 d'un
 * autre fichier et signalé « modifié » à chaque vérification. Un fichier absent l'était aussi, alors
 * que réindexer n'y peut rien. Et un PDF déjà signalé, auquel l'historien a répondu, revenait à la
 * vérification suivante : le projet retient désormais son MD5 (`signaledMd5`).
 *
 * Vrais fichiers dans un dossier temporaire ; MD5 de Zotero écrits à la main.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { PDFModificationDetector } from '../PDFModificationDetector.js';
import type { Citation, ZoteroAttachmentInfo } from '../../types/citation.js';

const md5 = (content: string): string => createHash('md5').update(content).digest('hex');

/** Le PDF tel que Zotero le connaît, et celui que l'historien a annoté ensuite. */
const ZOTERO_BYTES = '%PDF-1.4 version de Zotero';
const ANNOTATED_BYTES = '%PDF-1.4 version annotée dans Aperçu';

let dir = '';
const inProject = (name: string): string => path.join(dir, 'PDFs', name);
const write = (name: string, content: string): string => {
  const file = inProject(name);
  fs.writeFileSync(file, content);
  return file;
};

const attachment = (overrides: Partial<ZoteroAttachmentInfo>): ZoteroAttachmentInfo => ({
  key: 'ATT1',
  filename: 'Vaswani et al. - 2017 - Attention Is All You Need.pdf',
  contentType: 'application/pdf',
  downloaded: false,
  md5: md5(ZOTERO_BYTES),
  ...overrides,
});

const citation = (file: string | undefined, attachments: ZoteroAttachmentInfo[]): Citation =>
  ({
    id: 'Vaswani_2017',
    type: 'article',
    author: 'Vaswani, Ashish',
    year: '2017',
    title: 'Attention Is All You Need',
    zoteroKey: 'Z1',
    file,
    zoteroAttachments: attachments,
  }) as Citation;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-modifies-'));
  fs.mkdirSync(path.join(dir, 'PDFs'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PDFModificationDetector — le PDF de la pièce jointe, et lui seul', () => {
  it('le PDF téléchargé, annoté depuis : signalé, avec sa pièce jointe et son MD5', async () => {
    const file = write('ATT1.pdf', ANNOTATED_BYTES);
    const result = await new PDFModificationDetector().detectModifiedPDFs([
      citation(file, [attachment({ downloaded: true, localPath: file })]),
    ]);

    expect(result.modifiedPDFs).toEqual([
      expect.objectContaining({
        citationId: 'Vaswani_2017',
        zoteroKey: 'Z1',
        attachmentKey: 'ATT1',
        filePath: file,
        reason: 'md5-changed',
        oldMD5: md5(ZOTERO_BYTES),
        newMD5: md5(ANNOTATED_BYTES),
      }),
    ]);
  });

  it('témoin : le même PDF que Zotero n’est pas signalé', async () => {
    const file = write('ATT1.pdf', ZOTERO_BYTES);
    const result = await new PDFModificationDetector().detectModifiedPDFs([
      citation(file, [attachment({ downloaded: true, localPath: file })]),
    ]);

    expect(result.modifiedPDFs).toEqual([]);
    expect(result.totalChecked).toBe(1);
  });

  it('un instantané HTML hérité n’est pas comparé au MD5 du PDF joint', async () => {
    const snapshot = write('1706.html', '<html>instantané de la page</html>');
    const result = await new PDFModificationDetector().detectModifiedPDFs([citation(snapshot, [attachment({})])]);

    expect(result.modifiedPDFs).toEqual([]);
  });

  it('un instantané HTML hérité, fichier de sa propre pièce jointe, n’est pas un « PDF modifié »', async () => {
    // L'ancienne synchronisation rattachait l'instantané à la notice (CLAUDE.md §6) : sa pièce jointe
    // le désigne (`localPath`), l'appariement ne l'écarte donc pas. Seule la garde `isPdfPath` le
    // fait ; sans elle, il serait signalé dès que son MD5 diffère, et « Ré-indexer » échouerait.
    const snapshot = write('13082.html', '<html>instantané de la page</html>');
    const result = await new PDFModificationDetector().detectModifiedPDFs([
      citation(snapshot, [
        attachment({
          key: '13082',
          filename: '13082.html',
          contentType: 'text/html',
          downloaded: true,
          localPath: snapshot,
          md5: 'f'.repeat(32),
        }),
      ]),
    ]);

    expect(result).toEqual({ modifiedPDFs: [], totalChecked: 0, totalModified: 0 });
  });

  it('un PDF qui ne correspond à aucune pièce jointe n’est comparé à aucune', async () => {
    const other = write('Un autre article.pdf', ANNOTATED_BYTES);
    const result = await new PDFModificationDetector().detectModifiedPDFs([citation(other, [attachment({})])]);

    expect(result.modifiedPDFs).toEqual([]);
  });

  it('un homonyme de PDFs/ n’est pas le PDF d’une pièce jointe téléchargée sous un autre nom', async () => {
    // La pièce jointe « article.pdf » de cette référence a été téléchargée en « article (2).pdf » :
    // le premier nom était pris par le PDF d'une autre référence, que désigne le `.bib`.
    const ownDownload = write('article (2).pdf', ZOTERO_BYTES);
    const homonym = write('article.pdf', ANNOTATED_BYTES);
    const result = await new PDFModificationDetector().detectModifiedPDFs([
      citation(homonym, [attachment({ filename: 'article.pdf', downloaded: true, localPath: ownDownload })]),
    ]);

    expect(result.modifiedPDFs).toEqual([]);
  });

  it('le PDF de Zotero désigné par son nom de fichier, sans téléchargement dans le projet : comparé', async () => {
    const file = write('Vaswani et al. - 2017 - Attention Is All You Need.pdf', ANNOTATED_BYTES);
    const result = await new PDFModificationDetector().detectModifiedPDFs([citation(file, [attachment({})])]);

    expect(result.modifiedPDFs.map((pdf) => pdf.attachmentKey)).toEqual(['ATT1']);
  });

  it('un fichier absent n’est pas un PDF modifié : réindexer n’y peut rien', async () => {
    const gone = inProject('ATT1.pdf');
    const result = await new PDFModificationDetector().detectModifiedPDFs([
      citation(gone, [attachment({ downloaded: true, localPath: gone })]),
    ]);

    expect(result.modifiedPDFs).toEqual([]);
  });
});

describe('PDFModificationDetector — ce que le projet a déjà signalé', () => {
  it('déjà signalé avec ce MD5 : plus signalé ; le fichier modifié de nouveau : signalé', async () => {
    const file = write('ATT1.pdf', ANNOTATED_BYTES);
    const cite = citation(file, [attachment({ downloaded: true, localPath: file })]);
    const detector = new PDFModificationDetector();
    const remembered = md5(ANNOTATED_BYTES);
    const signaled = {
      knows: () => true,
      signaledMd5: (_citation: Citation, attachmentKey: string) => (attachmentKey === 'ATT1' ? remembered : undefined),
    };

    expect((await detector.detectModifiedPDFs([cite], signaled)).modifiedPDFs).toEqual([]);

    fs.writeFileSync(file, `${ANNOTATED_BYTES}, puis une seconde annotation`);
    expect((await detector.detectModifiedPDFs([cite], signaled)).modifiedPDFs.map((pdf) => pdf.newMD5)).toEqual([
      md5(`${ANNOTATED_BYTES}, puis une seconde annotation`),
    ]);
  });

  it('une pièce jointe que le projet ne connaît pas : ni signalée, ni lue', async () => {
    // Les références d'un autre projet : le projet ne pourrait pas retenir la réponse, et le PDF
    // reviendrait à chaque vérification.
    const file = write('ATT1.pdf', ANNOTATED_BYTES);
    const cite = citation(file, [attachment({ downloaded: true, localPath: file })]);
    const unknown = { knows: () => false, signaledMd5: () => undefined };

    const result = await new PDFModificationDetector().detectModifiedPDFs([cite], unknown);

    expect(result).toEqual({ modifiedPDFs: [], totalChecked: 0, totalModified: 0 });
  });
});
