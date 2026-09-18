/**
 * Où écrire une pièce jointe Zotero téléchargée dans `PDFs/`.
 *
 * Le fichier de destination ne dépendait que du nom de la pièce jointe : deux
 * pièces jointes de même nom s'écrasaient, en silence. Mesuré sur un projet
 * réel (#131) : « 2023 - Documents sauvegardés.pdf » — le nom par défaut des
 * exports Europresse — porté par quatre pièces jointes de deux références ; le
 * PDF de l'une a été remplacé par celui de l'autre, alors que sa fiche le
 * disait toujours téléchargé. Sur un corpus de presse, la collision est la
 * règle, pas l'exception.
 *
 * Règle : **ne jamais écraser un fichier qui appartient à une autre pièce
 * jointe**.
 *   - le nom est libre, ou le fichier est déjà celui de cette pièce jointe
 *     (retéléchargement) → nom simple ;
 *   - il appartient à une autre pièce jointe → nom suffixé par la clé de la
 *     pièce jointe, unique dans la bibliothèque ;
 *   - un fichier existe sans propriétaire connu (déposé à la main, ou
 *     téléchargé avant que le rattachement ne soit sauvegardé) → au service de
 *     comparer les contenus : identique, on le réutilise ; différent, nom
 *     suffixé.
 */

import path from 'path';
import { fileIdentity, mayBeSameFile } from '../../core/vector-store/file-identity.js';

const MAX_NAME = 200;

/** Nom de fichier sûr, tel que ClioDeck l'a toujours produit. */
export function sanitizeAttachmentFilename(filename: string): string {
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .substring(0, MAX_NAME);
}

/** Même nom, suffixé par la clé de la pièce jointe, extension conservée. */
export function suffixedAttachmentFilename(filename: string, attachmentKey: string): string {
  const safe = sanitizeAttachmentFilename(filename);
  const ext = path.extname(safe) || '.pdf';
  const stem = safe.slice(0, safe.length - path.extname(safe).length);
  const suffix = `_${attachmentKey}`;
  return `${stem.substring(0, MAX_NAME - suffix.length - ext.length)}${suffix}${ext}`;
}

export interface AttachmentOwner {
  attachmentKey: string;
  localPath: string;
}

export type DestinationDecision =
  | { kind: 'write'; path: string; reason: 'free' | 'own' | 'taken-by-other' }
  | { kind: 'compare'; path: string; fallback: string };

export function chooseAttachmentDestination(options: {
  pdfDir: string;
  filename: string;
  attachmentKey: string;
  owners: readonly AttachmentOwner[];
  exists: (filePath: string) => boolean;
  identity?: (filePath: string) => string;
}): DestinationDecision {
  const { pdfDir, filename, attachmentKey, owners, exists } = options;
  const identity = options.identity ?? ((p: string) => fileIdentity(p));
  const plain = path.join(pdfDir, sanitizeAttachmentFilename(filename));
  const suffixed = path.join(pdfDir, suffixedAttachmentFilename(filename, attachmentKey));

  const ownersOfPlain = owners.filter(
    (o) => mayBeSameFile(o.localPath, plain) && identity(o.localPath) === identity(plain),
  );
  if (ownersOfPlain.some((o) => o.attachmentKey !== attachmentKey)) {
    return { kind: 'write', path: suffixed, reason: 'taken-by-other' };
  }
  if (ownersOfPlain.length > 0) return { kind: 'write', path: plain, reason: 'own' };
  if (!exists(plain)) return { kind: 'write', path: plain, reason: 'free' };
  return { kind: 'compare', path: plain, fallback: suffixed };
}
