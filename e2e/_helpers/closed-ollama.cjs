/**
 * Le port d'Ollama, 11434, fermé à l'app sous test, quel que soit l'hôte visé.
 *
 * Chargé par `-r` avant le main, à chaque lancement (`startElectron`). `launchApp` vise déjà un port
 * fermé (`NO_OLLAMA`) dans le userData qu'il crée ; restent les lancements qui repartent du défaut,
 * `127.0.0.1:11434` : réglages illisibles mis de côté, userData préparé par le test sans `llm`. Ici,
 * toute connexion TCP du main vers le port 11434, quel que soit l'hôte, part vers `127.0.0.1:9`, où
 * personne n'écoute : elle échoue comme quand Ollama ne tourne pas.
 *
 * Le port seul décide, parce que les hôtes qui mènent à un Ollama de la machine ne se dénombrent pas
 * sans résoudre les noms : `127.0.0.1` et `localhost`, mais aussi `localhost.`, `0.0.0.0`,
 * `::ffff:127.0.0.1`, un alias de `/etc/hosts`, le nom de la machine si Ollama écoute partout. Aucun
 * test n'a de raison de joindre ce port ailleurs. Un faux Ollama (`fake-ollama.ts`) écoute sur un
 * autre port et n'est pas touché ; le code de l'app n'a aucune branche réservée aux tests.
 *
 * Toute connexion TCP de Node passe par `Socket.prototype.connect` : `fetch` (undici, celui de Node
 * comme celui du paquet), `http.request`, `net.connect`, `tls.connect`. Pas le module `net`
 * d'Electron (pile réseau de Chromium), que le main n'emploie pas.
 */
const net = require('node:net');

const OLLAMA_PORT = 11434;
/** Où part une connexion au port fermé : le port de `NO_OLLAMA` (`launch.ts`), sur la machine. */
const CLOSED = { host: '127.0.0.1', port: 9 };

/** Ferme `port` à ce processus : `launch-harness.spec.ts` l'éprouve sur un port libre, sans viser 11434. */
function closePort(port) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // `net.connect` passe ses arguments déjà normalisés, en tableau ; sinon un objet, ou (port, hôte).
    const list = Array.isArray(args[0]) ? args[0] : args;
    const [first, second] = list;
    if (first !== null && typeof first === 'object') {
      if (Number(first.port) === port) list[0] = { ...first, ...CLOSED };
    } else if (Number(first) === port) {
      list.splice(0, typeof second === 'string' ? 2 : 1, { ...CLOSED });
    }
    return connect.apply(this, args);
  };
}

closePort(OLLAMA_PORT);

module.exports = { closePort };
