import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runLLMProviderContract,
  runEmbeddingProviderContract,
} from './contract.js';
import type { ChatOptions, LLMProvider } from '../base.js';
import { MistralProvider } from '../mistral.js';
import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
} from '../openai-compatible.js';

// Points at localhost:1 so healthCheck fails fast and live tests self-skip.
runLLMProviderContract(
  'openai-compatible',
  () =>
    new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-4o-mini',
    })
);

runEmbeddingProviderContract(
  'openai-compatible-embedding',
  () =>
    new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'text-embedding-3-small',
      dimension: 1536,
    })
);

/**
 * Les modèles de raisonnement d'OpenAI (série o, gpt-5 et suivants) refusent `temperature` et
 * `top_p`, que le chat envoie à chaque tour (0,1 par défaut, 0 pour le résumé du compacteur), et
 * `max_tokens`, remplacé par `max_completion_tokens` : chaque tour finissait en HTTP 400 (S05-2-2).
 * Le rôle `developer` y remplace `system` (« With o1 models and newer »).
 *
 * Le corps est lu sur un `fetch` simulé : rien ne part vers OpenAI ni vers Mistral.
 */
describe('OpenAICompatibleProvider — paramètres des modèles de raisonnement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type SentBody = {
    model: string;
    messages: Array<{ role: string; content: string | null }>;
  } & Record<string, unknown>;

  /** Le corps envoyé pour un tour avec consignes, température, top-p et longueur de réponse. */
  async function sentBody(provider: LLMProvider, opts: ChatOptions = {}): Promise<SentBody> {
    const bodies: SentBody[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    for await (const _ of provider.chat(
      [
        { role: 'system', content: 'Tu es un assistant de recherche en histoire.' },
        { role: 'user', content: 'Qui était le préfet de police en 1934 ?' },
      ],
      { temperature: 0.1, topP: 0.9, maxTokens: 800, ...opts }
    )) {
      // le flux est consommé jusqu'au bout
    }
    expect(bodies).toHaveLength(1);
    return bodies[0];
  }

  const openai = (model: string): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({ baseUrl: 'http://mock.openai/v1', model });

  // gpt-5-mini ferme le 11 décembre 2026, o3 aussi ; gpt-6-luna est le remplaçant que la page des
  // dépréciations d'OpenAI donne à gpt-4o et gpt-4o-mini (lue le 2026-11-13).
  for (const model of ['gpt-5-mini', 'gpt-5.1', 'gpt-6-luna', 'gpt-6.1-terra', 'o3', 'o4-mini', 'GPT-5']) {
    it(`${model} : ni temperature ni top_p, max_completion_tokens, rôle developer`, async () => {
      const body = await sentBody(openai(model));
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('max_tokens');
      expect(body.max_completion_tokens).toBe(800 + 25_000);
      expect(body.messages.map((m) => m.role)).toEqual(['developer', 'user']);
      expect(body.messages[0].content).toBe('Tu es un assistant de recherche en histoire.');
    });
  }

  it('le résumé du compacteur (température 0) ne la porte pas non plus', async () => {
    const body = await sentBody(openai('gpt-6-luna'), { temperature: 0, topP: undefined, maxTokens: undefined });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  /**
   * `max_completion_tokens` compte aussi les jetons de raisonnement (« including visible output
   * tokens and reasoning tokens », référence de Chat Completions ; « This might occur before any
   * visible output tokens are produced », guide du raisonnement, lus le 2026-11-13). Une étape de
   * recette qui demande 800 jetons (`revue-zotero.yaml`) pouvait rendre un texte vide, sans erreur :
   * une fin par la limite n'est pas une panne. Le guide recommande « reserving at least 25,000
   * tokens for reasoning and outputs » : la réserve s'ajoute au budget du texte visible.
   */
  it('gpt-5-mini, étape de recette à 800 jetons : le budget visible plus la réserve de raisonnement', async () => {
    const body = await sentBody(openai('gpt-5-mini'), { maxTokens: 800 });
    expect(body.max_completion_tokens).toBe(25_800);
  });

  it('un modèle qui n’est pas de raisonnement garde le budget demandé, sans réserve', async () => {
    const body = await sentBody(openai('gpt-4o-mini'), { maxTokens: 800 });
    expect(body.max_tokens).toBe(800);
  });

  /**
   * Comportement retenu dans cette PR, faute de décision (suivi) : les outils partent tels quels,
   * sans `reasoning_effort`. OpenAI refuse ce tour (« GPT-6 Sol and GPT-6 Luna support function
   * calling in Chat Completions only with `reasoning_effort: "none"` », guide « latest-model », lu le
   * 2026-11-13 ; effort par défaut `medium`), et la cause s'affiche depuis L09-7. C'est pourquoi les
   * Réglages ne proposent aucun modèle GPT-6 en exemple. Le jour où le suivi est traité (effort
   * `none` quand des outils partent, ou outils selon le modèle comme pour Ollama), ce test change.
   */
  it('gpt-6-luna avec des outils MCP : outils joints, sans reasoning_effort ni température', async () => {
    const body = await sentBody(openai('gpt-6-luna'), {
      tools: [
        {
          name: 'zotero__search',
          description: '[zotero] Recherche dans la bibliothèque',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'zotero__search',
          description: '[zotero] Recherche dans la bibliothèque',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ]);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('temperature');
  });

  it('la règle suit le modèle du tour (`opts.model`), pas celui de la construction', async () => {
    const body = await sentBody(openai('gpt-4o'), { model: 'gpt-5-mini' });
    expect(body.model).toBe('gpt-5-mini');
    expect(body).not.toHaveProperty('temperature');
  });

  // Les modèles qui acceptent ces paramètres les reçoivent comme avant : gpt-4o, gpt-4.1, et un
  // modèle servi par un serveur local compatible (llama.cpp, LM Studio).
  for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'llama-3.3-70b']) {
    it(`${model} : corps inchangé (temperature, top_p, max_tokens, rôle system)`, async () => {
      const body = await sentBody(openai(model));
      expect(body.temperature).toBe(0.1);
      expect(body.top_p).toBe(0.9);
      expect(body.max_tokens).toBe(800);
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    });
  }

  // Mistral hérite de la classe : ses modèles ne sont pas des modèles d'OpenAI, la règle ne les
  // touche pas.
  for (const model of ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo']) {
    it(`MistralProvider (${model}) garde temperature, top_p, max_tokens et le rôle system`, async () => {
      const body = await sentBody(
        new MistralProvider({ apiKey: 'test', model, baseUrl: 'http://mock.mistral/v1' })
      );
      expect(body.temperature).toBe(0.1);
      expect(body.top_p).toBe(0.9);
      expect(body.max_tokens).toBe(800);
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    });
  }
});
