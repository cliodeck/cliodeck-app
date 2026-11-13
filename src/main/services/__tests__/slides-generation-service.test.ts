/**
 * Génération de diapositives par le modèle embarqué (revue de L08-4).
 *
 * Le prompt des diapositives met tout le document dans le message de l'utilisateur, que le moteur
 * embarqué traite comme « la question » et ne coupe jamais (S05-1-25). Un document plus long que
 * le budget d'entrée (environ 9 000 caractères en français) était refusé (`embedded_prompt_too_long`),
 * et le service, qui ne lisait pas le terminal, envoyait un résultat vide : le panneau s'arrêtait sur
 * « terminé », sans rien ni aucun message. Près du budget, c'étaient les consignes des diapositives,
 * en rôle système, qui étaient coupées.
 *
 * Vrai fournisseur et vrai client embarqués, derrière le décorateur du journal d'usage comme dans
 * l'app ; seul `node-llama-cpp` est simulé (un jeton par mot).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('node-llama-cpp', async () => (await import('../../../../backend/core/llm/__tests__/helpers/fake-node-llama-cpp.js')).fakeNodeLlamaCpp);

import { fakeLlama, fakeTokenize } from '../../../../backend/core/llm/__tests__/helpers/fake-node-llama-cpp.js';
import { EmbeddedProvider } from '../../../../backend/core/llm/providers/embedded.js';
import { FallbackLLMProvider } from '../../../../backend/core/llm/providers/fallback.js';
import { instrumentLLM } from '../../../../backend/core/llm/providers/instrument.js';
import { getSlideGenerationPrompt } from '../../../../backend/core/llm/SystemPrompts.js';
import { EMBEDDED_CONTEXT_SIZE, embeddedInputBudget } from '../../../../backend/core/llm/context-windows.js';
import type { ChatMessage, LLMProvider, ProviderStatus } from '../../../../backend/core/llm/providers/base.js';
import { SlidesGenerationService } from '../slides-generation-service.js';

const MODEL_PATH = '/modeles/qwen2.5-0.5b-instruct-q4_k_m.gguf';

interface Sent {
  channel: string;
  payload: unknown;
}

function captureWindow(): { window: BrowserWindow; sent: Sent[] } {
  const sent: Sent[] = [];
  const window = {
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
  } as unknown as BrowserWindow;
  return { window, sent };
}

/** Le registre du réglage « embarqué » : le fournisseur enveloppé par le journal d'usage. */
const embedded = (): LLMProvider =>
  instrumentLLM(new EmbeddedProvider({ modelPath: MODEL_PATH, modelId: 'qwen2.5-0.5b' }), 'embedded');

/** Un Ollama du banc : son sondage est `health`, ses réponses une phrase ; il note ce qu'il reçoit. */
function ollama(health: ProviderStatus, seen: ChatMessage[][]): LLMProvider {
  return {
    id: 'ollama', name: 'Ollama', model: 'llama3.2',
    capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
    getStatus: () => health,
    healthCheck: async () => health,
    async *chat(messages: ChatMessage[]) {
      seen.push(messages);
      yield { delta: '# Une grève\n\n## Le Havre, 1910', done: false };
      yield { delta: '', done: true, finishReason: 'stop' };
    },
    complete: async () => '',
    dispose: async () => undefined,
  };
}

/** Un document de `n` mots (`n` jetons pour le double), avec une marque au début et à la fin. */
const documentOf = (n: number): string =>
  ['DEBUT-DU-DOCUMENT', ...Array.from({ length: n }, (_, i) => `mot${i}`), 'FIN-DU-DOCUMENT'].join(' ');

/**
 * `n` références de 44 jetons chacune pour le double (un jeton par mot) : ce que coûte au tokeniseur
 * du vrai modèle une entrée de 109 caractères, avec sa clé `[@id]` et ses noms (mesuré).
 */
const realisticCitations = (n: number): Array<{ id: string; author: string; title: string; year: string }> =>
  Array.from({ length: n }, (_, i) => ({
    id: `ref${i}`,
    author: 'Pigenet',
    title: Array.from({ length: 40 }, (_, j) => `t${i}-${j}`).join(' '),
    year: '1990',
  }));

const doneOf = (sent: Sent[]) =>
  sent.find((s) => s.channel === 'slides:stream-done')?.payload as
    | {
        content: string;
        cancelled?: boolean;
        sourceCut?: { readChars: number; totalChars: number };
        bibliographyCut?: { kept: number; total: number };
      }
    | undefined;
