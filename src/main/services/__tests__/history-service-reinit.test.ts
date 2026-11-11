/**
 * Le journal de recherche après un échec d'ouverture (S13-1-20), et après un `close()` qui lève.
 *
 * `init(B)` fermait le HistoryManager de A, puis `new HistoryManager(B)` pouvait lever (brain.db
 * illisible, volume en lecture seule) : le service gardait l'instance fermée de A sous le chemin de
 * A, et le retour sur A concluait « déjà initialisé », sans rien rouvrir. Et un `close()` qui levait
 * (l'`UPDATE` de fin de session sur la base précédente) rendait toute ouverture suivante impossible
 * jusqu'au redémarrage. Le vrai service ; le HistoryManager est simulé.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeManager {
  projectPath: string;
  open: boolean;
  closeThrows: boolean;
  close: () => void;
  closeOrphanSessions: () => number;
  startSession: () => string;
  endSession: () => void;
  getCurrentSessionId: () => string | null;
}

const state = vi.hoisted(() => ({
  managers: [] as FakeManager[],
  failFor: new Set<string>(),
}));

vi.mock('../../../../backend/core/history/HistoryManager.js', () => ({
  HistoryManager: class {
    constructor(projectPath: string) {
      if (state.failFor.has(projectPath)) throw new Error('SQLITE_READONLY');
      const manager: FakeManager = {
        projectPath,
        open: true,
        closeThrows: false,
        close: () => {
          if (manager.closeThrows) throw new Error('SQLITE_IOERR: UPDATE history_sessions');
          manager.open = false;
        },
        closeOrphanSessions: () => 0,
        startSession: () => 'session',
        endSession: () => undefined,
        getCurrentSessionId: () => null,
      };
      state.managers.push(manager);
      return manager as unknown as object;
    }
  },
}));

const { historyService } = await import('../history-service.js');

beforeEach(() => {
  try {
    historyService.close();
  } catch {
    // un test a laissé un manager qui lève
  }
  state.managers.length = 0;
  state.failFor.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const managerOf = (): FakeManager | null => historyService.getHistoryManager() as unknown as FakeManager | null;

describe('historyService.init — retour sur A après un échec sur B (S13-1-20)', () => {
  it('new HistoryManager(B) lève : init(A) rouvre une base', async () => {
    await historyService.init('/A');
    state.failFor.add('/B');

    await expect(historyService.init('/B')).rejects.toThrow('SQLITE_READONLY');
    await historyService.init('/A');

    expect(managerOf()?.projectPath).toBe('/A');
    expect(managerOf()?.open).toBe(true);
    expect(state.managers).toHaveLength(2);
  });

  it('après l’échec, plus aucun manager ni chemin : rien ne s’écrit dans la base fermée de A', async () => {
    await historyService.init('/A');
    state.failFor.add('/B');

    await expect(historyService.init('/B')).rejects.toThrow();

    expect(historyService.getHistoryManager()).toBeNull();
    expect(historyService.getCurrentProjectPath()).toBeNull();
  });
});

describe('historyService.init — le manager précédent lève à la fermeture', () => {
  it('B s’ouvre quand même, et la fermeture ratée de A est journalisée', async () => {
    await historyService.init('/A');
    state.managers[0].closeThrows = true;

    await historyService.init('/B');

    expect(managerOf()?.projectPath).toBe('/B');
    expect(managerOf()?.open).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });
});
