/**
 * Un champ dont le défaut est un nombre n'accepte qu'un nombre fini. Le reste du fichier n'est pas
 * son affaire : un `null` sur un chemin de modèle, un champ que personne ne connaît, ou un champ qui
 * manque ne sont pas des pannes.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../types/config';
import { numericDefaults, repairNumbers } from '../repair-numbers';

describe('repairNumbers', () => {
  it.each([[null], ['0.5'], ['abc'], [true], [[]], [[1]], [{}], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    '%j dans un champ dont le défaut est un nombre : le défaut',
    (bad) => {
      const repaired = repairNumbers('rag', { topK: bad, similarityThreshold: bad, chunkingConfig: 'large' });
      expect(repaired).toEqual({
        topK: DEFAULT_CONFIG.rag.topK,
        similarityThreshold: DEFAULT_CONFIG.rag.similarityThreshold,
        chunkingConfig: 'large',
      });
      expect(repairNumbers('editor', { fontSize: bad, wordWrap: false })).toEqual({
        fontSize: DEFAULT_CONFIG.editor.fontSize,
        wordWrap: false,
      });
    }
  );

  it('un nombre fini reste, zéro et négatifs compris', () => {
    const rag = { topK: 3, similarityThreshold: 0, customOverlapSize: -1 };
    expect(repairNumbers('rag', rag)).toEqual(rag);
  });

  it('rien d’abîmé : le même objet, c’est ce qui dit qu’il n’y a rien à réécrire', () => {
    const sections = {
      rag: { topK: 3 },
      llm: { backend: 'ollama', ollamaNumCtx: 0, ollamaEmbeddingNumCtx: 4096 },
      editor: { fontSize: 15 },
    };
    expect(repairNumbers('rag', sections.rag)).toBe(sections.rag);
    expect(repairNumbers('llm', sections.llm)).toBe(sections.llm);
    expect(repairNumbers('editor', sections.editor)).toBe(sections.editor);
  });

  it('un champ absent reste absent : un fichier ancien n’est pas abîmé', () => {
    expect(repairNumbers('rag', { topK: null })).toEqual({ topK: DEFAULT_CONFIG.rag.topK });
  });

  it('hors des champs numériques, rien ne bouge : null, chemins de modèle, champs inconnus', () => {
    const llm = {
      backend: 'ollama',
      embeddedModelPath: null,
      embeddedEmbeddingModelPath: null,
      champInconnu: null,
      autreInconnu: 'abc',
    };
    expect(repairNumbers('llm', llm)).toBe(llm);
    const rag = { summaryGeneration: null, useGraphContext: null, customSystemPrompt: null, inconnu: 'x' };
    expect(repairNumbers('rag', rag)).toBe(rag);
  });

  it('une fenêtre de contexte sans défaut : retirée, absent veut dire automatique', () => {
    const llm = repairNumbers('llm', { backend: 'ollama', ollamaNumCtx: 'abc', ollamaEmbeddingNumCtx: null });
    expect(llm).toEqual({ backend: 'ollama' });
    expect(llm).not.toHaveProperty('ollamaNumCtx');
    expect(repairNumbers('rag', { topK: 3, numCtx: true })).toEqual({ topK: 3 });
  });

  it('passe dans les objets imbriqués : le résumeur a aussi un nombre', () => {
    const summarizer = { ...DEFAULT_CONFIG.rag.summarizer, maxLength: null };
    expect(repairNumbers('rag', { summarizer })).toEqual({ summarizer: DEFAULT_CONFIG.rag.summarizer });
    const intact = { summarizer: { ...DEFAULT_CONFIG.rag.summarizer } };
    expect(repairNumbers('rag', intact)).toBe(intact);
  });

  it.each([[null], ['abc'], [[]], [7]])('une section qui n’est pas un objet (%j) : les valeurs par défaut', (section) => {
    expect(repairNumbers('rag', section)).toEqual(DEFAULT_CONFIG.rag);
    expect(repairNumbers('llm', section)).toEqual(DEFAULT_CONFIG.llm);
  });
});

describe('numericDefaults', () => {
  it('ne donne que les nombres de DEFAULT_CONFIG', () => {
    const defaults = numericDefaults('rag');
    expect(defaults.topK).toBe(10);
    expect(defaults.similarityThreshold).toBe(0.12);
    expect(defaults).not.toHaveProperty('chunkingConfig');
    expect(numericDefaults('editor')).toEqual({ fontSize: 14 });
    expect(numericDefaults('llm')).toEqual({});
  });
});

describe('DEFAULT_CONFIG', () => {
  it('ne contient aucun null : la règle n’y écarte aucun réglage légitime', () => {
    expect(JSON.stringify(DEFAULT_CONFIG)).not.toContain('null');
  });

  it('a un défaut pour chaque nombre que le formulaire affiche en toFixed', () => {
    expect(DEFAULT_CONFIG.rag).toMatchObject({
      similarityThreshold: 0.12,
      explorationSimilarityThreshold: 0.7,
      graphSimilarityThreshold: 0.7,
      additionalGraphDocs: 3,
      summaryMaxLength: 750,
    });
  });
});
