/**
 * `complete()` rejette désormais quand le fournisseur tombe, au lieu de rendre une chaîne vide ou
 * un début de réponse (L09-7). Les appelants qui ont un repli doivent le prendre ; ceux qui n'en
 * ont pas doivent échouer en le disant. Fournisseur réel, `fetch` simulé : rien ne part en ligne.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { OllamaProvider } from '../ollama.js';
import { DocumentSummarizer } from '../../../analysis/DocumentSummarizer.js';
import { ContextCompactor } from '../../../context-mgmt/compactor.js';
import { RecipeRunner } from '../../../../recipes/runner.js';
import { parseRecipe } from '../../../../recipes/schema.js';
import type { ProviderRegistry } from '../registry.js';
import type { ChatMessage } from '../base.js';

const CAUSE = 'model requires more system memory (22.1 GiB) than is available (18.4 GiB)';

/** Un Ollama qui refuse toute génération, comme quand le modèle ne tient pas en mémoire. */
function failingOllama(): OllamaProvider {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: CAUSE }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
  );
  return new OllamaProvider({ model: 'qwen3:32b', baseUrl: 'http://mock.ollama' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('appelants de complete() — fournisseur en panne', () => {
  it('DocumentSummarizer retombe sur le résumé extractif au lieu d’enregistrer un résumé vide', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const text = [
      'La préfecture de police de Paris connaît en 1934 une crise profonde.',
      'Le préfet Jean Chiappe est muté au Maroc par le gouvernement Daladier.',
      'Les ligues manifestent le 6 février devant la Chambre des députés.',
      'La fusillade de la place de la Concorde fait quinze morts.',
    ].join(' ');
    const s = new DocumentSummarizer(
      { enabled: true, method: 'abstractive', maxLength: 60 },
      undefined,
      { llm: failingOllama() }
    );

    const summary = await s.generateSummary(text);

    expect(summary.trim()).not.toBe('');
    expect(summary).toContain('Chiappe');
  });

  it('le compacteur échoue au lieu de remplacer l’historique par un résumé vide', async () => {
    const compactor = new ContextCompactor({
      llm: failingOllama(),
      contextWindow: 1000,
      threshold: 0.7,
      keepRecentTurns: 2,
    });
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 1; i <= 8; i++) {
      messages.push({ role: 'user', content: `U${i}:${'x'.repeat(400)}` });
      messages.push({ role: 'assistant', content: `A${i}:${'y'.repeat(400)}` });
    }

    // `chat-engine` attrape l'erreur et garde la conversation entière (« compaction skipped »).
    await expect(compactor.compact(messages)).rejects.toMatchObject({
      name: 'ProviderCallError',
      code: 'ollama_http_500',
      message: CAUSE,
    });
  });

  it('une recette dont l’étape LLM tombe s’arrête en step_failed, avec la cause', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-recette-panne-'));
    try {
      const llm = failingOllama();
      const runner = new RecipeRunner({
        registry: { getLLM: () => llm } as unknown as ProviderRegistry,
        workspaceRoot: root,
      });
      const recipe = parseRecipe(`
name: panne
version: 0.1.0
steps:
  - id: think
    kind: brainstorm
    with:
      prompt: "pistes sur la crise de 1934"
`);

      const res = await runner.run(recipe, {});

      expect(res.ok).toBe(false);
      expect(res.outputs.think).toBeUndefined();
      const log = (await fs.readFile(res.logPath, 'utf8'))
        .split('\n')
        .filter((l) => l)
        .map((l) => JSON.parse(l) as { kind: string; error?: { message: string } });
      const failed = log.find((e) => e.kind === 'step_failed');
      expect(failed?.error?.message).toContain(CAUSE);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
