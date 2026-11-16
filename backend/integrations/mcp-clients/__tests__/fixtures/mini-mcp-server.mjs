// Mini-serveur MCP stdio pour les tests : répond à `initialize`, `tools/list` et `tools/call` (un seul
// outil appelable, `echo`, qui renvoie ses arguments en texte), rien d'autre.
// Ni dépendance, ni réseau. Usage :
//   node mini-mcp-server.mjs [<fichier-des-pid> [meurt-après-ms]] [options]
// Chaque lancement ajoute son PID au fichier : le test vérifie ainsi, PID par PID, qu'aucun
// processus ne survit. Avec un délai, il meurt (code 1) ce temps après avoir listé ses outils.
// Options, chacune un seul argument (le formulaire de l'app découpe les arguments aux espaces) :
//   --banniere[=texte]    écrit une ligne qui n'est pas du JSON-RPC au lancement (« Server starting... »
//                         par défaut) ; répétable, une ligne par occurrence ;
//   --bruit-avant-appel   avant chaque réponse à tools/call, une ligne de texte et une ligne JSON qui
//                         n'est pas du JSON-RPC, dans la même écriture que la réponse ;
//   --outils=N            N outils : `echo`, puis `outil-1` à `outil-<N-1>` ;
//   --page=P              tools/list par pages de P (curseur : le numéro de la page) ;
//   --curseur=boucle      la dernière page renvoie le curseur de la deuxième, déjà lu ;
//   --curseur=sans-fin    toujours une page de plus, qui reprend le catalogue au début une fois au bout ;
//   --lent=ms             chaque page de tools/list part ce temps après la demande ;
//   --schema-sortie[=P]   sur la page P seulement (0 par défaut), `echo` déclare un outputSchema ; il
//                         répond toujours sans structuredContent, ce que le SDK refuse pour un tel outil.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const [pidLog, dieAfterMs] = args.filter((a) => !a.startsWith('--'));
const options = args.filter((a) => a.startsWith('--')).map((a) => {
  const eq = a.indexOf('=');
  return eq === -1 ? [a.slice(2), undefined] : [a.slice(2, eq), a.slice(eq + 1)];
});
const option = (name) => options.find(([key]) => key === name)?.[1];
const has = (name) => options.some(([key]) => key === name);

if (pidLog) appendFileSync(pidLog, `${process.pid}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for (const [key, text] of options) {
  if (key === 'banniere') process.stdout.write(`${text ?? 'Server starting...'}\n`);
}

const toolCount = Number(option('outils') ?? 1);
const pageSize = Number(option('page') ?? toolCount);
const cursorMode = option('curseur');
const outputSchema = { type: 'object', properties: { texte: { type: 'string' } }, required: ['texte'] };
const schemaPage = has('schema-sortie') ? Number(option('schema-sortie') ?? 0) : -1;
const toolAt = (i, page) =>
  i === 0
    ? {
        name: 'echo',
        description: 'renvoie ce qu’on lui donne',
        inputSchema: { type: 'object' },
        ...(page === schemaPage ? { outputSchema } : {}),
      }
    : { name: `outil-${i}`, description: `outil ${i}, page ${page}`, inputSchema: { type: 'object' } };

function listPage(cursor) {
  const page = cursor === undefined ? 0 : Number(cursor);
  if (cursorMode === 'sans-fin') {
    const tools = Array.from({ length: pageSize }, (_, j) => toolAt((page * pageSize + j) % toolCount, page));
    return { tools, nextCursor: String(page + 1) };
  }
  const start = page * pageSize;
  const tools = Array.from({ length: Math.max(0, Math.min(pageSize, toolCount - start)) }, (_, j) =>
    toolAt(start + j, page)
  );
  if (start + pageSize < toolCount) return { tools, nextCursor: String(page + 1) };
  return cursorMode === 'boucle' ? { tools, nextCursor: '1' } : { tools };
}

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
    const answer = () => send({ jsonrpc: '2.0', id: message.id, result: listPage(message.params?.cursor) });
    if (option('lent')) setTimeout(answer, Number(option('lent')));
    else answer();
    if (dieAfterMs) setTimeout(() => process.exit(1), Number(dieAfterMs));
  } else if (message.method === 'tools/call' && message.params?.name === 'echo') {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: JSON.stringify(message.params.arguments ?? {}) }] },
    });
    // Une seule écriture : le bruit et la réponse arrivent dans le même paquet.
    const noise = has('bruit-avant-appel') ? 'searching archives...\n{"progress":0.5}\n' : '';
    process.stdout.write(`${noise}${response}\n`);
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
// stdin fermé (arrêt demandé, ou le processus parent est mort) : on s'en va.
lines.on('close', () => process.exit(0));
