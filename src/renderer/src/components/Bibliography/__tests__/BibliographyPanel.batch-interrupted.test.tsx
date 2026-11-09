// @vitest-environment jsdom
/**
 * Un lot de PDF lancé dans A s'arrête quand B s'ouvre, et le dit (S18-2-0).
 *
 * L'onglet Projets démonte le panneau, mais la suite du geste continue : le lot rendait son bilan
 * de succès par-dessus B, comme si tout avait été fait. Le lot dure des minutes, et l'historien
 * doit savoir qu'il en reste : une alerte, une seule, qui nomme le projet d'origine pour qu'on ne
 * la prenne pas pour un état de B, et dit que relancer le lot là-bas termine le travail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  modified: [] as Array<{
    citationId: string;
    zoteroKey?: string;
    attachmentKey: string;
    citationTitle: string;
    filePath: string;
    reason: string;
  }>,
}));

vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const fr = (await import('../../../../../../public/locales/fr/common.json')).default;
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr } },
    interpolation: { escapeValue: false },
  });
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});
vi.mock('../CitationList', () => ({ CitationList: () => null }));
vi.mock('../ZoteroImport', () => ({ ZoteroImport: () => null }));
vi.mock('../BibliographyStats', () => ({ BibliographyStats: () => null }));
vi.mock('../OrphanPDFModal', () => ({ OrphanPDFModal: () => null }));
vi.mock('../TagManager', () => ({ TagFilter: () => null }));
vi.mock('../PDFModificationNotification', () => ({
  PDFModificationNotification: ({ modifiedPDFs, onReindexAll }: { modifiedPDFs: unknown[]; onReindexAll: () => void }) =>
    modifiedPDFs.length > 0 ? <button onClick={onReindexAll}>Tout ré-indexer</button> : null,
  usePDFModificationDetection: () => ({
    modifiedPDFs: h.modified,
    acknowledge: async () => undefined,
    dismissNotification: () => undefined,
  }),
}));

import { BibliographyPanel } from '../BibliographyPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import type { Citation } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const A = '/projets/memoire-a';
const B = '/projets/these-b';
const project = (path: string, name: string) =>
  ({ id: path, name, path, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() }) as never;

const fromZotero = (id: string): Citation => ({
  id,
  type: 'article',
  author: 'Alpha, A.',
  year: '2020',
  title: `Article ${id}`,
  zoteroKey: `Z${id}`,
  zoteroAttachments: [{ key: `ATT${id}`, filename: `${id}.pdf`, contentType: 'application/pdf', downloaded: false }],
});
const withPdf = (id: string): Citation => ({ ...fromZotero(id), file: `${A}/PDFs/${id}.pdf` });

/** Une réponse du main qu'on rend quand on veut. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let downloadPDF: ReturnType<typeof vi.fn>;
let updateAttachment: ReturnType<typeof vi.fn>;
let pdfIndex: ReturnType<typeof vi.fn>;
let getAll: ReturnType<typeof vi.fn>;
const dialogs = () => useDialogStore.getState();

async function mountIn(citations: Citation[]) {
  useProjectStore.setState({ currentProject: project(A, 'Mémoire A'), loadState: { kind: 'idle' } } as never);
  useBibliographyStore.setState({ citations, filteredCitations: citations } as never);
  await act(async () => {
    render(<BibliographyPanel />);
  });
}

/** Le bouton, puis l'accord de la boîte de confirmation. */
async function launch(title: string) {
  await act(async () => {
    fireEvent.click(screen.getByTitle(title));
  });
  expect(dialogs().confirmOpen).toBe(true);
  await act(async () => {
    dialogs().resolveConfirm(true);
  });
}

/** L'onglet Projets démonte le panneau, puis B s'ouvre avec sa bibliographie. */
const switchToB = () =>
  act(async () => {
    cleanup();
    useProjectStore.setState({ currentProject: project(B, 'Thèse B') } as never);
    useBibliographyStore.setState({ citations: [fromZotero('b1')], filteredCitations: [] } as never);
  });

