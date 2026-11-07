/**
 * Quand une note Tropy tient-elle lieu de transcription ?
 *
 * Rien dans Tropy ne distingue une remarque (« voir aussi carton 12 ») d'une
 * transcription faite à la main : on en juge à la longueur (décision Q26 de
 * l'auteur). En dessous du seuil, la note est un commentaire et l'OCR passe ;
 * au-delà, c'est une transcription et l'OCR ne passe que sous « Relancer
 * l'OCR » (`forceReindex`). Dans les deux cas, une note ne remplace jamais une
 * transcription existante (tesseract, manual, transkribus).
 *
 * Le seuil porte sur l'ensemble des notes de l'item — item, photos et
 * sélections, jointes comme dans `notes_text` —, pas sur chacune : une
 * transcription faite à la main se découpe d'ordinaire en une note par page,
 * dont aucune n'atteindrait le seuil, et l'OCR repasserait sur un document
 * déjà transcrit. Revers assumé : une trentaine d'annotations courtes de
 * sélections comptent aussi ensemble ; l'OCR attend alors « Relancer l'OCR »,
 * et le rapport de la source le dit (`OCRSourceReport`). Les deux cas sont
 * fixés par `TropySync.e2e.test.ts`.
 *
 * Pas de dépendance ici : le renderer importe ce module pour expliquer la
 * règle sur la source concernée, avec le même seuil.
 */
export const NOTE_TRANSCRIPTION_MIN_CHARS = 500;

/** `notesLength` : longueur du texte de toutes les notes de l'item, photos et sélections comprises. */
export function isNoteTranscription(notesLength: number): boolean {
  return notesLength >= NOTE_TRANSCRIPTION_MIN_CHARS;
}
