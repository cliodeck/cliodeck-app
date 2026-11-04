/**
 * Q7 : Réinitialiser laisse en place « le modèle et le fournisseur d'embeddings ». Ce test ne
 * s'en remet pas à une liste : il demande au vrai adaptateur quels champs font bouger les
 * embeddings, dans toutes les configurations possibles, et vérifie qu'ils restent.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type LLMConfig } from '@backend/types/config';
import { clioDeckConfigToRegistryConfig } from '@backend/core/llm/providers/cliodeck-config-adapter';
import { apiKeyFields, diffSection, FORM_DEFAULTS, resetValues, withFormDefaults } from '../settings-persist';

/** `Required` : ajouter un champ à `LLMConfig` sans le déclarer ici ne compile plus. */
const FULL: Required<LLMConfig> = {
  backend: 'ollama',
  ollamaURL: 'http://serveur-du-labo:11434',
  ollamaEmbeddingModel: 'bge-m3',
  ollamaChatModel: 'qwen3:14b',
  ollamaEmbeddingNumCtx: 8192,
  ollamaNumCtx: 16384,
  ollamaThink: false,
  claudeAPIKey: 'sk-a...wXyZ',
  claudeModel: 'claude-x',
  openaiAPIKey: 'sk-p...wXyZ',
  openaiModel: 'gpt-x',
  mistralAPIKey: 'mist...wXyZ',
  mistralModel: 'mistral-x',
  geminiAPIKey: 'AIza...wXyZ',
  geminiModel: 'gemini-x',
  useCloudEmbeddings: false,
  generationProvider: 'embedded',
  embeddedModelId: 'qwen-x',
  embeddedModelPath: '/modeles/qwen-x.gguf',
  embeddingProvider: 'auto',
  embeddedEmbeddingModelId: 'nomic-x',
  embeddedEmbeddingModelPath: '/modeles/nomic-x.gguf',
};
const FIELDS = Object.keys(FULL) as Array<keyof LLMConfig>;

/** Toutes les façons de calculer les embeddings. */
const BASES: LLMConfig[] = (['ollama', 'claude', 'openai', 'mistral', 'gemini'] as const).flatMap((backend) =>
  [false, true].flatMap((useCloudEmbeddings) =>
    (['auto', 'embedded', 'ollama'] as const).flatMap((embeddingProvider) =>
      [FULL.embeddedEmbeddingModelPath, undefined].map((embeddedEmbeddingModelPath) => ({
        ...FULL,
        backend,
        useCloudEmbeddings,
        embeddingProvider,
        embeddedEmbeddingModelPath,
      }))
    )
  )
);

/** Ce qui décide de l'index, selon le code qui construit le fournisseur. */
function embedding(cfg: LLMConfig): unknown {
  try {
    return clioDeckConfigToRegistryConfig(cfg).embedding;
  } catch (error) {
    return { refused: String(error) };
  }
}

function afterReset(base: LLMConfig): LLMConfig {
  return { ...base, ...resetValues({ rag: {}, llm: base }).llm } as LLMConfig;
}

/** Toutes les autres valeurs d'un champ, y compris « absent ». */
function otherValues(field: keyof LLMConfig): unknown[] {
  const value = FULL[field];
  if (field === 'backend') return ['ollama', 'claude', 'openai', 'mistral', 'gemini'];
  if (field === 'embeddingProvider' || field === 'generationProvider') return ['auto', 'embedded', 'ollama', undefined];
  if (typeof value === 'boolean') return [true, false, undefined];
  if (typeof value === 'number') return [value * 2, undefined];
  return [`${value}-autre`, undefined];
}

