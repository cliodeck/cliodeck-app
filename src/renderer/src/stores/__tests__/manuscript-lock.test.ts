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
   * La renumérotation relâche le verrou AVANT son alerte finale : elle le
   * tenait jusqu'à la fermeture du dialogue, et une alerte de fond (fin d'un
   * téléchargement Zotero, par exemple) laissait exports et renumérotation
   * refusés tant que personne n'avait tout fermé. `handleRenumberFootnotes`
   * lui-même est couvert par `Editor/__tests__/renumber-switch.test.tsx` ; ici,
   * la même séquence ramenée au verrou et à la file de dialogues.
   */
  it('est déjà libre pendant l’alerte finale, même si une alerte tierce survient', async () => {
    const dialogs = () => useDialogStore.getState();
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    void (async () => {
      useManuscriptStore.getState().setRenumbering(true);
      try {
        // Les chapitres s'écrivent ici.
      } finally {
        useManuscriptStore.getState().setRenumbering(false);
      }
      await dialogs().showAlert('book.renumberDone');
    })();
    void dialogs().showAlert('bibliography.pdfDownloadedAndIndexed');

    expect(reason()).toBeUndefined();
    expect(dialogs().alertMessage).toBe('book.renumberDone');

    dialogs().closeAlert();
    await flush();
    expect(dialogs().alertMessage).toBe('bibliography.pdfDownloadedAndIndexed');
    dialogs().closeAlert();
    await flush();

    expect(dialogs().alertOpen).toBe(false);
  });
});
