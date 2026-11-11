/**
 * L'Ollama de l'auteur hors d'atteinte de l'app sous test, quels que soient ses réglages.
 *
 * Chargé par `-r` avant le main, à chaque lancement (`startElectron`). `launchApp` vise déjà un port
 * fermé (`NO_OLLAMA`) dans le userData qu'il crée ; restent les lancements qui repartent du défaut,
 * `127.0.0.1:11434` : réglages illisibles mis de côté, userData préparé par le test sans `llm`. Ici,
 * une connexion du main vers ce port, sur cette machine, part vers un port fermé : elle échoue comme
 * quand Ollama ne tourne pas. Un faux Ollama (`fake-ollama.ts`) écoute ailleurs et n'est pas touché ;
 * le code de l'app n'a aucune branche réservée aux tests.
 *
 * Toute connexion TCP de Node passe par `Socket.prototype.connect` : `fetch` (undici, celui de Node
 * comme celui du paquet), `http.request`, `net.connect`.
 */
const net = require('node:net');

const OLLAMA_PORT = 11434;
const CLOSED_PORT = 9;
const LOOPBACK = new Set([undefined, '', 'localhost', '127.0.0.1', '::1']);

const aimsAtOllama = (port, host) => Number(port) === OLLAMA_PORT && LOOPBACK.has(host);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // `net.connect` passe ses arguments déjà normalisés, en tableau ; sinon un objet, ou (port, hôte).
  const list = Array.isArray(args[0]) ? args[0] : args;
  const [first, second] = list;
  if (first !== null && typeof first === 'object') {
    if (aimsAtOllama(first.port, first.host)) list[0] = { ...first, port: CLOSED_PORT };
  } else if (aimsAtOllama(first, typeof second === 'string' ? second : undefined)) {
    list[0] = CLOSED_PORT;
  }
  return connect.apply(this, args);
};
