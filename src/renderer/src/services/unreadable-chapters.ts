import type { TFunction } from 'i18next';
import type { UnreadableChapter } from '../stores/manuscriptStore';

/** Ce qu'il faut dire à l'auteur des chapitres qu'une opération n'a pas pu lire. */
export function unreadableChaptersNote(
  unreadable: readonly UnreadableChapter[],
  t: TFunction
): string {
  const listed = t('book.unreadableChapters', {
    chapters: unreadable.map((u) => u.chapter.title).join(', '),
  });
  return unreadable.some((u) => u.reason === 'encoding')
    ? `${listed} ${t('book.unreadableNotUtf8')}`
    : listed;
}
