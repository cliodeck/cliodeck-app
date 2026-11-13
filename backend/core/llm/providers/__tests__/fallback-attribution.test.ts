/**
 * Journal d'usage IA : derrière le repli « auto » (Ollama d'abord, modèle embarqué sinon), l'appel
 * est attribué au fournisseur qui a répondu (S05-1-17).
 *
 * Le décorateur du journal enveloppe le composite (`FallbackLLMProvider`) et inscrivait l'identifiant
 * de la configuration, `ollama`, quel que soit le moteur retenu : le modèle embarqué qui répondait,
 * Ollama arrêté, passait pour Ollama, et sa localité se lisait sur l'URL d'Ollama.
 *
 * Vrais `FallbackLLMProvider`, `instrumentLLM` et `context.ts` ; les deux moteurs sont simulés, l'un
 * qui répond au sondage, l'autre non.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChunk, LLMProvider, ProviderStatus } from '../base.js';
import { FallbackLLMProvider } from '../fallback.js';
import { instrumentLLM } from '../instrument.js';
import { setInferenceSink } from '../../../usage-journal/context.js';
import type { RecordInferenceInput } from '../../../usage-journal/types.js';

/** Un moteur nommé comme le vrai (`id`), qui répond ou non au sondage de santé. */
function engine(id: 'ollama' | 'embedded', model: string, up: boolean): LLMProvider {
  const status: ProviderStatus = up ? { state: 'ready' } : { state: 'failed' };
  return {
    id,
    name: id,
    model,
    capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
    getStatus: () => status,
    healthCheck: async () => status,
    dispose: async () => undefined,
    async *chat(): AsyncIterable<ChatChunk> {
      yield { delta: `Réponse de ${model}.` };
      yield { delta: '', done: true, finishReason: 'stop' };
    },
    complete: async () => `Réponse de ${model}.`,
  };
}

async function ask(llm: LLMProvider): Promise<void> {
  for await (const _ of llm.chat([{ role: 'user', content: 'Qui était le préfet Chiappe ?' }])) {
    // consommé jusqu'au bout
  }
}

let events: RecordInferenceInput[];

beforeEach(() => {
  events = [];
  setInferenceSink((e) => events.push(e));
});
afterEach(() => {
  setInferenceSink(undefined);
});

describe('repli Ollama → modèle embarqué, au journal d’usage', () => {
  it('Ollama indisponible : l’appel est au modèle embarqué, local même quand Ollama est sur un autre hôte', async () => {
    const llm = instrumentLLM(
      new FallbackLLMProvider(engine('ollama', 'llama3.2', false), engine('embedded', 'qwen3-4b', true)),
      'ollama',
      'http://gpu.labo.example:11434'
    );
    await ask(llm);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'embedded', model: 'qwen3-4b', isLocal: true });
  });

  it('Ollama disponible : l’appel est à Ollama, et sa localité suit son hôte', async () => {
    const llm = instrumentLLM(
      new FallbackLLMProvider(engine('ollama', 'llama3.2', true), engine('embedded', 'qwen3-4b', true)),
      'ollama',
      'http://gpu.labo.example:11434'
    );
    await ask(llm);
    expect(events[0]).toMatchObject({ provider: 'ollama', model: 'llama3.2', isLocal: false });
  });

  it('le choix change d’un appel à l’autre : chaque événement porte celui de son appel', async () => {
    let now = 0;
    let ollamaUp = true;
    const ollama = engine('ollama', 'llama3.2', true);
    const flaky: LLMProvider = {
      ...ollama,
      healthCheck: async () => (ollamaUp ? { state: 'ready' } : { state: 'failed' }),
      chat: (messages, opts) => ollama.chat(messages, opts),
    };
    const llm = instrumentLLM(
      new FallbackLLMProvider(flaky, engine('embedded', 'qwen3-4b', true), () => now),
      'ollama',
      'http://127.0.0.1:11434'
    );
    await ask(llm);
    // Ollama s'arrête ; le sondage suivant, une fois le précédent expiré, désigne le repli.
    ollamaUp = false;
    now += 60_000;
    await ask(llm);

    expect(events.map((e) => [e.provider, e.model, e.isLocal])).toEqual([
      ['ollama', 'llama3.2', true],
      ['embedded', 'qwen3-4b', true],
    ]);
  });
});
