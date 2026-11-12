// @vitest-environment jsdom
/**
 * Le bandeau « PDF modifiés » du panneau Bibliographie (Q22 ; S03-1-4, S03-1-24, S18-1-9).
 *
 * Il ne s'affichait jamais : le hook lisait `result.data?.modifiedPDFs`, alors que
 * `pdf:check-modified-pdfs` renvoie ses champs à plat (`successResponse`). La vérification tournait
 * pourtant au montage, toutes les cinq minutes et à chaque notice modifiée, en relisant tous les
 * PDF. Réparé, il aurait montré deux défauts latents : la liste de A restait affichée dans B, et
 * « Tout ré-indexer » annonçait le succès de tous en fermant le bandeau, échecs compris.
 *
 * Vrais hook et bandeau ; le main est simulé avec la forme réelle de ses réponses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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

import { BibliographyPanel } from '../BibliographyPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import type { Citation } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useEditorStore } from '../../../stores/editorStore';

const A = '/projets/memoire-a';
const B = '/projets/these-b';
const project = (path: string, name: string) =>
  ({ id: path, name, path, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() }) as never;

const withPdf = (projectPath: string, id: string): Citation => ({
  id,
  type: 'article',
  author: 'Alpha, A.',
  year: '2020',
  title: `Article ${id}`,
  zoteroKey: `Z${id}`,
  file: `${projectPath}/PDFs/ATT${id}.pdf`,
  zoteroAttachments: [
    { key: `ATT${id}`, filename: `${id}.pdf`, contentType: 'application/pdf', downloaded: true, md5: 'a'.repeat(32) },
  ],
});

/** Un PDF modifié tel que le main le rapporte, à plat dans la réponse. */
const modified = (c: Citation) => ({
  citationId: c.id,
  citationTitle: c.title,
  filePath: c.file!,
  reason: 'md5-changed',
  zoteroKey: c.zoteroKey,
  attachmentKey: c.zoteroAttachments![0].key,
  oldMD5: 'a'.repeat(32),
  newMD5: `${c.id}`.padEnd(32, '0'),
});
const flat = (pdfs: Array<ReturnType<typeof modified>>) => ({
  success: true,
  modifiedPDFs: pdfs,
  totalChecked: pdfs.length,
  totalModified: pdfs.length,
});

/** Une réponse du main qu'on rend quand on veut. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let checkModifiedPDFs: ReturnType<typeof vi.fn>;
let rememberModifiedPDFs: ReturnType<typeof vi.fn>;
let pdfIndex: ReturnType<typeof vi.fn>;
const dialogs = () => useDialogStore.getState();
const banner = () => screen.queryByText(/PDF\(s\) modifié\(s\) détecté\(s\)/);

async function mountIn(projectPath: string, name: string, citations: Citation[]) {
  useProjectStore.setState({
    currentProject: project(projectPath, name),
    loadState: { kind: 'ready', path: projectPath, loadedAt: '' },
  } as never);
  useBibliographyStore.setState({ citations, filteredCitations: citations } as never);
  await act(async () => {
    render(<BibliographyPanel />);
  });
}

/** B s'ouvre, panneau monté : le projet d'abord, puis sa bibliographie, puis la fin de l'ouverture. */
async function openB(citations: Citation[]) {
  await act(async () => {
    useProjectStore.setState({ currentProject: project(B, 'Thèse B'), loadState: { kind: 'loading', path: B } } as never);
  });
  await act(async () => {
    useBibliographyStore.setState({ citations, filteredCitations: citations } as never);
  });
  await act(async () => {
    useProjectStore.setState({ loadState: { kind: 'ready', path: B, loadedAt: '' } } as never);
  });
}

