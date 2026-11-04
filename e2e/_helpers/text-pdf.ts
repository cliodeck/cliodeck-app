/**
 * Un PDF de texte, écrit à la main : pas de fixture à garder à jour, et un contenu que le découpage
 * ne rejette pas.
 */

import { writeFileSync } from 'node:fs';

/** Assez de phrases distinctes pour que le préréglage de découpage compte : le texte d'une page tient sur une ligne. */
export function textPdf(filePath: string, pageCount: number): void {
  const syllables = ['ar', 'chi', 've', 'do', 'cu', 'men', 'ta', 'ti', 'on', 'his', 'toi', 're', 'mu', 'ni', 'ci', 'pa', 'le', 'gou', 'ver', 'ne'];
  let seed = 7;
  const next = (max: number): number => {
    seed = (seed * 1105 + 12345) % 65536;
    return (seed >> 4) % max;
  };
  const word = (): string => Array.from({ length: 2 + next(3) }, () => syllables[next(syllables.length)]).join('');
  const sentence = (): string => {
    const text = Array.from({ length: 6 + next(5) }, word).join(' ');
    return `${text[0].toUpperCase()}${text.slice(1)}.`;
  };
  const objects: string[] = [];
  const pageRefs: string[] = [];
  for (let page = 0; page < pageCount; page++) {
    const lines = Array.from({ length: 40 }, () => `(${sentence()}) Tj T*`).join('\n');
    const stream = `BT /F1 9 Tf 40 780 Td 12 TL\n${lines}\nET`;
    const contentNumber = 4 + page * 2;
    const pageNumber = contentNumber + 1;
    objects[contentNumber] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageNumber] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    pageRefs.push(`${pageNumber} 0 R`);
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = Buffer.byteLength(body);
    body += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  const entries = offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(filePath, body);
}
