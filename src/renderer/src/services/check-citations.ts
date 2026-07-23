import type { TFunction } from 'i18next';
import { collectCitationKeys } from '@/editor/citation-tools';
import { useEditorStore } from '../stores/editorStore';
import { useBibliographyStore } from '../stores/bibliographyStore';
import { useProjectStore } from '../stores/projectStore';
import { useManuscriptStore } from '../stores/manuscriptStore';
import { useDialogStore } from '../stores/dialogStore';
import { logger } from '../utils/logger';

/**
 * Vérification des citations — implémentation UNIQUE.
 *
 * Elle vivait en double : la version de la barre d'outils (arbre Lezer, tout
 * le manuscrit) et une version périmée dans le menu (regex sur le seul
 * contenu courant). Selon la porte empruntée, l'utilisateur obtenait deux
 * résultats différents : la version regex signalait des `[@…]` situés dans
 * des blocs de code, ne voyait qu'un chapitre, et comptait comme
 * « doublons » des sources légitimement citées plusieurs fois dans un
 * ouvrage. Toute nouvelle entrée (bouton, menu, raccourci) doit appeler
 * cette fonction, jamais recomposer la logique.
 *
 * Les clés sont relevées sur l'arbre (`collectCitationKeys`) : les `[@…]`
 * des blocs de code ne comptent pas, les citations nues (`@clef`) sont vues,
 * et un cluster `[@a; @b]` compte deux clés. Dans un livre, la vérification
 * porte sur TOUT le manuscrit et situe chaque clé manquante dans son
 * chapitre.
 */

export interface CitationCheckResult {
  /** Nombre total de clés rencontrées (toutes occurrences confondues). */
  total: number;
  /** Clé manquante -> chapitres où elle apparaît (vide hors projet livre). */
  missing: Map<string, Set<string>>;
}

/** Relève les clés et confronte à la bibliographie. Sans effet de bord. */
export async function checkCitations(): Promise<CitationCheckResult> {
  const availableKeys = new Set(
    useBibliographyStore.getState().citations.map((c) => c.id)
  );
  const isBook = useProjectStore.getState().currentProject?.type === 'book';

  const sources: Array<{ label: string | null; content: string }> = isBook
    ? (await useManuscriptStore.getState().readManuscript()).map((d) => ({
        label: d.chapter.title,
        content: d.content,
      }))
    : [{ label: null, content: useEditorStore.getState().getLiveContent() }];

  const missing = new Map<string, Set<string>>();
  let total = 0;
  for (const source of sources) {
    for (const occurrence of collectCitationKeys(source.content)) {
      total += 1;
      if (availableKeys.has(occurrence.key)) continue;
      const where = missing.get(occurrence.key) ?? new Set<string>();
      if (source.label) where.add(source.label);
      missing.set(occurrence.key, where);
    }
  }

  return { total, missing };
}

/** Met en forme le rapport destiné à l'utilisateur. */
export function formatCitationReport(
  result: CitationCheckResult,
  t: TFunction
): string {
  if (result.missing.size === 0) {
    return t('citations.allValid', { count: result.total });
  }
  const lines = [...result.missing.entries()].map(([key, where]) =>
    where.size > 0 ? `[@${key}] — ${[...where].join(', ')}` : `[@${key}]`
  );
  return `${t('citations.missing', { count: result.missing.size })}\n\n${lines.join('\n')}`;
}

/**
 * Vérifie puis affiche le résultat. C'est ce que doivent appeler le bouton
 * de la barre d'outils comme l'entrée de menu.
 */
export async function runCitationCheck(t: TFunction): Promise<void> {
  try {
    const result = await checkCitations();
    await useDialogStore.getState().showAlert(formatCitationReport(result, t));
  } catch (error) {
    logger.error('CheckCitations', error);
    await useDialogStore.getState().showAlert(t('citations.checkError'));
  }
}
