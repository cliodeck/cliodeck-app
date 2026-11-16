/**
 * Le nom sous lequel un outil MCP est proposé au modèle (S09-1-23).
 *
 * Le nom brut d'un outil est `${clientName}__${toolName}` : le nom du serveur est un texte libre
 * (« Gallica BnF », « Archives départementales ») et le spec MCP admet le point dans un nom
 * d'outil. Les fournisseurs cloud refusent alors toute la requête (HTTP 400), à chaque tour, même
 * pour une question sans rapport avec l'outil. Le nom envoyé suit l'intersection de leurs règles :
 * OpenAI, Anthropic et Mistral `[a-zA-Z0-9_-]{1,64}`, Gemini une lettre ou `_` en tête.
 *
 * Règle :
 *  - un nom brut déjà valide part tel quel (tous les serveurs nommés en `[A-Za-z0-9_-]` dont le nom
 *    commence par une lettre ou `_`) ;
 *  - sinon, chaque moitié perd ses diacritiques (« départementales » → « departementales »), tout
 *    autre caractère hors de `[A-Za-z0-9_-]` devient `_`, les `_` répétés se réduisent, ceux des
 *    bords tombent : le séparateur `__` reste lisible. Une moitié vide prend un nom de repli, un
 *    serveur qui commence par un chiffre ou un `-` reçoit le préfixe `mcp_` ;
 *  - ce nom assaini porte un suffixe tiré du nom brut (`_` et 6 caractères hexadécimaux de son
 *    SHA-256), qui sépare deux noms bruts assainis pareil (« a b » et « a.b ») ou qui ne diffèrent
 *    qu'au-delà de la borne ; le tout tient en 64 caractères, le serveur cédant sa place avant
 *    l'outil ;
 *  - le nom envoyé ne dépend ainsi que du nom brut. Dernier recours, s'il est déjà pris : un
 *    compteur.
 *
 * Le nom envoyé ne sert qu'au modèle. L'appel au serveur, la puce d'outil, `mcp-access.jsonl` et
 * les événements de sécurité gardent les noms réels.
 */

import { createHash } from 'crypto';

/** Ce que tous les fournisseurs acceptent comme nom d'outil. */
export const WIRE_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

const MAX_LENGTH = 64;
const SEPARATOR = '__';
const HASH_LENGTH = 6;

/** Une moitié du nom, réduite à `[A-Za-z0-9_-]`, sans `_` répété ni au bord ; vide si rien ne reste. */
function cleanPart(part: string): string {
  return part
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritiques décomposés
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function shortHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Le nom d'outil à envoyer au modèle pour l'outil `toolName` du serveur `clientName`, différent de
 * tous ceux de `taken` (les noms déjà attribués dans le tour).
 */
export function buildWireToolName(clientName: string, toolName: string, taken: ReadonlySet<string>): string {
  const raw = `${clientName}${SEPARATOR}${toolName}`;
  if (WIRE_TOOL_NAME.test(raw) && !taken.has(raw)) return raw;

  let client = cleanPart(clientName) || 'mcp';
  if (!/^[A-Za-z_]/.test(client)) client = `mcp_${client}`;
  let tool = cleanPart(toolName) || 'tool';

  const suffix = `_${shortHash(raw)}`;
  const room = MAX_LENGTH - SEPARATOR.length - suffix.length;
  if (client.length + tool.length > room) {
    // Le serveur cède sa place d'abord, jusqu'à la moitié : c'est l'outil que le modèle choisit, et
    // la description dit le serveur en clair.
    client = client.slice(0, Math.max(Math.ceil(room / 2), room - tool.length)).replace(/_+$/, '');
    tool = tool.slice(0, room - client.length).replace(/_+$/, '');
  }

  const wire = `${client}${SEPARATOR}${tool}${suffix}`;
  if (!taken.has(wire)) return wire;
  for (let n = 2; ; n += 1) {
    const counter = `_${n}`;
    const candidate = `${wire.slice(0, MAX_LENGTH - counter.length)}${counter}`;
    if (!taken.has(candidate)) return candidate;
  }
}
