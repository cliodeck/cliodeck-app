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
  port: number;
  /** Avec `hangChat` : les demandes de chat reçues, et celles que l'app a coupées sans attendre la réponse. */
  chatRequests(): number;
  /** Les textes que l'app a demandé d'embarquer avec ce modèle d'embeddings. */
  embeddedTexts(model: string): string[];
  chatAborted(): number;
  close(): Promise<void>;
}

/** Celle de nomic-embed-text : les index du projet refusent un vecteur d'une autre taille. */
const EMBEDDING_DIMENSION = 768;

/**
 * Un second modèle d'embeddings, d'une autre dimension, pour un changement de modèle (L06-9) :
 * l'app le connaît (`OLLAMA_EMBEDDING_DIMS`) et en attend 1024. Tout autre modèle répond en 768.
 */
export const OTHER_EMBEDDING_MODEL = 'mxbai-embed-large';
const OTHER_EMBEDDING_DIMENSION = 1024;

/**
 * `onlyItsModel` : le seul modèle « installé » répond ; les autres reçoivent la réponse d'Ollama à un
 * modèle absent. Le chat doit le dire, et non rester muet.
 *
 * `hangChat` : le chat ne répond jamais, comme un modèle bloqué ; seule l'app peut couper la demande.
 *
 * `port` : écouter sur ce port, celui d'un faux Ollama fermé plus tôt — un Ollama arrêté puis relancé.
 */
export async function startFakeOllama(
  answer: string,
  options: { onlyItsModel?: boolean; hangChat?: boolean; port?: number } = {},
): Promise<FakeOllama> {
  const MODEL = 'faux:latest';
  let chatRequests = 0;
  let chatAborted = 0;
  const embedded = new Map<string, string[]>();
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
          const { input, model } = JSON.parse(body) as { input: unknown; model?: string };
          const count = Array.isArray(input) ? input.length : 1;
          const texts = (Array.isArray(input) ? input : [input]).map(String);
          embedded.set(model ?? '', [...(embedded.get(model ?? '') ?? []), ...texts]);
          const dimension = model?.split(':')[0] === OTHER_EMBEDDING_MODEL ? OTHER_EMBEDDING_DIMENSION : EMBEDDING_DIMENSION;
          return json({ embeddings: Array.from({ length: count }, () => Array(dimension).fill(0.1)) });
        }
        case '/api/chat': {
          const { model } = JSON.parse(body) as { model: string };
          if (options.onlyItsModel && model !== MODEL) {
            res.statusCode = 404;
            return json({ error: `model '${model}' not found` });
          }
          if (options.hangChat) {
            chatRequests += 1;
            res.on('close', () => {
              if (!res.writableEnded) chatAborted += 1;
            });
            return undefined;
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
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
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
    port,
    chatRequests: () => chatRequests,
    embeddedTexts: (model: string) => embedded.get(model) ?? [],
    chatAborted: () => chatAborted,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Une demande laissée en suspens retiendrait la fermeture.
        server.closeAllConnections();
      }),
  };
}
