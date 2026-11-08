// @vitest-environment jsdom
/**
 * « Indexer PDF » sur une fiche Zotero : un PDF téléchargé que le main ne rattache pas.
 *
 * Le PDF est dans `PDFs/`, mais `bibliography-metadata.json` ne se lit pas : le rattachement n'est
 * pas écrit, et au lancement suivant la référence n'aurait pas de PDF. L'historien doit savoir où
 * est le fichier, qu'il n'est pas rattaché, et quoi faire, dans les mots du bandeau des
 * métadonnées illisibles, au lieu de « Erreur de téléchargement : » suivi du texte brut du main.
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

import { CitationCard } from '../CitationCard';
import { useBibliographyStore, type Citation } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';

const PROJECT = '/projets/memoire';
const citation: Citation = {
  id: 'guerre_2023',
  type: 'article',
  author: 'Martin, A.',
  year: '2023',
  title: 'La guerre de l’intelligence artificielle',
  zoteroKey: 'XKEY2023',
  zoteroAttachments: [
    { key: 'QQBJJVQY', filename: '2023 - Documents sauvegardés.pdf', contentType: 'application/pdf', downloaded: false },
  ],
};

let updateAttachment: ReturnType<typeof vi.fn>;
let pdfIndex: ReturnType<typeof vi.fn>;

async function download(): Promise<void> {
  render(<CitationCard citation={citation} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Martin, A.'));
  });
  await act(async () => {
    fireEvent.click(screen.getByText('Indexer PDF'));
  });
}

beforeEach(() => {
  updateAttachment = vi.fn(async () => ({ success: true }));
  pdfIndex = vi.fn(async () => ({ success: true }));
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero-simule' })) },
    project: { getConfig: vi.fn(async () => ({})) },
    zotero: {
      downloadPDF: vi.fn(async () => ({ success: true, filePath: `${PROJECT}/PDFs/2023_-_Documents_sauvegardés.pdf` })),
    },
    bibliography: { updateAttachment },
    pdf: { index: pdfIndex },
  };
  useProjectStore.setState({
    currentProject: { id: 'm', name: 'Mémoire', path: PROJECT, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'idle' },
  } as never);
  useBibliographyStore.setState({
    citations: [citation],
    filteredCitations: [citation],
    indexedFilePaths: new Set(),
    indexedBibtexKeys: new Set(),
    readingNotes: [],
  } as never);
});

afterEach(() => {
  cleanup();
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('CitationCard : un PDF téléchargé mais pas rattaché', () => {
  it('métadonnées illisibles : l’alerte dit où est le PDF, qu’il n’est pas rattaché, et quoi faire', async () => {
    updateAttachment.mockResolvedValueOnce({ success: false, error: 'Unexpected end of JSON input', code: 'metadata-unreadable' });

    await download();

    const message = useDialogStore.getState().alertMessage;
    expect(message).toBe(
      'Le PDF de « La guerre de l’intelligence artificielle » a été téléchargé dans PDFs/ (2023_-_Documents_sauvegardés.pdf), ' +
        'mais il n\'a pas pu être rattaché à la référence, qui reste sans PDF ; il n\'a pas été indexé. ' +
        '.cliodeck/bibliography-metadata.json, qui retient les PDF Zotero rattachés aux références, est illisible. ' +
        'Réparez-le, ou remettez-en une copie, puis relancez le téléchargement.'
    );
    expect(pdfIndex).not.toHaveBeenCalled();
  });

  it('autre échec : la même phrase, avec la cause du main', async () => {
    updateAttachment.mockResolvedValueOnce({ success: false, error: 'EACCES: permission denied' });

    await download();

    const message = useDialogStore.getState().alertMessage;
    expect(message).toContain('a été téléchargé dans PDFs/ (2023_-_Documents_sauvegardés.pdf)');
    expect(message).toContain('Cause : EACCES: permission denied');
    expect(pdfIndex).not.toHaveBeenCalled();
  });

  it('témoin : rattaché puis indexé, l’alerte de succès', async () => {
    await download();

    expect(useDialogStore.getState().alertMessage).toBe('PDF téléchargé et indexé');
    expect(pdfIndex).toHaveBeenCalledTimes(1);
  });
});
