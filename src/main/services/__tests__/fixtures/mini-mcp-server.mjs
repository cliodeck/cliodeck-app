// Mini-serveur MCP stdio pour les tests : répond à `initialize` et `tools/list`, rien d'autre.
// Ni dépendance, ni réseau. Usage : node mini-mcp-server.mjs <fichier-des-pid> [meurt-après-ms]
// Chaque lancement ajoute son PID au fichier : le test vérifie ainsi, PID par PID, qu'aucun
// processus ne survit. Avec un délai, il meurt (code 1) ce temps après avoir listé ses outils.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const [pidLog, dieAfterMs] = process.argv.slice(2);
if (pidLog) appendFileSync(pidLog, `${process.pid}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mini', version: '0.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'echo', description: 'renvoie ce qu’on lui donne', inputSchema: { type: 'object' } }] },
    });
    if (dieAfterMs) setTimeout(() => process.exit(1), Number(dieAfterMs));
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
// stdin fermé (arrêt demandé, ou le processus parent est mort) : on s'en va.
lines.on('close', () => process.exit(0));
