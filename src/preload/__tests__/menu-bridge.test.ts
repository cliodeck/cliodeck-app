// @vitest-environment jsdom
// (le preload pose ses écouteurs de liens sur `window` : il tourne toujours dans une page)
/**
 * Le pont générique des commandes de menu (`window.electron.ipcRenderer`).
 *
 * Il passait au vrai `ipcRenderer` la fonction reçue du renderer, et offrait un
 * `removeListener` qui lui repassait la même. Or `contextBridge` livre un nouveau mandataire à
 * chaque traversée : le retrait ne retrouvait jamais l'écouteur, et chaque relance de l'effet de
 * `useMenuShortcuts` en ajoutait une série. Chaque commande de menu s'exécutait deux fois dès le
 * lancement : deux notes de bas de page, un gras qui se défaisait (S15-1-22).
 *
 * Le `contextBridge` est simulé (`helpers/simulated-bridge.ts`) : le vrai n'existe que dans
 * Electron, où `e2e/journey-menu-commands.spec.ts` vérifie le même contrat.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SimulatedElectron } from './helpers/simulated-bridge';

const sim = vi.hoisted(() => ({ current: null as SimulatedElectron | null }));

vi.mock('electron', async () => {
  const { createSimulatedElectron } = await import('./helpers/simulated-bridge');
  sim.current = createSimulatedElectron();
  return sim.current.module;
});

import '../index';

const electron = () => sim.current as SimulatedElectron;

interface MenuBridge {
  on: (channel: string, listener: (...args: unknown[]) => void) => unknown;
  send: (channel: string, ...args: unknown[]) => void;
}
const bridge = () => (electron().exposed() as { ipcRenderer: MenuBridge }).ipcRenderer;

describe('pont des commandes de menu', () => {
  it('on() renvoie un désabonnement qui retire l’écouteur, quoi que le pont ait fait de la fonction', () => {
    const listener = vi.fn();
    const off = bridge().on('menu:insert-footnote', listener);

    expect(typeof off).toBe('function');
    expect(electron().listenerCount('menu:insert-footnote')).toBe(1);

    (off as () => void)();
    expect(electron().listenerCount('menu:insert-footnote')).toBe(0);
    electron().sendFromMain('menu:insert-footnote');
    expect(listener).not.toHaveBeenCalled();
  });

  it('un effet relancé deux fois laisse un seul écouteur : une commande, une exécution', () => {
    const listener = vi.fn();
    for (let run = 0; run < 3; run += 1) {
      const off = bridge().on('menu:format-bold', listener) as () => void;
      if (run < 2) off();
    }

    electron().sendFromMain('menu:format-bold');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('l’écouteur reçoit les arguments du main, sans l’événement IPC', () => {
    const listener = vi.fn();
    const off = bridge().on('menu:switch-panel', listener) as () => void;

    electron().sendFromMain('menu:switch-panel', 'bibliography');
    expect(listener).toHaveBeenCalledWith('bibliography');
    off();
  });

  it('removeListener n’est plus exposé : à travers le pont, il ne peut rien retirer', () => {
    expect('removeListener' in bridge()).toBe(false);
  });

  it('un canal hors de la liste blanche : rien d’enregistré, et un désabonnement sans effet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const off = bridge().on('pdf:index', vi.fn());

    expect(electron().listenerCount('pdf:index')).toBe(0);
    expect(typeof off).toBe('function');
    expect(() => (off as () => void)()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
