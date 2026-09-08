import { describe, it, expect } from 'vitest';
import {
  applyChatModelOverride,
  clioDeckConfigToRegistryConfig,
  createRegistryFromClioDeckConfig,
  isLocalOllamaGeneration,
  resolveActiveChatModel,
} from '../cliodeck-config-adapter.js';
import type { LLMConfig } from '../../../../types/config.js';

const base: LLMConfig = {
  backend: 'ollama',
  ollamaURL: 'http://127.0.0.1:11434',
  ollamaChatModel: 'mistral:7b',
  ollamaEmbeddingModel: 'mxbai-embed-large',
};

describe('ClioDeck LLMConfig → Registry adapter (3.2)', () => {
  it('routes ollama backend to ollama provider', () => {
    const r = clioDeckConfigToRegistryConfig(base);
    expect(r.llm.provider).toBe('ollama');
    expect(r.llm.model).toBe('mistral:7b');
    expect(r.llm.baseUrl).toBe('http://127.0.0.1:11434');
    expect(r.embedding.dimension).toBe(1024);
  });

  it('routes claude backend to anthropic provider', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'claude',
      claudeAPIKey: 'sk-ant-test',
      claudeModel: 'claude-opus-4-6',
    });
    expect(r.llm.provider).toBe('anthropic');
    expect(r.llm.model).toBe('claude-opus-4-6');
    expect(r.llm.apiKey).toBe('sk-ant-test');
  });

  it('throws when claude backend selected without api key', () => {
    expect(() =>
      clioDeckConfigToRegistryConfig({ ...base, backend: 'claude' })
    ).toThrow(/claudeAPIKey/);
  });

  it('routes openai backend to openai-compatible provider', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'openai',
      openaiAPIKey: 'sk-test',
      openaiModel: 'gpt-4o',
    });
    expect(r.llm.provider).toBe('openai-compatible');
    expect(r.llm.model).toBe('gpt-4o');
    expect(r.llm.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('factory builds a usable registry', () => {
    const reg = createRegistryFromClioDeckConfig(base);
    expect(reg.getLLM().id).toBe('ollama');
  });

  it('routes mistral backend to mistral provider', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'mistral',
      mistralAPIKey: 'mst-test',
      mistralModel: 'mistral-large-latest',
    });
    expect(r.llm.provider).toBe('mistral');
    expect(r.llm.model).toBe('mistral-large-latest');
    expect(r.llm.apiKey).toBe('mst-test');
  });

  it('routes gemini backend to gemini provider', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'gemini',
      geminiAPIKey: 'AIza-test',
      geminiModel: 'gemini-2.0-flash',
    });
    expect(r.llm.provider).toBe('gemini');
    expect(r.llm.model).toBe('gemini-2.0-flash');
    expect(r.llm.apiKey).toBe('AIza-test');
  });

  it('keeps embeddings on ollama by default even when backend is cloud', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'gemini',
      geminiAPIKey: 'AIza-test',
    });
    expect(r.embedding.provider).toBe('ollama');
    expect(r.embedding.dimension).toBe(1024);
  });

  it('switches embeddings to gemini when useCloudEmbeddings is set', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'gemini',
      geminiAPIKey: 'AIza-test',
      useCloudEmbeddings: true,
    });
    expect(r.embedding.provider).toBe('gemini');
    expect(r.embedding.model).toBe('text-embedding-004');
    expect(r.embedding.dimension).toBe(768);
    expect(r.embedding.apiKey).toBe('AIza-test');
  });

  it('switches embeddings to openai-compatible with OpenAI baseUrl when useCloudEmbeddings is set', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'openai',
      openaiAPIKey: 'sk-test',
      useCloudEmbeddings: true,
    });
    expect(r.embedding.provider).toBe('openai-compatible');
    expect(r.embedding.model).toBe('text-embedding-3-small');
    expect(r.embedding.dimension).toBe(1536);
    expect(r.embedding.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('switches embeddings to mistral when useCloudEmbeddings is set', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'mistral',
      mistralAPIKey: 'mst-test',
      useCloudEmbeddings: true,
    });
    expect(r.embedding.provider).toBe('mistral');
    expect(r.embedding.model).toBe('mistral-embed');
    expect(r.embedding.dimension).toBe(1024);
  });

  it('keeps embeddings on ollama when useCloudEmbeddings is true but backend has no embedding API (claude)', () => {
    const r = clioDeckConfigToRegistryConfig({
      ...base,
      backend: 'claude',
      claudeAPIKey: 'sk-ant-test',
      useCloudEmbeddings: true,
    });
    expect(r.embedding.provider).toBe('ollama');
  });
});

describe('applyChatModelOverride — le modèle du panneau de chat', () => {
  it('remplace ollamaChatModel pour la génération Ollama locale', () => {
    const cfg = applyChatModelOverride(base, 'qwen3.5:35b');
    expect(cfg.ollamaChatModel).toBe('qwen3.5:35b');
    expect(clioDeckConfigToRegistryConfig(cfg).llm.model).toBe('qwen3.5:35b');
    expect(resolveActiveChatModel(cfg)).toBe('qwen3.5:35b');
  });

  it('ignore la demande pour un backend cloud : la liste du panneau vient d’Ollama', () => {
    const claude = {
      ...base,
      backend: 'claude' as const,
      claudeAPIKey: 'sk-ant-test',
      claudeModel: 'claude-opus-4-6',
    };
    const cfg = applyChatModelOverride(claude, 'qwen3.5:35b');
    expect(cfg).toBe(claude);
    expect(clioDeckConfigToRegistryConfig(cfg).llm.model).toBe('claude-opus-4-6');
  });

  it('ignore la demande quand la génération est confiée au modèle embarqué', () => {
    const embedded = {
      ...base,
      generationProvider: 'embedded' as const,
      embeddedModelPath: '/models/qwen2.5-0.5b.gguf',
      embeddedModelId: 'qwen2.5-0.5b',
    };
    expect(applyChatModelOverride(embedded, 'qwen3.5:35b')).toBe(embedded);
    expect(isLocalOllamaGeneration(embedded)).toBe(false);
  });

  it('« embarqué » sans modèle téléchargé reste de la génération Ollama', () => {
    const cfg = { ...base, generationProvider: 'embedded' as const };
    expect(isLocalOllamaGeneration(cfg)).toBe(true);
    expect(applyChatModelOverride(cfg, 'qwen3.5:35b').ollamaChatModel).toBe('qwen3.5:35b');
  });

  it('renvoie la configuration telle quelle sans demande, ou pour le même modèle', () => {
    expect(applyChatModelOverride(base, undefined)).toBe(base);
    expect(applyChatModelOverride(base, '   ')).toBe(base);
    expect(applyChatModelOverride(base, 'mistral:7b')).toBe(base);
  });

  it('ne mute jamais la configuration d’origine', () => {
    const before = { ...base };
    applyChatModelOverride(base, 'qwen3.5:35b');
    expect(base).toEqual(before);
  });
});