beforeEach(() => {
  checkModifiedPDFs = vi.fn(async () => flat([]));
  // Comme le main : il dit combien il a retenu.
  rememberModifiedPDFs = vi.fn(async ({ pdfs }: { pdfs: unknown[] }) => ({ success: true, remembered: pdfs.length }));
  pdfIndex = vi.fn(async () => ({ success: true }));
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero-simule' })) },
    project: { getConfig: vi.fn(async () => ({})) },
    pdf: {
      index: pdfIndex,
      getAll: vi.fn(async () => ({ success: true, documents: [] })),
      checkModifiedPDFs,
      rememberModifiedPDFs,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  while (dialogs().queue.length > 0) {
    if (dialogs().confirmOpen) dialogs().resolveConfirm(false);
    else dialogs().closeAlert();
  }
});

describe('Bandeau « PDF modifiés » : la réponse du main', () => {
  it('un PDF modifié, rapporté à plat : le bandeau s’affiche', async () => {
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    await mountIn(A, 'Mémoire A', [a1]);

    expect(banner()?.textContent).toBe('1 PDF(s) modifié(s) détecté(s)');
    expect(checkModifiedPDFs).toHaveBeenCalledWith({ citations: [a1], projectPath: A });
  });

  it('« Ignorer » : le bandeau se ferme, et le projet retient le MD5 du fichier', async () => {
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    await mountIn(A, 'Mémoire A', [a1]);

    await act(async () => {
      fireEvent.click(screen.getByTitle('Ignorer'));
    });

    expect(banner()).toBeNull();
    expect(rememberModifiedPDFs).toHaveBeenCalledWith({
      projectPath: A,
      pdfs: [{ citationId: 'a1', zoteroKey: 'Za1', attachmentKey: 'ATTa1', md5: modified(a1).newMD5 }],
    });
  });

  it('« Ignorer », accepté sans rien retenir : le hook ne le prend pas pour une réponse retenue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    rememberModifiedPDFs.mockResolvedValueOnce({ success: true, remembered: 0 });
    await mountIn(A, 'Mémoire A', [a1]);

    await act(async () => {
      fireEvent.click(screen.getByTitle('Ignorer'));
    });

    expect(warn).toHaveBeenCalledWith('⚠️ PDF modifiés : 1 réponse(s) sur 1 non retenue(s) par le projet');
    warn.mockRestore();
  });

  it('« Ignorer » pendant une vérification : sa réponse, lue avant, ne remet pas le PDF au bandeau', async () => {
    // Le main a lu la mémoire du projet avant que l'historien réponde : sa liste contient encore le
    // PDF qu'il vient d'ignorer.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    await mountIn(A, 'Mémoire A', [a1]);
    expect(banner()).not.toBeNull();

    const inFlight = deferred<unknown>();
    checkModifiedPDFs.mockReturnValueOnce(inFlight.promise);
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(2);

    await act(async () => {
      fireEvent.click(screen.getByTitle('Ignorer'));
    });
    expect(banner()).toBeNull();
    await act(async () => {
      inFlight.resolve(flat([modified(a1)]));
    });

    expect(banner()).toBeNull();
  });
});

describe('Bandeau « PDF modifiés » : « Tout ré-indexer »', () => {
  it('un échec : le message le dit et le nomme, le PDF reste dans le bandeau, seul le réindexé est retenu', async () => {
    const [a1, a2] = [withPdf(A, 'a1'), withPdf(A, 'a2')];
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1), modified(a2)]));
    pdfIndex.mockImplementation(async (file: string) =>
      file === a2.file ? { success: false, error: 'Embedding failed: fetch failed' } : { success: true }
    );
    await mountIn(A, 'Mémoire A', [a1, a2]);
    expect(banner()?.textContent).toBe('2 PDF(s) modifié(s) détecté(s)');

    await act(async () => {
      fireEvent.click(screen.getByText('Tout ré-indexer'));
    });
    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(pdfIndex).toHaveBeenCalledTimes(2);
    expect(dialogs().alertMessage).toContain('Ré-indexation terminée : 1 ré-indexé(s), 1 erreur(s)');
    expect(dialogs().alertMessage).toContain('• Article a2: Embedding failed: fetch failed');
    expect(banner()?.textContent).toBe('1 PDF(s) modifié(s) détecté(s)');
    expect(rememberModifiedPDFs).toHaveBeenCalledTimes(1);
    expect(rememberModifiedPDFs).toHaveBeenCalledWith({
      projectPath: A,
      pdfs: [{ citationId: 'a1', zoteroKey: 'Za1', attachmentKey: 'ATTa1', md5: modified(a1).newMD5 }],
    });
  });

  it('modèle d’embeddings changé depuis l’indexation : le refus se lit traduit, avec le geste qui le règle (L04-7)', async () => {
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    pdfIndex.mockResolvedValue({
      success: false,
      error: 'Embedding dimension mismatch: expected 768, got 1024',
      code: 'embedding_dimension_mismatch',
      expected: 768,
      actual: 1024,
    });
    await mountIn(A, 'Mémoire A', [a1]);

    await act(async () => {
      fireEvent.click(screen.getByText('Tout ré-indexer'));
    });
    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(dialogs().alertMessage).toContain('• Article a1: ');
    expect(dialogs().alertMessage).not.toContain('Embedding dimension mismatch');
    expect(dialogs().alertMessage).toContain('« Purger la base »');
    expect(banner()?.textContent).toBe('1 PDF(s) modifié(s) détecté(s)');
  });

  it('témoin : tout réussi, le bandeau se ferme', async () => {
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    await mountIn(A, 'Mémoire A', [a1]);

    await act(async () => {
      fireEvent.click(screen.getByText('Tout ré-indexer'));
    });
    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(dialogs().alertMessage).toBe('Ré-indexation terminée : 1 ré-indexé(s), 0 erreur(s)');
    expect(banner()).toBeNull();
  });

  it('interrompu par l’ouverture de B : le PDF réindexé avant est retenu par A, celui fini après ne l’est pas, et B garde son bandeau', async () => {
    // Retenus seulement en fin de lot, les PDF réindexés avant l'interruption revenaient à la
    // réouverture de A, et l'historien les réindexait une seconde fois. Celui qui finit après la
    // bascule ne s'écrit pas : ni dans A, que le main n'a plus ouvert, ni comme une réponse donnée
    // dans B, qui jetterait la vérification de B en cours.
    const [a1, a2, b1] = [withPdf(A, 'a1'), withPdf(A, 'a2'), withPdf(B, 'b1')];
    const answerOfB = deferred<unknown>();
    checkModifiedPDFs.mockImplementation(({ projectPath }: { projectPath: string }) =>
      projectPath === A ? Promise.resolve(flat([modified(a1), modified(a2)])) : answerOfB.promise
    );
    const second = deferred<unknown>();
    pdfIndex.mockImplementation((file: string) => (file === a2.file ? second.promise : Promise.resolve({ success: true })));
    await mountIn(A, 'Mémoire A', [a1, a2]);

    await act(async () => {
      fireEvent.click(screen.getByText('Tout ré-indexer'));
    });
    await act(async () => {
      dialogs().resolveConfirm(true);
    });
    expect(pdfIndex).toHaveBeenCalledTimes(2);
    expect(rememberModifiedPDFs.mock.calls).toEqual([
      [{ projectPath: A, pdfs: [{ citationId: 'a1', zoteroKey: 'Za1', attachmentKey: 'ATTa1', md5: modified(a1).newMD5 }] }],
    ]);

    await openB([b1]);
    await act(async () => {
      second.resolve({ success: true });
    });
    await act(async () => {
      answerOfB.resolve(flat([modified(b1)]));
    });

    expect(rememberModifiedPDFs).toHaveBeenCalledTimes(1);
    expect(dialogs().alertMessage).toContain('« Mémoire A »');
    expect(banner()?.textContent).toBe('1 PDF(s) modifié(s) détecté(s)');
    expect(screen.getByText(b1.file!)).not.toBeNull();
  });
});

