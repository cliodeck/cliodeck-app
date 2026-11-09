/**
 * Quand une note Tropy tient-elle lieu de transcription ?
 *
 * Rien dans Tropy ne distingue une remarque (« voir aussi carton 12 ») d'une
 * transcription faite à la main : on en juge à la longueur (décision Q26 de
 * l'auteur). En dessous du seuil, la note est un commentaire et l'OCR passe ;
 * au-delà, c'est une transcription et l'OCR ne passe que sous « Relancer
 * l'OCR » (`forceReindex`). Dans les deux cas, une note ne remplace jamais une
 * transcription existante (tesseract, manual, transkribus, imported).
 *
 * Le seuil porte sur chaque note — de l'item, d'une photo ou d'une
 * sélection —, pas sur leur somme : la plus longue décide (décision G1 de
 * l'auteur, « OK pour note par note »). La somme faisait de quelques
 * annotations courtes une transcription, et l'OCR attendait « Relancer
 * l'OCR » sur un item qui n'avait jamais été transcrit. Revers assumé : une
 * transcription découpée en notes de page toutes sous le seuil repasse à
 * l'OCR ; la note n'est pas perdue, elle reste à côté du corps (`notes_text`).
 * Si l'OCR n'en tire aucun texte lisible (un manuscrit, par exemple), la
 * source n'acquiert pas de corps : elle repasse à l'OCR à chaque « Lancer
 * l'OCR », comme un item sans note, et ses notes restent son texte. Aucun
 * message ne l'explique, puisque sa plus longue note est sous le seuil.
 * Ces cas sont fixés par `TropySync.e2e.test.ts`.
 *
 * Pas de dépendance ici : le renderer importe ce module pour expliquer la
 * règle sur la source concernée, avec le même seuil. Il lit la longueur de
 * la plus longue note dans le rapport de la source (`longest_note_length`) :
 * `notes_text` joint les notes, on ne les retrouve pas en le redécoupant.
 */
export const NOTE_TRANSCRIPTION_MIN_CHARS = 500;

interface NoteLike {
  text: string;
}

/** Ce que la règle lit d'un item Tropy (`TropyItem`) : ses notes, celles de ses photos et de leurs sélections. */
export interface ItemNotes {
  notes: readonly NoteLike[];
  photos: ReadonlyArray<{
    notes: readonly NoteLike[];
    selections: ReadonlyArray<{ notes: readonly NoteLike[] }>;
  }>;
}

/** Longueur de la plus longue note de l'item, rognée ; 0 sans note. */
export function longestNoteLength(item: ItemNotes): number {
  const lengthOf = (notes: readonly NoteLike[]): number =>
    notes.reduce((longest, note) => Math.max(longest, note.text ? note.text.trim().length : 0), 0);
  let longest = lengthOf(item.notes);
  for (const photo of item.photos) {
    longest = Math.max(longest, lengthOf(photo.notes));
    for (const selection of photo.selections) {
      longest = Math.max(longest, lengthOf(selection.notes));
    }
  }
  return longest;
}

/** `longestNote` : longueur de la plus longue note de l'item (`longestNoteLength`). */
export function isNoteTranscription(longestNote: number): boolean {
  return longestNote >= NOTE_TRANSCRIPTION_MIN_CHARS;
}