const errorOf = (sent: Sent[]) =>
  sent.find((s) => s.channel === 'slides:stream-error')?.payload as { error: string; code?: string } | undefined;

beforeEach(() => {
  fakeLlama.reset();
  fakeLlama.reply = ['# La grève des dockers\n\n', '## Le Havre, 1910\n\n- Le travail de nuit'];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('diapositives par le modèle embarqué (L08-4)', () => {
  it('document plus long que la fenêtre : des diapositives tirées de son début, consignes intactes, et la coupe dite', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();
    const source = documentOf(5000);

    const content = await service.generateSlides(source, 'fr', window);
    await llm.dispose();

    expect(content).toContain('La grève des dockers');
    expect(errorOf(sent)).toBeUndefined();
    expect(doneOf(sent)?.content).toBe(content);
    // La coupe se dit : le panneau précise que seul le début du document a servi.
    const cut = doneOf(sent)?.sourceCut;
    expect(cut?.totalChars).toBe(source.length);
    expect(cut?.readChars).toBeGreaterThan(0);
    expect(cut?.readChars).toBeLessThan(source.length);

    const [session] = fakeLlama.sessions;
    // Les consignes des diapositives partent entières, en rôle système.
    expect(session.systemPrompt).toBe(getSlideGenerationPrompt('fr'));
    // Le document est coupé, pas la demande ; et la question entière atteint le moteur.
    const prompt = session.prompts[0].text;
    expect(session.prompts[0].kept).toBe(prompt);
    expect(prompt).toContain('DEBUT-DU-DOCUMENT');
    expect(prompt).not.toContain('FIN-DU-DOCUMENT');
    expect(prompt).toContain('[…]');
    expect(prompt.trimEnd().endsWith('Génère les slides maintenant, en FRANÇAIS :')).toBe(true);
    expect(fakeTokenize(session.systemPrompt ?? '').length + fakeTokenize(prompt).length).toBeLessThanOrEqual(
      embeddedInputBudget(EMBEDDED_CONTEXT_SIZE)
    );
  });

  it('« auto », Ollama arrêté : le modèle embarqué répond, et le document est coupé de même', async () => {
    const llm = instrumentLLM(
      new FallbackLLMProvider(
        ollama({ state: 'failed' }, []),
        new EmbeddedProvider({ modelPath: MODEL_PATH, modelId: 'qwen2.5-0.5b' })
      ),
      'ollama',
      'http://127.0.0.1:9'
    );
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();

    const content = await service.generateSlides(documentOf(5000), 'fr', window);
    await llm.dispose();

    expect(content).toContain('La grève des dockers');
    expect(doneOf(sent)?.sourceCut).toBeDefined();
    expect(fakeLlama.sessions[0].prompts[0].text).not.toContain('FIN-DU-DOCUMENT');
  });

  it('un document court part entier, sans mention de coupe', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();

    await service.generateSlides(documentOf(300), 'fr', window);
    await llm.dispose();

    expect(fakeLlama.sessions[0].prompts[0].text).toContain('FIN-DU-DOCUMENT');
    expect(doneOf(sent)?.sourceCut).toBeUndefined();
  });

  /**
   * Une bibliographie de taille courante prenait toute la place (revue de L08-4) : elle passait
   * entière avant le document, 50 entrées de 109 caractères coûtent 2 214 jetons au tokeniseur du
   * vrai modèle (mesuré), et il ne restait rien au document. Le moteur recevait les consignes et la
   * bibliographie seules, et rendait un gabarit générique, donné pour réussi. Le document passe
   * désormais d'abord : la bibliographie n'a que la place qu'il laisse, au moins un tiers, et
   * perd ses dernières entrées ; le panneau dit combien le modèle en a reçu.
   */
  it('50 références de taille réelle et un document de 5 000 caractères : le document est lu, la bibliographie bornée, et la coupe dite', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();
    // 44 jetons par entrée, ce que coûte au vrai tokeniseur une entrée de 109 caractères ; un document
    // de 1 450 jetons, ce que coûtent 5 000 caractères en français (3,43 caractères par jeton, mesuré).
    const citations = realisticCitations(50);
    const source = documentOf(1450);

    const content = await service.generateSlides(source, 'fr', window, citations);
    await llm.dispose();

    expect(errorOf(sent)).toBeUndefined();
    expect(content).toContain('La grève des dockers');
    const prompt = fakeLlama.sessions[0].prompts[0].text;
    // Le document entier est lu : il tient dans les deux tiers de la place.
    expect(prompt).toContain('DEBUT-DU-DOCUMENT');
    expect(prompt).toContain('FIN-DU-DOCUMENT');
    expect(doneOf(sent)?.sourceCut).toBeUndefined();
    // La bibliographie garde ses premières entrées, et la coupe se dit.
    const bib = doneOf(sent)?.bibliographyCut;
    expect(bib?.total).toBe(50);
    expect(bib?.kept).toBeGreaterThan(0);
    expect(bib?.kept).toBeLessThan(50);
    expect(prompt).toContain('[@ref0]');
    expect(prompt).toContain(`[@ref${(bib?.kept ?? 0) - 1}]`);
    expect(prompt).not.toContain(`[@ref${bib?.kept ?? 0}]`);
    expect(fakeLlama.sessions[0].systemPrompt).toBe(getSlideGenerationPrompt('fr'));
    expect(fakeTokenize(fakeLlama.sessions[0].systemPrompt ?? '').length + fakeTokenize(prompt).length).toBeLessThanOrEqual(
      embeddedInputBudget(EMBEDDED_CONTEXT_SIZE)
    );
  });

  it('long document et 50 références : le document garde au moins les deux tiers de la place', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();
    const source = documentOf(5000);

    await service.generateSlides(source, 'fr', window, realisticCitations(50));
    await llm.dispose();

    expect(errorOf(sent)).toBeUndefined();
    const cut = doneOf(sent)?.sourceCut;
    expect(cut?.readChars).toBeGreaterThan(0);
    const prompt = fakeLlama.sessions[0].prompts[0].text;
    const read = fakeTokenize(prompt.slice(prompt.indexOf('DEBUT-DU-DOCUMENT'), prompt.indexOf('[…]'))).length;
    const bibliography = prompt.split('\n').filter((line) => line.startsWith('- [@'));
    const bibTokens = fakeTokenize(bibliography.join('\n')).length;
    expect(read).toBeGreaterThanOrEqual(2 * bibTokens - 50);
    expect(doneOf(sent)?.bibliographyCut?.kept).toBe(bibliography.length);
  });

  // Des titres de 80 mots : refusés avant le correctif, faute de place pour la seule bibliographie.
  it('bibliographie démesurée : le document est lu quand même, et la bibliographie coupée', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();
    const citations = Array.from({ length: 50 }, (_, i) => ({
      id: `ref${i}`,
      author: 'Pigenet',
      title: Array.from({ length: 80 }, (_, j) => `titre${i}-${j}`).join(' '),
      year: '1990',
    }));

    await service.generateSlides(documentOf(300), 'fr', window, citations);
    await llm.dispose();

    expect(errorOf(sent)).toBeUndefined();
    expect(fakeLlama.sessions[0].prompts[0].text).toContain('FIN-DU-DOCUMENT');
    expect(doneOf(sent)?.bibliographyCut?.kept).toBeLessThan(50);
  });

  it('témoin : une bibliographie qui tient part entière, sans mention', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();

    await service.generateSlides(documentOf(300), 'fr', window, realisticCitations(5));
    await llm.dispose();

    expect(fakeLlama.sessions[0].prompts[0].text).toContain('[@ref4]');
    expect(doneOf(sent)?.bibliographyCut).toBeUndefined();
  });

  // Le contrat des fournisseurs : une panne finit le flux par un terminal `error`, sans lever. Le
  // service le lit : l'erreur et son code atteignent le panneau, pas un résultat vide.
  it('panne du moteur : l’erreur et son code atteignent le panneau, pas un résultat vide', async () => {
    const llm = embedded();
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();
    fakeLlama.failWith = 'llama_decode failed';

    await expect(service.generateSlides(documentOf(300), 'fr', window)).rejects.toThrow(/llama_decode failed/);
    await llm.dispose();

    expect(doneOf(sent)).toBeUndefined();
    expect(errorOf(sent)?.code).toBe('embedded_generation_failed');
    expect(errorOf(sent)?.error).toMatch(/llama_decode failed/);
  });

  it('témoin : Ollama reçoit le document entier, comme avant', async () => {
    const seen: ChatMessage[][] = [];
    const llm = instrumentLLM(ollama({ state: 'ready' }, seen), 'ollama', 'http://127.0.0.1:9');
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const { window, sent } = captureWindow();
    const source = documentOf(5000);

    await service.generateSlides(source, 'fr', window);

    expect(seen[0][1].content).toContain(source);
    expect(doneOf(sent)?.sourceCut).toBeUndefined();
    expect(fakeLlama.sessions).toHaveLength(0);
  });
});
