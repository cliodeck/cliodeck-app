/**
 * `/api/show` est la source de la longueur de contexte affichée à
 * l'utilisateur : ces tests fixent ce que l'on lit dans une réponse réelle
 * et ce que l'on tolère d'une réponse partielle.
 */
import { describe, expect, it } from 'vitest';
import {
  fetchOllamaModelInfo,
  parseOllamaShowResponse,
} from '../ollama-model-info.js';

// Extrait fidèle d'une réponse `/api/show` d'Ollama (champs non pertinents omis).
const QWEN_SHOW = {
  parameters: 'num_ctx                        40960\nstop                           "<|im_start|>"\nstop                           "<|im_end|>"',
  details: {
    family: 'qwen3',
    parameter_size: '35.0B',
    quantization_level: 'Q4_K_M',
  },
  model_info: {
    'general.architecture': 'qwen3',
    'general.parameter_count': 35_000_000_000,
    'qwen3.context_length': 1_010_000,
    'qwen3.embedding_length': 5120,
  },
  capabilities: ['completion', 'tools', 'thinking'],
};

describe('parseOllamaShowResponse', () => {
  it('lit la longueur de contexte sous la clé de l’architecture déclarée', () => {
    const info = parseOllamaShowResponse('qwen3.5:35b', QWEN_SHOW);
    expect(info.model).toBe('qwen3.5:35b');
    expect(info.contextLength).toBe(1_010_000);
    expect(info.architecture).toBe('qwen3');
    expect(info.family).toBe('qwen3');
    expect(info.parameterSize).toBe('35.0B');
    expect(info.quantizationLevel).toBe('Q4_K_M');
    expect(info.capabilities).toEqual(['completion', 'tools', 'thinking']);
  });

  it('extrait le num_ctx du Modelfile depuis le texte `parameters`', () => {
    const info = parseOllamaShowResponse('qwen3.5:35b', QWEN_SHOW);
    expect(info.modelfileNumCtx).toBe(40_960);
  });

  it('retombe sur n’importe quelle clé *.context_length si l’architecture manque', () => {
    const info = parseOllamaShowResponse('x', {
      model_info: { 'llama.context_length': 131_072 },
    });
    expect(info.contextLength).toBe(131_072);
    expect(info.architecture).toBeUndefined();
  });

  it('tolère une réponse vide, nulle ou mal formée', () => {
    expect(parseOllamaShowResponse('x', null)).toEqual({ model: 'x' });
    expect(parseOllamaShowResponse('x', 'garbage')).toEqual({ model: 'x' });
    expect(parseOllamaShowResponse('x', { model_info: [] })).toEqual({ model: 'x' });
    expect(
      parseOllamaShowResponse('x', {
        model_info: { 'qwen3.context_length': 'not a number' },
        parameters: 'stop "</s>"',
        details: { family: 42 },
        capabilities: 'tools',
      })
    ).toEqual({ model: 'x' });
  });

  it('ignore une longueur de contexte nulle ou négative', () => {
    expect(
      parseOllamaShowResponse('x', { model_info: { 'llama.context_length': 0 } })
        .contextLength
    ).toBeUndefined();
  });
});

describe('fetchOllamaModelInfo', () => {
  it('POSTe le nom du modèle sur /api/show et parse la réponse', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), init };
      return new Response(JSON.stringify(QWEN_SHOW), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const info = await fetchOllamaModelInfo('http://127.0.0.1:11434/', 'qwen3.5:35b', fakeFetch);
    expect(info.contextLength).toBe(1_010_000);
    expect(seen).not.toBeNull();
    const req = seen as unknown as { url: string; init?: RequestInit };
    expect(req.url).toBe('http://127.0.0.1:11434/api/show');
    expect(req.init?.method).toBe('POST');
    expect(JSON.parse(String(req.init?.body))).toMatchObject({ model: 'qwen3.5:35b' });
  });

  it('lève sur une réponse HTTP en erreur (modèle inconnu)', async () => {
    const fakeFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await expect(
      fetchOllamaModelInfo('http://127.0.0.1:11434', 'nope:latest', fakeFetch)
    ).rejects.toThrow(/404/);
  });
});
