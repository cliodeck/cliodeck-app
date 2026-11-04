/**
 * Un faux Ollama local : le chat réel exige un modèle, et on veut ici le bouton réel, le vrai canal
 * `fusion:chat:*` et le vrai fournisseur, pas une réponse injectée dans un store. Il ne parle qu'à
 * 127.0.0.1 et répond toujours la même chose, tout de suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeOllama {
  /** `cliodeck-config.json` d'un userData temporaire réglé sur ce faux serveur, à donner à `launchApp`. */
  userDataDir: string;
  close(): Promise<void>;
}

/** Celle de nomic-embed-text : les index du projet refusent un vecteur d'une autre taille. */
const EMBEDDING_DIMENSION = 768;

/**
 * `onlyItsModel` : le seul modèle « installé » répond ; les autres reçoivent la réponse d'Ollama à un
 * modèle absent. Le chat doit le dire, et non rester muet.
 */
export async function startFakeOllama(answer: string, options: { onlyItsModel?: boolean } = {}): Promise<FakeOllama> {
  const MODEL = 'faux:latest';
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const json = (payload: unknown): void => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      switch (req.url) {
        case '/api/tags':
          return json({ models: [{ name: MODEL, model: MODEL, size: 1000, details: { family: 'faux' } }] });
        case '/api/version':
          return json({ version: '0.12.0' });
        case '/api/show':
          return json({ capabilities: ['completion'], model_info: { 'faux.context_length': 8192 } });
        case '/api/embed': {
          const { input } = JSON.parse(body) as { input: unknown };
          const count = Array.isArray(input) ? input.length : 1;
          return json({ embeddings: Array.from({ length: count }, () => Array(EMBEDDING_DIMENSION).fill(0.1)) });
        }
        case '/api/chat': {
          const { model } = JSON.parse(body) as { model: string };
          if (options.onlyItsModel && model !== MODEL) {
            res.statusCode = 404;
            return json({ error: `model '${model}' not found` });
          }
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: answer }, done: false })}\n`);
          res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`);
          return undefined;
        }
        default:
          res.statusCode = 404;
          res.end('{}');
          return undefined;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const userDataDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-ollama-'));
  writeFileSync(
    join(userDataDir, 'cliodeck-config.json'),
    JSON.stringify({
      language: 'fr',
      llm: {
        backend: 'ollama',
        ollamaURL: `http://127.0.0.1:${port}`,
        ollamaChatModel: MODEL,
        ollamaEmbeddingModel: 'faux-embed',
        generationProvider: 'ollama',
        embeddingProvider: 'ollama',
      },
    }),
  );

  return {
    userDataDir,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
