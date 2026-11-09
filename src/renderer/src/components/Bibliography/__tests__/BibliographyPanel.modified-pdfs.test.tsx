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
  rememberModifiedPDFs = vi.fn(async () => ({ success: true }));
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
});

describe('Bandeau « PDF modifiés » : un projet, une liste', () => {
  it('bandeau affiché dans A, ouverture de B : il disparaît', async () => {
    const a1 = withPdf(A, 'a1');
    checkModifiedPDFs.mockImplementation(async ({ projectPath }: { projectPath: string }) =>
      projectPath === A ? flat([modified(a1)]) : flat([])
    );
    await mountIn(A, 'Mémoire A', [a1]);
    expect(banner()).not.toBeNull();

    await openB([withPdf(B, 'b1')]);

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
});
