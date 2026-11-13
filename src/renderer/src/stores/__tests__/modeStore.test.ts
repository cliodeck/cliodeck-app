// @vitest-environment jsdom
/**
 * Le magasin des modes lit ce que le main répond (S06-1-14).
 *
 * Les handlers `mode:*` ne lèvent pas : un refus répond `{ success: false, error }`, et
 * `ipcRenderer.invoke` le résout. Le magasin attendait l'appel sans lire la réponse : un mode
 * refusé à l'import passait pour importé (« Mode imported » au journal, liste rechargée), et une
 * suppression refusée basculait quand même sur le mode par défaut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModeStore } from '../modeStore';
import { IpcError } from '../../utils/ipc-outcome';

const REFUSED = { success: false, error: 'Invalid mode file: metadata.id must match [a-z0-9-]' };

const modeApi = {
  getAll: vi.fn(),
  setActive: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  import: vi.fn(),
  export: vi.fn(),
};
const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
vi.spyOn(console, 'error').mockImplementation(() => undefined);

function mode(id: string) {
  return {
    metadata: { id, name: { fr: id, en: id }, description: { fr: '', en: '' }, icon: 'Sparkles' },
    generationParams: { temperature: 0.5 },
    ragOverrides: {},
    source: 'global',
  };
}

beforeEach(() => {
  for (const fn of Object.values(modeApi)) fn.mockReset();
  modeApi.getAll.mockResolvedValue({ success: true, modes: [mode('default-assistant'), mode('analyse')] });
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
  useModeStore.setState({ activeModeId: 'analyse', activeMode: null, modes: [] });
  log.mockClear();
});

afterEach(() => {
  useModeStore.setState({ activeModeId: 'default-assistant', activeMode: null, modes: [] });
});

const succeeded = (word: string) => log.mock.calls.some((call) => String(call[0]).includes(word));

describe('modeStore : un refus du main est un échec', () => {
  it('import refusé : importMode rejette avec la raison, et ne journalise pas de succès', async () => {
    modeApi.import.mockResolvedValue(REFUSED);

    const error = await useModeStore.getState().importMode('global').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IpcError);
    expect((error as Error).message).toContain('Invalid mode file');
    expect(succeeded('Mode imported')).toBe(false);
  });

  it('export refusé : exportMode rejette, sans annoncer l’export', async () => {
    modeApi.export.mockResolvedValue({ success: false, error: "EACCES: permission denied, open '/lecture-seule/analyse.json'" });

    await expect(useModeStore.getState().exportMode('analyse')).rejects.toThrow('EACCES');
    expect(succeeded('Mode exported')).toBe(false);
  });

  it('enregistrement refusé : saveCustomMode rejette, sans annoncer l’enregistrement', async () => {
    modeApi.save.mockResolvedValue(REFUSED);

    await expect(
      useModeStore.getState().saveCustomMode(mode('analyse-copy') as never, 'global')
    ).rejects.toThrow('Invalid mode file');
    expect(succeeded('Custom mode saved')).toBe(false);
  });

  it('suppression refusée : le mode actif reste, et rien ne bascule sur le mode par défaut', async () => {
    modeApi.delete.mockResolvedValue({ success: false, error: 'EBUSY: resource busy' });

    await expect(useModeStore.getState().deleteCustomMode('analyse', 'global')).rejects.toThrow('EBUSY');

    expect(useModeStore.getState().activeModeId).toBe('analyse');
    expect(modeApi.setActive).not.toHaveBeenCalled();
  });

  it('activation refusée : le mode affiché ne change pas', async () => {
    useModeStore.setState({ modes: [mode('default-assistant'), mode('analyse')] as never });
    modeApi.setActive.mockResolvedValue({ success: false, error: 'mode inconnu' });

    await useModeStore.getState().setActiveMode('default-assistant');

    expect(useModeStore.getState().activeModeId).toBe('analyse');
  });
});

describe('modeStore : témoins, quand le main accepte', () => {
  it('import accepté : la liste est relue', async () => {
    modeApi.import.mockResolvedValue({ success: true, mode: mode('analyse-sources') });

    await useModeStore.getState().importMode('global');

    expect(modeApi.getAll).toHaveBeenCalledTimes(1);
  });

  it('suppression du mode actif acceptée : bascule sur le mode par défaut', async () => {
    modeApi.delete.mockResolvedValue({ success: true });

    await useModeStore.getState().deleteCustomMode('analyse', 'global');

    expect(modeApi.setActive).toHaveBeenCalledWith('default-assistant');
    expect(useModeStore.getState().activeModeId).toBe('default-assistant');
  });
});