describe('Bandeau « PDF modifiés » : un projet, une liste', () => {
  it('bandeau affiché dans A, ouverture de B : il disparaît avant que B ait répondu', async () => {
    // La vérification de B reste en attente : seule la remise à zéro au changement de projet peut
    // vider le bandeau. Une réponse vide de B l'aurait vidé de toute façon.
    const a1 = withPdf(A, 'a1');
    const answerOfB = deferred<unknown>();
    checkModifiedPDFs.mockImplementation(({ projectPath }: { projectPath: string }) =>
      projectPath === A ? Promise.resolve(flat([modified(a1)])) : answerOfB.promise
    );
    await mountIn(A, 'Mémoire A', [a1]);
    expect(banner()).not.toBeNull();

    await openB([withPdf(B, 'b1')]);

    expect(checkModifiedPDFs).toHaveBeenLastCalledWith({ citations: [withPdf(B, 'b1')], projectPath: B });
    expect(banner()).toBeNull();
    await act(async () => {
      answerOfB.resolve(flat([]));
    });
    expect(banner()).toBeNull();
  });

  it('bandeau affiché dans A, ouverture de B à la bibliographie vide : il disparaît', async () => {
    // Rien à vérifier dans B : aucune réponse ne viendra vider le bandeau de A.
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockResolvedValue(flat([modified(a1)]));
    await mountIn(A, 'Mémoire A', [a1]);
    expect(banner()).not.toBeNull();

    await openB([]);

    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });

  it('un résultat de A arrivé après l’ouverture de B ne s’affiche pas dans B', async () => {
    const a1 = withPdf(A, 'a1');
    const late = deferred<unknown>();
    checkModifiedPDFs.mockImplementation(({ projectPath }: { projectPath: string }) =>
      projectPath === A ? late.promise : Promise.resolve(flat([]))
    );
    await mountIn(A, 'Mémoire A', [a1]);

    await openB([withPdf(B, 'b1')]);
    await act(async () => {
      late.resolve(flat([modified(a1)]));
    });

    expect(banner()).toBeNull();
  });

  it('pendant l’ouverture de B, les références encore affichées (celles de A) ne sont pas vérifiées pour B', async () => {
    await mountIn(A, 'Mémoire A', [withPdf(A, 'a1')]);
    checkModifiedPDFs.mockClear();

    const b1 = withPdf(B, 'b1');
    await openB([b1]);

    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);
    expect(checkModifiedPDFs).toHaveBeenCalledWith({ citations: [b1], projectPath: B });
  });
});