beforeEach(() => {
  h.modified = [];
  downloadPDF = vi.fn(async (options: { attachmentKey: string; targetDirectory: string }) => ({
    success: true,
    filePath: `${options.targetDirectory}/PDFs/${options.attachmentKey}.pdf`,
  }));
  updateAttachment = vi.fn(async () => ({ success: true }));
  pdfIndex = vi.fn(async () => ({ success: true }));
  getAll = vi.fn(async () => ({ success: true, documents: [] }));
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero-simule' })) },
    project: { getConfig: vi.fn(async () => ({})) },
    zotero: { downloadPDF },
    bibliography: { updateAttachment },
    pdf: { index: pdfIndex, getAll },
  };
});

afterEach(() => {
  cleanup();
  while (dialogs().queue.length > 0) {
    if (dialogs().confirmOpen) dialogs().resolveConfirm(false);
    else dialogs().closeAlert();
  }
});

describe('« Télécharger tous les PDFs manquants depuis Zotero » interrompu par l’ouverture de B', () => {
  it('une seule alerte, qui nomme A et dit ce qui reste, au lieu du bilan de succès', async () => {
    const first = deferred<unknown>();
    downloadPDF.mockReturnValueOnce(first.promise);
    await mountIn([fromZotero('a1'), fromZotero('a2'), fromZotero('a3')]);
    await launch('Télécharger tous les PDFs manquants depuis Zotero');

    await switchToB();
    await act(async () => {
      first.resolve({ success: true, filePath: `${A}/PDFs/ATTa1.pdf` });
    });

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).not.toContain('Téléchargement terminé');
    expect(dialogs().alertMessage).toContain('« Mémoire A »');
    expect(dialogs().alertMessage).not.toContain('Thèse B');
    expect(dialogs().alertMessage).toContain('3 non traité(s)');
    expect(dialogs().alertMessage).toContain('relancez « Télécharger tous les PDFs manquants depuis Zotero »');
    expect(pdfIndex).not.toHaveBeenCalled();
  });

  it('le dernier PDF, téléchargé et rattaché mais pas indexé : l’alerte renvoie à « Indexer tous les PDFs », pas à une relance du téléchargement', async () => {
    // La relance l'écarterait : sa notice a désormais son fichier.
    const written = deferred<unknown>();
    updateAttachment.mockReturnValueOnce(written.promise);
    await mountIn([fromZotero('a1')]);
    await launch('Télécharger tous les PDFs manquants depuis Zotero');
    expect(updateAttachment).toHaveBeenCalledTimes(1);

    await switchToB();
    await act(async () => {
      written.resolve({ success: true });
    });

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).toContain('0 PDF(s) traité(s), 0 erreur(s), 0 non traité(s)');
    expect(dialogs().alertMessage).toContain('1 PDF(s) téléchargé(s) mais non indexé(s)');
    expect(dialogs().alertMessage).toContain('lancez « Indexer tous les PDFs »');
    expect(dialogs().alertMessage).not.toContain('relancez « Télécharger tous les PDFs manquants depuis Zotero »');
    expect(pdfIndex).not.toHaveBeenCalled();
  });

  it('témoin : sans changement de projet, le bilan de succès', async () => {
    await mountIn([fromZotero('a1'), fromZotero('a2')]);
    await launch('Télécharger tous les PDFs manquants depuis Zotero');

    expect(dialogs().alertMessage).toContain('Téléchargement terminé : 2 téléchargés et indexés');
  });
});

