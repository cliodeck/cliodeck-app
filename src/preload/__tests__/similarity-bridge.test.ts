// @vitest-environment jsdom
// (le preload pose ses écouteurs de liens sur `window` : il tourne toujours dans une page)
/**
 * Le pont de la similarité transmet au main le document ouvert, son texte et son fichier
 * (S13-1-3) : sans eux, `similarity:get-all-results` ne peut pas choisir les segments de ce
 * document, et rendait l'analyse d'un autre chapitre, ou ses intertitres communs. Vrai preload,
 * derrière le `contextBridge` simulé.
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
  getAllResults: (text: string, documentPath: string | null) => Promise<unknown>;
  analyze: (text: string, options: unknown, documentPath: string | null) => Promise<unknown>;
}

describe('pont de la similarité', () => {
  it('getAllResults passe le texte et le fichier reçus à similarity:get-all-results', async () => {
    const electron = sim.current as SimulatedElectron;
    const invoke = vi.spyOn(electron.module.ipcRenderer, 'invoke').mockResolvedValue({ success: true, results: [] });

    const similarity = (electron.exposed() as { similarity: SimilarityBridge }).similarity;
    await similarity.getAllResults('# Chapitre 2\r\n\r\nLe Front populaire.', '/projets/livre/chapters/02.md');

    expect(invoke).toHaveBeenCalledWith(
      'similarity:get-all-results',
      '# Chapitre 2\r\n\r\nLe Front populaire.',
      '/projets/livre/chapters/02.md'
    );
  });

  it('analyze passe le fichier du document analysé à similarity:analyze', async () => {
    const electron = sim.current as SimulatedElectron;
    const invoke = vi.spyOn(electron.module.ipcRenderer, 'invoke').mockResolvedValue({ success: true, results: [] });

    const similarity = (electron.exposed() as { similarity: SimilarityBridge }).similarity;
    await similarity.analyze('# Chapitre 1', { useReranking: false }, '/projets/livre/chapters/01.md');

    expect(invoke).toHaveBeenCalledWith(
      'similarity:analyze',
      '# Chapitre 1',
      { useReranking: false },
      '/projets/livre/chapters/01.md'
    );
  });
});
