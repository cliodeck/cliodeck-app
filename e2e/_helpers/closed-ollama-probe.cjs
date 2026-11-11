/**
 * Sonde de `closed-ollama.cjs`, lancée par `launch-harness.spec.ts` sous l'Electron du dépôt en mode
 * Node, comme le main qui charge le module par `-r`.
 *
 * Deux témoins, sur des ports libres et sur `127.0.0.1` seulement, comme l'Ollama de l'auteur : le
 * premier port est fermé par `closePort`, le second ne l'est pas. Le port 11434 n'est jamais visé : la
 * sonde ne doit rien envoyer à un Ollama qui tourne. Chaque hôte qui mène à `127.0.0.1` est essayé par
 * `fetch`, `http.get` et `Socket.connect` sur le port fermé, et par `fetch` sur le port ouvert (le chemin
 * mène bien au témoin, sinon le refus ne prouverait rien). Le résultat sort en JSON sur stdout.
 */
const http = require('node:http');
const net = require('node:net');
const { closePort } = require('./closed-ollama.cjs');

/** Des écritures d'une même adresse, `127.0.0.1` : nom, nom terminé par un point, adresse « toutes », IPv4 dans IPv6. */
const HOSTS = ['127.0.0.1', 'localhost', 'localhost.', '0.0.0.0', '::ffff:127.0.0.1'];

function witness() {
  return new Promise((done) => {
    const server = http.createServer((_req, res) => res.end('{}'));
    const seen = { server, port: 0, connections: 0 };
    server.on('connection', () => {
      seen.connections += 1;
    });
    server.listen(0, '127.0.0.1', () => {
      seen.port = server.address().port;
      done(seen);
    });
  });
}

const outcome = (attempt) =>
  attempt.then(
    () => 'joint',
    (error) => (error && error.cause && error.cause.code) || (error && error.code) || String(error),
  );

const urlHost = (host) => (net.isIPv6(host) ? `[${host}]` : host);

const VIA = {
  fetch: (host, port) => outcome(fetch(`http://${urlHost(host)}:${port}/`).then((res) => res.text())),
  http: (host, port) =>
    outcome(
      new Promise((ok, ko) => {
        http.get({ host, port, path: '/' }, (res) => res.resume().on('end', ok)).on('error', ko);
      }),
    ),
  // `fetch` et `http` passent par `net.connect`, qui normalise ses arguments en objet ; ici, la forme
  // en position (port, hôte) de `Socket.prototype.connect`. Sans hôte, Node vise `localhost`.
  socket: (host, port) =>
    outcome(
      new Promise((ok, ko) => {
        const socket = new net.Socket();
        socket.on('error', ko);
        socket.connect(port, host, () => socket.end(ok));
      }),
    ),
};

(async () => {
  const closed = await witness();
  const open = await witness();
  closePort(closed.port);

  const refused = {};
  for (const host of HOSTS) {
    for (const [via, attempt] of Object.entries(VIA)) refused[`${via} ${host}`] = await attempt(host, closed.port);
  }
  refused['socket (sans hôte)'] = await VIA.socket(undefined, closed.port);

  const reached = {};
  for (const host of HOSTS) reached[host] = await VIA.fetch(host, open.port);

  for (const { server } of [closed, open]) {
    server.closeAllConnections();
    server.close();
  }
  process.stdout.write(
    JSON.stringify({ refused, reached, closedConnections: closed.connections, openConnections: open.connections }),
  );
})().catch((error) => {
  process.stderr.write(String((error && error.stack) || error));
  process.exit(1);
});
