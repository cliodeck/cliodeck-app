/**
 * Ouvrir un extrait du manuscrit — la seule source que l'auteur a écrite.
 *
 * Les trois autres corpus sortent de ClioDeck : leur click-through délègue à
 * l'OS via `window.electron.sources.*` (visionneuse PDF, gestionnaire de
 * fichiers, Obsidian). Le manuscrit est le seul qui vit **dans le projet** et
 * s'ouvre dans l'éditeur de ClioDeck. L'y ramener n'est pas un raffinement :
 * faire passer un chapitre par `sources:open-note` serait un **bug**, ce canal
 * résolvant son chemin relatif contre le **vault Obsidian** et non contre le
 * dossier du projet — il ouvrirait un autre fichier, ou rien.
 *
 * Deux propriétés portées par ce module :
 *
 * 1. **La bascule reste sûre.** Elle passe par `editorStore.loadFile`, qui
 *    sauvegarde le fichier sortant avant de charger le suivant et refuse de
 *    charger si cette sauvegarde échoue (verrou de la phase 0 du chantier
 *    livre). Aucune frappe non sauvegardée n'est perdue en suivant une
 *    citation.
 * 2. **Garde anti-évasion.** Un extrait dont le chemin sortirait du dossier
 *    projet est refusé. La garde du main (`manuscript-assembler.ts`) s'appuie
 *    sur `path` de Node, indisponible ici : celle-ci raisonne sur la chaîne,
 *    comme le reste du renderer, qui compose ses chemins par concaténation.
 */

import type { BrainstormSource } from '../stores/chatStore';
import { useEditorStore } from '../stores/editorStore';
import { useProjectStore } from '../stores/projectStore';
import { useWorkspaceModeStore } from '../stores/workspaceModeStore';
import { currentRelativePath } from '../stores/manuscriptStore';
import { logger } from '../utils/logger';

/** Même forme que les handlers `sources:*`, pour que l'appelant ne branche pas. */
export interface OpenManuscriptResult {
  success: boolean;
  /** Clé i18n à afficher, jamais un message déjà traduit. */
  errorKey?: string;
}

/**
 * Le chemin reste-t-il sous le dossier projet ?
 *
 * Pur et exporté pour être testé seul. Refuse : le vide, l'absolu (POSIX,
 * lettre de lecteur Windows, UNC) et tout segment `..`. Les segments `.` sont
 * inoffensifs et tolérés.
 */
export function isSafeProjectRelativePath(relPath: string): boolean {
  if (!relPath) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(relPath)) return false;
  return !relPath.split(/[\\/]/).includes('..');
}

/** Champs dont l'ouverture a besoin — un sous-ensemble de `BrainstormSource`. */
type ManuscriptSourceFields = Pick<
  BrainstormSource,
  'relativePath' | 'notePath' | 'lineNumber' | 'chapterId'
>;

/** Le chemin d'un extrait de manuscrit, quel que soit le champ qui le porte. */
export function manuscriptRelativePath(source: ManuscriptSourceFields): string | null {
  return source.relativePath ?? source.notePath ?? null;
}

/**
 * Le popover peut-il proposer l'ouverture de cet extrait ? Pur, pour que le
 * bouton et l'action partagent exactement la même condition — les deux portes
 * doivent donner le même résultat.
 */
export function canOpenManuscriptSource(source: ManuscriptSourceFields): boolean {
  const rel = manuscriptRelativePath(source);
  return !!rel && isSafeProjectRelativePath(rel);
}

/**
 * Bascule vers le chapitre porteur de l'extrait et pose le curseur.
 *
 * Passe le plan de travail en mode Écriture : un extrait de manuscrit ne se
 * lit que dans l'éditeur, et le popover peut être ouvert depuis Brainstorm
 * (chat plein) comme depuis un panneau droit. Sans cette bascule, « Ouvrir la
 * source » ne produirait rien de visible depuis Brainstorm.
 */
export async function openManuscriptSource(
  source: ManuscriptSourceFields
): Promise<OpenManuscriptResult> {
  const relPath = manuscriptRelativePath(source);
  if (!relPath) return { success: false, errorKey: 'chat.sources.untrackableManuscript' };
  if (!isSafeProjectRelativePath(relPath)) {
    logger.error('openManuscriptSource', `chemin hors projet refusé : ${relPath}`);
    return { success: false, errorKey: 'chat.sources.manuscriptOutsideProject' };
  }

  const { currentProject, chapters, setCurrentChapter } = useProjectStore.getState();
  if (!currentProject) {
    return { success: false, errorKey: 'chat.sources.manuscriptNoProject' };
  }

  // L'éditeur n'est visible qu'en mode Écriture.
  useWorkspaceModeStore.getState().setActive('write');

  // Déjà ouvert : ne pas repasser par `loadFile`, qui recrée la vue et
  // détruirait l'historique d'annulation du chapitre pour rien.
  if (currentRelativePath() !== relPath) {
    try {
      await useEditorStore.getState().loadFile(`${currentProject.path}/${relPath}`);
    } catch (error) {
      logger.error('openManuscriptSource', error);
      return { success: false, errorKey: 'chat.sources.openFailed' };
    }
  }

  // Rattacher le chapitre courant quand l'extrait sait d'où il vient : le
  // navigateur et les fonctions d'ouvrage lisent cet identifiant. On ne le
  // devine pas depuis le chemin — un `chapterId` absent laisse l'état tel quel.
  if (source.chapterId && chapters.some((c) => c.id === source.chapterId)) {
    setCurrentChapter(source.chapterId);
  }

  if (source.lineNumber != null) {
    // Après `loadFile` la façade est reconstruite : lire l'état frais.
    useEditorStore.getState().editorFacade?.revealLine(source.lineNumber);
  }

  return { success: true };
}
