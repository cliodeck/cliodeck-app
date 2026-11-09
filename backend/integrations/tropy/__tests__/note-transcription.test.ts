/**
 * Quand une note Tropy tient-elle lieu de transcription ? Décision G1 : la
 * plus longue note de l'item décide, pas la somme de ses notes.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTE_TRANSCRIPTION_MIN_CHARS,
  isNoteTranscription,
  longestNoteLength,
} from '../note-transcription';

let nextId = 1;
const note = (text: string) => ({ id: nextId++, html: `<p>${text}</p>`, text });

function item(parts: { item?: string[]; photo?: string[]; selection?: string[] }) {
  return {
    notes: (parts.item ?? []).map(note),
    photos: [
      {
        notes: (parts.photo ?? []).map(note),
        selections: [{ notes: (parts.selection ?? []).map(note) }],
      },
    ],
  };
}

describe('longestNoteLength', () => {
  it('prend la plus longue note, qu’elle soit de l’item, d’une photo ou d’une sélection', () => {
    const short = 'a'.repeat(10);
    const long = 'b'.repeat(40);
    expect(longestNoteLength(item({ item: [long], photo: [short], selection: [short] }))).toBe(40);
    expect(longestNoteLength(item({ item: [short], photo: [long], selection: [short] }))).toBe(40);
    expect(longestNoteLength(item({ item: [short], photo: [short], selection: [long] }))).toBe(40);
  });

  it('ne fait pas la somme : trois notes de 200 caractères en valent une de 200', () => {
    const third = 'c'.repeat(200);
    expect(longestNoteLength(item({ item: [third], photo: [third], selection: [third] }))).toBe(200);
  });

  it('ne compte pas les espaces autour d’une note', () => {
    expect(longestNoteLength(item({ photo: [`  \n${'d'.repeat(30)}\n\t `] }))).toBe(30);
  });

  it('rend 0 pour un item sans note', () => {
    expect(longestNoteLength({ notes: [], photos: [] })).toBe(0);
    expect(longestNoteLength(item({ item: ['   '] }))).toBe(0);
  });
});

describe('isNoteTranscription', () => {
  it('le seuil compte : 500 caractères tiennent lieu de transcription, 499 non', () => {
    expect(isNoteTranscription(NOTE_TRANSCRIPTION_MIN_CHARS)).toBe(true);
    expect(isNoteTranscription(NOTE_TRANSCRIPTION_MIN_CHARS - 1)).toBe(false);
  });

  it('plusieurs notes courtes dont la somme passe le seuil ne retiennent pas l’OCR', () => {
    const third = 'e'.repeat(200);
    expect(isNoteTranscription(longestNoteLength(item({ item: [third], photo: [third], selection: [third] })))).toBe(false);
    expect(isNoteTranscription(longestNoteLength(item({ photo: ['f'.repeat(600)] })))).toBe(true);
  });
});
