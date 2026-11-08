import type { TFunction } from 'i18next';
import type { UnlinkedFootnote } from '@/editor/footnote-tools';

/** Au-delà, la liste s'arrête : l'alerte doit rester lisible. */
const MAX_LISTED = 8;

/**
 * Ce qu'il faut dire à l'auteur des notes que la renumérotation n'a pas pu
 * lier, ou `null` s'il n'y a rien à dire. `title` nomme le chapitre d'un
 * livre ; un article n'en a pas.
 */
export function unlinkedFootnotesNote(
  docs: ReadonlyArray<{ title?: string; unlinked: readonly UnlinkedFootnote[] }>,
  t: TFunction
): string | null {
  const notes = (kind: UnlinkedFootnote['kind']): string[] =>
    docs.flatMap((doc) =>
      doc.unlinked
        .filter((u) => u.kind === kind)
        .map((u) =>
          doc.title === undefined
            ? `[^${u.label}]`
            : t('editor.renumberNoteInChapter', { note: `[^${u.label}]`, chapter: doc.title })
        )
    );
  const listed = (all: string[]): string =>
    all.length > MAX_LISTED ? `${all.slice(0, MAX_LISTED).join(', ')}, …` : all.join(', ');

  const parts: string[] = [];
  const missingDefinition = notes('reference');
  if (missingDefinition.length > 0) {
    parts.push(
      t('editor.renumberMissingDefinition', {
        count: missingDefinition.length,
        notes: listed(missingDefinition),
      })
    );
  }
  const missingCall = notes('definition');
  if (missingCall.length > 0) {
    parts.push(
      t('editor.renumberMissingCall', { count: missingCall.length, notes: listed(missingCall) })
    );
  }
  const glued = notes('glued');
  if (glued.length > 0) {
    parts.push(t('editor.renumberGlued', { count: glued.length, notes: listed(glued) }));
  }
  if (parts.length === 0) return null;
  return t('editor.renumberUnlinked', { detail: parts.join(' ') });
}
