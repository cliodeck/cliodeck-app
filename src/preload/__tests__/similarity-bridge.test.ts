// @vitest-environment jsdom
// (le preload pose ses écouteurs de liens sur `window` : il tourne toujours dans une page)
/**
 * Le pont de la similarité transmet au main le texte du document ouvert (S13-1-3) : sans lui,
 * `similarity:get-all-results` ne peut pas choisir les segments de ce document, et rendait l'analyse
 * d'un autre chapitre. Vrai preload, derrière le `contextBridge` simulé.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SimulatedElectron } from './helpers/simulated-bridge';

const sim = vi.hoisted(() => ({ current: null as SimulatedElectron | null }));

vi.mock('electron', async () => {
  const { createSimulatedElectron } = await import('./helpers/simulated-bridge');
  sim.current = createSimulatedElectron();
  return sim.current.module;
});

import '../index';

interface SimilarityBridge {
  getAllResults: (text: string) => Promise<unknown>;
}

describe('pont de la similarité', () => {
  it('getAllResults passe le texte reçu à similarity:get-all-results', async () => {
    const electron = sim.current as SimulatedElectron;
    const invoke = vi.spyOn(electron.module.ipcRenderer, 'invoke').mockResolvedValue({ success: true, results: [] });

    const similarity = (electron.exposed() as { similarity: SimilarityBridge }).similarity;
    await similarity.getAllResults('# Chapitre 2\r\n\r\nLe Front populaire.');

    expect(invoke).toHaveBeenCalledWith('similarity:get-all-results', '# Chapitre 2\r\n\r\nLe Front populaire.');
  });
});
