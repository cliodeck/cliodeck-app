/**
 * Le champ `file` d'une notice désigne une pièce jointe, pas forcément un PDF.
 *
 * Jusqu'au 2026-09-14, la synchronisation Zotero rapatriait aussi les
 * instantanés de pages web (`PDFs/13082.html`) et les rattachait à la notice.
 * Pris pour des PDF, ils échouaient à chaque indexation groupée (« Invalid
 * PDF structure ») ; et la notice ayant « déjà un fichier », son vrai PDF
 * n'était plus jamais proposé au téléchargement.
 *
 * Partout où l'on décide qu'une notice « a un PDF », c'est ce prédicat qu'il
 * faut interroger, pas la seule présence de `file`.
 */
export function isPdfPath(file: string | null | undefined): file is string {
  return typeof file === 'string' && /\.pdf$/i.test(file.trim());
}