describe('« Indexer tous les PDFs » interrompu par l’ouverture de B', () => {
  it('l’alerte nomme A et compte le PDF indexé avant la bascule', async () => {
    const first = deferred<unknown>();
    pdfIndex.mockReturnValueOnce(first.promise);
    await mountIn([withPdf('a1'), withPdf('a2'), withPdf('a3')]);
    await launch('Indexer tous les PDFs');

    await switchToB();
    await act(async () => {
      first.resolve({ success: true });
    });

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).not.toContain('Indexation terminée');
    expect(dialogs().alertMessage).toContain('1 PDF(s) traité(s), 0 erreur(s), 2 non traité(s)');
    expect(dialogs().alertMessage).toContain('« Mémoire A »');
    expect(pdfIndex).toHaveBeenCalledTimes(1);
  });
});

describe('« Tout ré-indexer » interrompu par l’ouverture de B', () => {
  it('le PDF suivant ne part pas, rien n’est relu dans B, et l’alerte nomme A', async () => {
    const citations = [withPdf('a1'), withPdf('a2')];
    h.modified = citations.map((c) => ({
      citationId: c.id,
      zoteroKey: c.zoteroKey,
      attachmentKey: c.zoteroAttachments![0].key,
      citationTitle: c.title,
      filePath: c.file!,
      reason: 'md5-changed',
    }));
    const first = deferred<unknown>();
    pdfIndex.mockReturnValueOnce(first.promise);
    await mountIn(citations);
    getAll.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText('Tout ré-indexer'));
    });
    await act(async () => {
      dialogs().resolveConfirm(true);
    });
    await switchToB();
    await act(async () => {
      first.resolve({ success: true });
    });

    expect(pdfIndex).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).not.toContain('Ré-indexation terminée');
    expect(dialogs().alertMessage).toContain('« Mémoire A »');
    // Le main sait pour quel projet partait le PDF en vol.
    expect(pdfIndex).toHaveBeenCalledWith(`${A}/PDFs/a1.pdf`, undefined, expect.anything(), A);
  });
});

describe('« Télécharger tous les PDFs manquants depuis Zotero » : métadonnées illisibles', () => {
  it('le lot s’arrête au premier PDF, et l’alerte dit où il est, qu’il n’est pas rattaché, et pourquoi', async () => {
    updateAttachment.mockResolvedValueOnce({ success: false, error: 'Unexpected end of JSON input', code: 'metadata-unreadable' });
    await mountIn([fromZotero('a1'), fromZotero('a2'), fromZotero('a3')]);
    await launch('Télécharger tous les PDFs manquants depuis Zotero');

    expect(dialogs().queue).toHaveLength(1);
    const message = dialogs().alertMessage;
    expect(message).toContain(
      '« Télécharger tous les PDFs manquants depuis Zotero » arrêté : 0 PDF(s) traité(s), 0 erreur(s), 2 non traité(s). ' +
        'Les suivants n\'auraient pas pu être rattachés non plus.'
    );
    expect(message).toContain('Le PDF de « Article a1 » a été téléchargé dans PDFs/ (ATTa1.pdf), mais il n\'a pas pu être rattaché');
    expect(message).toContain('.cliodeck/bibliography-metadata.json, qui retient les PDF Zotero rattachés aux références, est illisible');
    expect(message).not.toContain('Téléchargement terminé');
    expect(downloadPDF).toHaveBeenCalledTimes(1);
    expect(pdfIndex).not.toHaveBeenCalled();
  });

  it('le dernier PDF : rien ne dit qu’il y en avait d’autres', async () => {
    updateAttachment.mockResolvedValueOnce({ success: false, error: 'Unexpected end of JSON input', code: 'metadata-unreadable' });
    await mountIn([fromZotero('a1')]);
    await launch('Télécharger tous les PDFs manquants depuis Zotero');

    const message = dialogs().alertMessage;
    expect(message).toContain('arrêté : 0 PDF(s) traité(s), 0 erreur(s), 0 non traité(s).');
    expect(message).not.toContain('Les suivants');
    expect(message).toContain('Le PDF de « Article a1 » a été téléchargé dans PDFs/ (ATTa1.pdf)');
  });
});