describe('Bandeau « PDF modifiés » : B sans bibliographie, ouvert par le vrai projectStore', () => {
  // La branche « sans bibliographie » de l'ouverture laissait les références de A dans le store. Le
  // hook les vérifiait pour B, le main (qui ne regarde que les références reçues) signalait le PDF
  // de A, « Tout ré-indexer » le mettait dans le corpus de B, et rien ne pouvait être retenu : B n'a
  // pas de métadonnées. Rejoué dans l'app réelle par la revue.
  const projectFile = (path: string, name: string, bib?: string) => ({
    id: path,
    name,
    path,
    type: 'article' as const,
    createdAt: new Date('2026-01-01').toISOString(),
    lastOpenedAt: new Date('2026-01-02').toISOString(),
    ...(bib ? { bibliographySource: { type: 'file', filePath: bib } } : {}),
  });

  beforeEach(() => {
    const projects: Record<string, ReturnType<typeof projectFile>> = {
      [A]: projectFile(A, 'Mémoire A', 'a.bib'),
      [B]: projectFile(B, 'Thèse B'),
    };
    const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
    Object.assign(electron, {
      project: {
        getConfig: vi.fn(async () => ({})),
        load: vi.fn(async (p: string) => ({ success: true, project: projects[p] })),
        getMetadata: vi.fn(async (p: string) => ({ success: true, project: projects[p] })),
        getRecent: vi.fn(async () => []),
        getChapters: vi.fn(async () => ({ success: true, chapters: [] })),
        close: vi.fn(async () => undefined),
      },
      editor: { loadFile: vi.fn(async () => ({ success: true, content: '# Texte\n' })) },
      fs: { writeFile: vi.fn(async () => undefined) },
      bibliography: {
        loadWithMetadata: vi.fn(async ({ projectPath }: { projectPath: string }) =>
          projectPath === A
            ? { success: true, citations: [withPdf(A, 'a1')], unreadKeys: [], metadataUnreadable: false }
            : { success: false, error: 'inattendu', citations: [] }
        ),
        readingNotes: { list: vi.fn(async () => ({ success: true, notes: [] })) },
      },
    });
    useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null, bufferDetached: false } as never);
    useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null, loadState: { kind: 'idle' }, recentProjects: [] } as never);
    useBibliographyStore.setState({ citations: [], filteredCitations: [], bibliographyProblem: null } as never);
    // Comme le main : il ne regarde que les références reçues, pas le projet qu'on lui nomme.
    checkModifiedPDFs.mockImplementation(async ({ citations }: { citations: Citation[] }) =>
      flat(citations.filter((c) => c.id === 'a1').map(modified))
    );
  });

  it('A a un PDF modifié, B s’ouvre : ni vérification des références de A pour B, ni bandeau', async () => {
    await act(async () => {
      await useProjectStore.getState().loadProject(A);
    });
    await act(async () => {
      render(<BibliographyPanel />);
    });
    expect(banner()?.textContent).toBe('1 PDF(s) modifié(s) détecté(s)');

    await act(async () => {
      await useProjectStore.getState().loadProject(B);
    });

    expect(useProjectStore.getState().currentProject?.path).toBe(B);
    expect(checkModifiedPDFs.mock.calls.filter(([options]) => options.projectPath === B)).toEqual([]);
    expect(banner()).toBeNull();
    expect(screen.queryByText(withPdf(A, 'a1').file!)).toBeNull();
  });
});

describe('Bandeau « PDF modifiés » : le rythme des vérifications', () => {
  it('modifier une notice ne relance pas la vérification', async () => {
    const a1 = withPdf(A, 'a1');
    await mountIn(A, 'Mémoire A', [a1]);
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);

    await act(async () => {
      const edited = [{ ...a1, title: 'Article a1, titre corrigé' }];
      useBibliographyStore.setState({ citations: edited, filteredCitations: edited } as never);
    });

    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);
  });

  it('toutes les cinq minutes, mais une vérification en cours n’en lance pas une autre', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const slow = deferred<unknown>();
    checkModifiedPDFs.mockReturnValueOnce(slow.promise);
    await mountIn(A, 'Mémoire A', [withPdf(A, 'a1')]);
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(flat([]));
    });
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(2);
  });

  it('quitter l’onglet puis y revenir pendant une vérification n’en lance pas une seconde, et le bandeau reçoit la première', async () => {
    // La garde tenait par montage : revenir au panneau relançait la relecture de tous les PDF
    // pendant que la première tournait encore.
    const a1 = withPdf(A, 'a1');
    const slow = deferred<unknown>();
    checkModifiedPDFs.mockReturnValueOnce(slow.promise);
    await mountIn(A, 'Mémoire A', [a1]);
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);

    await act(async () => {
      cleanup();
    });
    await act(async () => {
      render(<BibliographyPanel />);
    });
    expect(checkModifiedPDFs).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(flat([modified(a1)]));
    });
    expect(banner()?.textContent).toBe('1 PDF(s) modifié(s) détecté(s)');
  });
});
