// @vitest-environment jsdom
/**
 * Réglages → Modes : un refus du main se dit, avec sa raison (S06-1-14, S17-2-7, S15-2-5).
 *
 * Importer le mode JSON d'un collègue dont l'identifiant porte une majuscule : le main répond
 * « Invalid mode file », le dialogue se fermait, la liste restait la même, et rien ne disait
 * pourquoi. Même silence pour l'export vers un dossier en lecture seule, la suppression et la
 * duplication.
 *
 * Vraie section, vrai magasin, vraies locales françaises ; seul le main est imité.
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
  const t = instance.t.bind(instance);
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr' } }),
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { ModeManagerSection } from '../ModeManagerSection';
import { useDialogStore } from '../../../stores/dialogStore';
import { useModeStore } from '../../../stores/modeStore';

const modeApi = {
  getAll: vi.fn(),
  setActive: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  import: vi.fn(),
  export: vi.fn(),
};
vi.spyOn(console, 'error').mockImplementation(() => undefined);
const dialogs = () => useDialogStore.getState();

function mode(id: string, source: 'builtin' | 'global') {
  return {
    metadata: { id, name: { fr: id, en: id }, description: { fr: '', en: '' }, icon: 'Sparkles' },
    generationParams: { temperature: 0.5 },
    ragOverrides: {},
    source,
  };
}

async function openSection(): Promise<void> {
  await act(async () => {
    render(<ModeManagerSection />);
  });
  fireEvent.click(screen.getByText('Modes'));
}

/** Clique et laisse le magasin, puis la section, aller au bout. */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => {
  for (const fn of Object.values(modeApi)) fn.mockReset();
  modeApi.getAll.mockResolvedValue({
    success: true,
    modes: [mode('default-assistant', 'builtin'), mode('analyse', 'global')],
  });
  modeApi.setActive.mockResolvedValue({ success: true });
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    mode: modeApi,
    dialog: {
      openFile: vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/Analyse_Sources.json'] })),
      saveFile: vi.fn(async () => ({ canceled: false, filePath: '/lecture-seule/analyse.json' })),
    },
  };
  useModeStore.setState({ activeModeId: 'default-assistant', activeMode: null, modes: [] });
});

afterEach(() => {
  cleanup();
  while (dialogs().queue.length > 0) dialogs().closeAlert();
});

describe('Réglages → Modes : un refus du main se dit', () => {
  it('import refusé : une alerte nomme le geste et donne la raison', async () => {
    modeApi.import.mockResolvedValue({
      success: false,
      error: 'Invalid mode file: metadata.id must match [a-z0-9-]',
    });
    await openSection();

    await click(screen.getAllByTitle('Importer un mode')[0]);

    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertTitle).toBe("Le mode n'a pas pu être importé");
    expect(dialogs().alertMessage).toContain('Invalid mode file');
  });

  it('export refusé : une alerte, avec la raison du système', async () => {
    modeApi.export.mockResolvedValue({ success: false, error: 'EACCES: permission denied' });
    await openSection();

    await click(screen.getAllByTitle('Exporter')[0]);

    expect(dialogs().alertTitle).toBe("Le mode n'a pas pu être exporté");
    expect(dialogs().alertMessage).toContain('EACCES');
  });

  it('suppression refusée : une alerte, et le mode reste dans la liste', async () => {
    modeApi.delete.mockResolvedValue({ success: false, error: 'EBUSY: resource busy' });
    await openSection();

    // Premier clic : demander confirmation ; second : supprimer.
    await click(screen.getByTitle('Supprimer'));
    await click(screen.getByTitle('Cliquer pour confirmer la suppression'));

    expect(dialogs().alertTitle).toBe("Le mode n'a pas pu être supprimé");
    expect(dialogs().alertMessage).toContain('EBUSY');
    expect(screen.getByText('analyse')).toBeTruthy();
  });

  it('duplication refusée : une alerte, avec la raison', async () => {
    modeApi.save.mockResolvedValue({ success: false, error: 'ENOSPC: no space left on device' });
    await openSection();

    await click(screen.getAllByTitle('Dupliquer')[0]);

    expect(dialogs().alertTitle).toBe("Le mode n'a pas pu être dupliqué");
    expect(dialogs().alertMessage).toContain('ENOSPC');
  });

  it('témoin : un import accepté ne dit rien, et la liste est relue', async () => {
    modeApi.import.mockResolvedValue({ success: true, mode: mode('analyse-sources', 'global') });
    await openSection();
    const reads = modeApi.getAll.mock.calls.length;

    await click(screen.getAllByTitle('Importer un mode')[0]);

    expect(dialogs().alertOpen).toBe(false);
    expect(modeApi.getAll.mock.calls.length).toBe(reads + 1);
  });
});
