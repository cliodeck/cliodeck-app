import type { TFunction } from 'i18next';
import { useDialogStore } from '../stores/dialogStore';
import { useEditorStore } from '../stores/editorStore';
import { useProjectStore } from '../stores/projectStore';
import { logger } from '../utils/logger';

/**
 * « Nouveau fichier » — implémentation UNIQUE, pour le bouton et le menu.
 *
 * Elle vivait en double, et chaque porte avait son défaut : le bouton vidait
 * l'éditeur en gardant son chemin (l'autosave écrasait document.md 3 s plus tard),
 * le menu partait sans question et sans écrire le fichier ouvert, et sortait
 * l'auteur de son livre.
 *
 * Dans un livre, « nouveau » ajoute un chapitre. Ailleurs, c'est un tampon sans
 * titre hors du projet, dont le fichier est imposé : le fichier ouvert est écrit
 * d'abord et reste accessible depuis le panneau Projet.
 */

// Un même geste peut arriver deux fois (écouteurs de menu doublés) : une seule
// question, un seul chapitre.
let running: Promise<void> | null = null;

export function newDocument(t: TFunction): Promise<void> {
  running ??= run(t).finally(() => {
    running = null;
  });
  return running;
}

async function run(t: TFunction): Promise<void> {
  const { showAlert, showConfirm } = useDialogStore.getState();
  const { filePath, switchLock } = useEditorStore.getState();
  if (switchLock) {
    await showAlert(t(switchLock));
    return;
  }

  const { currentProject, addChapter } = useProjectStore.getState();
  if (currentProject?.type === 'book') {
    try {
      await addChapter(t('book.untitledChapter'));
    } catch (error) {
      logger.error('newDocument', error);
      await showAlert(t('book.addChapterError'));
    }
    return;
  }

  // Sans fichier ouvert, la question est celle de la porte : abandonner le tampon.
  if (filePath && !(await showConfirm(t('toolbar.newFileConfirm')))) return;

  try {
    const outcome = await useEditorStore.getState().createNewFile();
    if (outcome.status === 'locked') await showAlert(t(outcome.lock));
  } catch (error) {
    logger.error('newDocument', error);
    await showAlert(t('toolbar.saveError'));
  }
}
