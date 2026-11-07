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
 * Pas de dépendance ici : le renderer importe ce module pour expliquer la
 * règle sur la source concernée, avec le même seuil.
 */
export const NOTE_TRANSCRIPTION_MIN_CHARS = 500;

/** `notesLength` : longueur du texte des notes de l'item, photos et sélections comprises. */
export function isNoteTranscription(notesLength: number): boolean {
  return notesLength >= NOTE_TRANSCRIPTION_MIN_CHARS;
}
