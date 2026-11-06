import { EventEmitter } from 'node:events';

/**
 * Le preload tel que le renderer le voit : le vrai code de `src/preload/index.ts`, derrière un
 * `contextBridge` simulé qui fait ce que fait le vrai. Chaque fonction qui traverse le pont, dans un
 * sens ou dans l'autre, en ressort sous la forme d'un **nouveau** mandataire, à chaque traversée :
 * passer deux fois le même écouteur au preload lui donne deux fonctions distinctes. C'est ce qui
 * rendait `removeListener` sans effet.
 *
 * `ipcRenderer` est un `EventEmitter`, comme sous Electron 45 : `listenerCount` dit combien
 * d'écouteurs le main réveille par message.
 */
export interface SimulatedElectron {
  /** Ce que le test passe à `vi.mock('electron', …)`. */
  module: {
    ipcRenderer: EventEmitter & {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      send: (channel: string, ...args: unknown[]) => void;
    };
    contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void };
    webUtils: { getPathForFile: () => string };
  };
  /** L'API exposée, telle que la page la reçoit (après la traversée du pont). */
  exposed: () => unknown;
  /** Un message du main, comme `webContents.send(channel, ...args)`. */
  sendFromMain: (channel: string, ...args: unknown[]) => void;
  listenerCount: (channel: string) => number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Une traversée du pont : les fonctions deviennent de nouveaux mandataires, les objets des copies. */
function cross(value: unknown): unknown {
  if (typeof value === 'function') {
    const target = value as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => cross(target(...args.map(cross)));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cross(entry)]));
  }
  return value;
}

export function createSimulatedElectron(): SimulatedElectron {
  const ipcRenderer = Object.assign(new EventEmitter(), {
    invoke: async () => undefined,
    send: () => undefined,
  });
  let exposed: unknown = null;
  return {
    module: {
      ipcRenderer,
      contextBridge: {
        exposeInMainWorld: (_key, api) => {
          exposed = cross(api);
        },
      },
      webUtils: { getPathForFile: () => '' },
    },
    exposed: () => exposed,
    sendFromMain: (channel, ...args) => {
      ipcRenderer.emit(channel, { sender: null }, ...args);
    },
    listenerCount: (channel) => ipcRenderer.listenerCount(channel),
  };
}
