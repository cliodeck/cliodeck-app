/**
 * Régression : le verrou de #30 n'était consulté que dans UN sens. Les
 * exports refusaient de partir pendant une renumérotation, mais rien
 * n'empêchait de renuméroter pendant un export déjà lancé — dont
 * l'assemblage lit les chapitres pendant plusieurs secondes. Le manuscrit
 * était alors réécrit sous l'assemblage en cours : exactement le scénario
 * que le correctif prétendait fermer.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useManuscriptStore } from '../manuscriptStore';
import { useDialogStore } from '../dialogStore';

const reason = () => useManuscriptStore.getState().manuscriptBusyReason();

describe('verrou du manuscrit', () => {
  beforeEach(() => {
    useManuscriptStore.getState().setRenumbering(false);
    useManuscriptStore.getState().setExporting(false);
  });

  it('est libre au repos', () => {
    expect(reason()).toBeUndefined();
  });

  it('bloque pendant une renumérotation', () => {
    useManuscriptStore.getState().setRenumbering(true);
    expect(reason()).toBe('book.renumberInProgress');
  });

  it('bloque AUSSI pendant un export — le sens qui manquait', () => {
    useManuscriptStore.getState().setExporting(true);
    expect(reason()).toBe('book.exportInProgress');
  });

  it('se libère quand l’opération se termine', () => {
    useManuscriptStore.getState().setExporting(true);
    useManuscriptStore.getState().setExporting(false);
    expect(reason()).toBeUndefined();

    useManuscriptStore.getState().setRenumbering(true);
    useManuscriptStore.getState().setRenumbering(false);
    expect(reason()).toBeUndefined();
  });

  it('signale la renumérotation en priorité si les deux sont posés', () => {
    // Ne devrait pas arriver, mais le message doit rester déterministe.
    useManuscriptStore.getState().setRenumbering(true);
    useManuscriptStore.getState().setExporting(true);
    expect(reason()).toBe('book.renumberInProgress');
  });

  /**
   * La renumérotation tient le verrou jusqu'à la fermeture de son alerte
   * finale (`handleRenumberFootnotes`, EditorPanel). Une alerte de fond qui
   * survenait à ce moment — fin d'un téléchargement Zotero, par exemple —
   * écrasait son résolveur : l'attente ne se terminait jamais, le `finally`
   * ne relâchait rien, et exports comme renumérotation restaient refusés
   * jusqu'au redémarrage.
   */
  it('se libère même si une alerte tierce survient pendant l’attente', async () => {
    const dialogs = () => useDialogStore.getState();
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    void (async () => {
      useManuscriptStore.getState().setRenumbering(true);
      try {
        await dialogs().showAlert('book.renumberDone');
      } finally {
        useManuscriptStore.getState().setRenumbering(false);
      }
    })();
    void dialogs().showAlert('bibliography.pdfDownloadedAndIndexed');

    expect(reason()).toBe('book.renumberInProgress');

    dialogs().closeAlert();
    await flush();
    dialogs().closeAlert();
    await flush();

    expect(reason()).toBeUndefined();
    expect(dialogs().alertOpen).toBe(false);
  });
});
