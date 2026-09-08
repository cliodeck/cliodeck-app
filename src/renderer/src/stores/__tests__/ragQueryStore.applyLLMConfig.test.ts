/**
 * Les réglages de l'application et le panneau du chat éditent le même
 * modèle et la même fenêtre de contexte. Enregistrer les réglages doit se
 * voir dans le panneau sans redémarrage — et sans effacer la session.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useRAGQueryStore } from '../ragQueryStore';

describe('ragQueryStore.applyLLMConfig', () => {
  beforeEach(() => {
    useRAGQueryStore.getState().setParams({
      model: 'gemma2:2b',
      numCtx: 4096,
      topK: 17,
      includeBibliography: false,
      selectedCollectionKeys: ['ABC'],
      temperature: 0.7,
    });
  });

  it('reprend le modèle et la fenêtre enregistrés, sans toucher au reste', () => {
    useRAGQueryStore.getState().applyLLMConfig({
      ollamaChatModel: 'qwen3.5:35b',
      ollamaNumCtx: 262_144,
    });
    const p = useRAGQueryStore.getState().params;
    expect(p.model).toBe('qwen3.5:35b');
    expect(p.numCtx).toBe(262_144);
    // Session intacte.
    expect(p.topK).toBe(17);
    expect(p.includeBibliography).toBe(false);
    expect(p.selectedCollectionKeys).toEqual(['ABC']);
    expect(p.temperature).toBe(0.7);
  });

  it('une fenêtre vidée (0 / absente) revient au défaut du panneau', () => {
    useRAGQueryStore.getState().setParams({ numCtx: 1_000_000 });
    useRAGQueryStore.getState().applyLLMConfig({ ollamaChatModel: 'gemma2:2b', ollamaNumCtx: 0 });
    expect(useRAGQueryStore.getState().params.numCtx).toBe(4096);
    useRAGQueryStore.getState().setParams({ numCtx: 1_000_000 });
    useRAGQueryStore.getState().applyLLMConfig({});
    expect(useRAGQueryStore.getState().params.numCtx).toBe(4096);
  });

  it('ignore un modèle vide', () => {
    useRAGQueryStore.getState().applyLLMConfig({ ollamaChatModel: '   ' });
    expect(useRAGQueryStore.getState().params.model).toBe('gemma2:2b');
  });
});