describe('Réinitialiser et l’index', () => {
  it.each(BASES.map((base, i) => [i, base.backend, base.useCloudEmbeddings, base.embeddingProvider, base] as const))(
    'configuration %i (%s, cloud %s, %s) : le fournisseur d’embeddings est le même avant et après',
    (_i, _backend, _cloud, _provider, base) => {
      expect(embedding(afterReset(base))).toEqual(embedding(base));
    }
  );

  it('tout champ qui, changé, fait bouger les embeddings reste en place', () => {
    const decisive = new Set<string>();
    for (const base of BASES) {
      const after = afterReset(base);
      for (const field of FIELDS) {
        // Un champ qui revient à son défaut ne déplace pas, à lui seul, les embeddings.
        if (after[field] !== base[field]) {
          expect(embedding({ ...base, [field]: after[field] }), `${field} sur ${base.backend}`).toEqual(embedding(base));
        }
        // Le parcours n'est pas aveugle : il sait quels champs décident, et les retrouve inchangés.
        for (const other of otherValues(field)) {
          if (JSON.stringify(embedding({ ...base, [field]: other })) === JSON.stringify(embedding(base))) continue;
          decisive.add(field);
          // `backend` : conditionnel, voir le test suivant. Le reste : toujours.
          if (field !== 'backend') expect(after[field], `${field} sur ${base.backend}`).toEqual(base[field]);
        }
      }
    }
    expect([...decisive].sort()).toEqual(
      [
        'backend',
        'claudeAPIKey',
        'embeddedEmbeddingModelId',
        'embeddedEmbeddingModelPath',
        'embeddingProvider',
        'geminiAPIKey',
        'mistralAPIKey',
        'ollamaEmbeddingModel',
        'ollamaEmbeddingNumCtx',
        'ollamaURL',
        'openaiAPIKey',
        'useCloudEmbeddings',
      ].sort()
    );
  });

  it('le fournisseur de génération n’est gardé que s’il calcule aussi les embeddings', () => {
    const cloud = (backend: LLMConfig['backend'], useCloudEmbeddings: boolean) =>
      afterReset({ ...FULL, backend, useCloudEmbeddings }).backend;
    expect(cloud('gemini', true)).toBe('gemini');
    expect(cloud('openai', true)).toBe('openai');
    expect(cloud('mistral', true)).toBe('mistral');
    // Anthropic n'a pas d'embeddings : ils restent sur Ollama, le backend peut revenir au défaut.
    expect(cloud('claude', true)).toBe('ollama');
    expect(cloud('gemini', false)).toBe('ollama');
  });
});

describe('Réinitialiser et le reste', () => {
  it('la génération revient au défaut, un champ sans défaut disparaît', () => {
    const after = afterReset({ ...FULL, backend: 'claude' });
    expect(after.backend).toBe(DEFAULT_CONFIG.llm.backend);
    expect(after.ollamaChatModel).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);
    expect(after.generationProvider).toBe(DEFAULT_CONFIG.llm.generationProvider);
    for (const field of ['ollamaNumCtx', 'ollamaThink', 'claudeModel', 'openaiModel', 'mistralModel', 'geminiModel'] as const) {
      expect(after[field], field).toBeUndefined();
    }
  });

  it('les clés d’API ne figurent pas dans ce qui s’écrit', () => {
    const { llm } = resetValues({ rag: {}, llm: FULL });
    for (const field of ['claudeAPIKey', 'openaiAPIKey', 'mistralAPIKey', 'geminiAPIKey']) {
      expect(llm, field).not.toHaveProperty(field);
    }
  });

  it('un modèle embarqué téléchargé reste connu : sans Ollama, le chat a son repli', () => {
    const after = afterReset(FULL);
    expect(after.generationProvider).toBe('auto');
    expect(clioDeckConfigToRegistryConfig(after).llm).toMatchObject({
      provider: 'ollama',
      model: DEFAULT_CONFIG.llm.ollamaChatModel,
      fallback: { provider: 'embedded', modelPath: FULL.embeddedModelPath },
    });
  });

  it('rag : tout revient, découpage compris, sauf la langue du prompt', () => {
    const { rag } = resetValues({
      rag: {
        ...DEFAULT_CONFIG.rag,
        topK: 7,
        chunkingConfig: 'large',
        useSemanticChunking: true,
        customChunkingEnabled: true,
        customMaxChunkSize: 900,
        systemPromptLanguage: 'en',
        customSystemPrompt: 'Réponds en vers.',
        useCustomSystemPrompt: true,
        readingNotesCloudConsent: true,
        indexManuscript: false,
        numCtx: 8192,
        champInconnu: 1,
      },
      llm: {},
    });
    const after = { ...rag };
    expect(after).not.toHaveProperty('systemPromptLanguage');
    expect(after.topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(after.chunkingConfig).toBe(DEFAULT_CONFIG.rag.chunkingConfig);
    expect(after.useSemanticChunking).toBe(false);
    expect(after.customChunkingEnabled).toBe(false);
    expect(after.customMaxChunkSize).toBe(DEFAULT_CONFIG.rag.customMaxChunkSize);
    expect(after.useCustomSystemPrompt).toBe(false);
    for (const field of ['customSystemPrompt', 'readingNotesCloudConsent', 'indexManuscript', 'numCtx', 'champInconnu']) {
      expect(after, field).toHaveProperty(field, undefined);
    }
  });
});

describe('diffSection', () => {
  it('deux objets égaux ne sont pas un changement, quel que soit l’ordre de leurs clés', () => {
    expect(diffSection({ a: { x: 1, y: [1, 2] } }, { a: { y: [1, 2], x: 1 } })).toEqual({});
    expect(diffSection({ a: { x: 1 } }, { a: { x: 2 } })).toEqual({ a: { x: 2 } });
    expect(diffSection({ a: [1, 2] }, { a: [2, 1] })).toEqual({ a: [2, 1] });
    expect(diffSection({ a: [] }, { a: {} })).toEqual({ a: {} });
  });

  it('un NaN n’est pas un changement par rapport à lui-même', () => {
    expect(diffSection({ a: NaN }, { a: NaN })).toEqual({});
    expect(diffSection({ a: { b: NaN } }, { a: { b: NaN } })).toEqual({});
  });

  it('une clé absente du formulaire n’est pas touchée ; une clé à undefined s’efface', () => {
    expect(diffSection({ engine: 'cm6', a: 1 }, { a: 1 })).toEqual({});
    const diff = diffSection({ a: 1 }, { a: undefined });
    expect(diff).toHaveProperty('a', undefined);
  });

  it('un champ de clé vide des deux côtés n’est pas un effacement ; vider une clé présente, si', () => {
    expect(diffSection({}, { claudeAPIKey: '' })).toEqual({});
    expect(diffSection({ apiKey: '' }, { apiKey: undefined })).toEqual({});
    expect(diffSection({ claudeAPIKey: 'sk-a...wXyZ' }, { claudeAPIKey: '' })).toEqual({ claudeAPIKey: '' });
    // Ailleurs, `''` et absent restent deux valeurs.
    expect(diffSection({}, { claudeModel: '' })).toEqual({ claudeModel: '' });
  });
});

describe('withFormDefaults et apiKeyFields', () => {
  it('complète ce qui manque, garde ce que le formulaire ne connaît pas, ignore undefined', () => {
    const editor = withFormDefaults('editor', { fontSize: 18, engine: 'cm6', wordWrap: undefined });
    expect(editor).toMatchObject({ fontSize: 18, engine: 'cm6', wordWrap: true, fontFamily: 'system' });
    expect(withFormDefaults('zotero', undefined)).toEqual(FORM_DEFAULTS.zotero);
  });

  it('une section absente ne laisse aucune clé en place', () => {
    expect(apiKeyFields({ llm: undefined, zotero: undefined })).toEqual({
      llm: { claudeAPIKey: undefined, openaiAPIKey: undefined, mistralAPIKey: undefined, geminiAPIKey: undefined },
      zotero: { apiKey: '' },
    });
  });
});

describe('les valeurs par défaut du formulaire', () => {
  it('sont celles de DEFAULT_CONFIG : plus de 0,2 ni de modèle en dur', () => {
    expect(FORM_DEFAULTS.rag.similarityThreshold).toBe(DEFAULT_CONFIG.rag.similarityThreshold);
    expect(FORM_DEFAULTS.rag.topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(FORM_DEFAULTS.llm.ollamaChatModel).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);
    expect(FORM_DEFAULTS.editor.fontSize).toBe(DEFAULT_CONFIG.editor.fontSize);
  });
});
