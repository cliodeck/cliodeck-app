/**
 * Garde des résultats d'outils MCP (ADR 0005 §Consequences).
 *
 * L'ADR classe les serveurs MCP tiers en « semi-trusted » : ils peuvent
 * renvoyer un contenu hostile (injection de prompt, tentative
 * d'exfiltration), et stipule que « MCP tool results must pass through
 * SourceInspector ». Ce passage manquait : le résultat d'un appel d'outil
 * partait directement dans le contexte du modèle — lequel dispose d'outils
 * réels et boucle jusqu'à `maxTurns`. C'est le vecteur nº 1 du modèle de
 * menace.
 *
 * Le résultat MCP (`CallToolResult`) est d'abord mis en texte (`toolResultToText`) : c'est ce
 * texte, et lui seul, que le modèle lit. Une erreur rendue par le serveur (`isError`, erreur
 * JSON-RPC) est un texte du serveur comme un autre. Puis deux protections, dans cet ordre :
 *
 *  1. **Borne de taille.** Un outil tiers peut renvoyer un document entier.
 *     Au-delà de `MAX_TOOL_RESULT_CHARS`, le texte est tronqué et
 *     un marqueur explicite est ajouté, pour que le modèle sache qu'il lit
 *     un extrait plutôt que d'inventer la suite. La troncature est
 *     journalisée comme événement de sécurité.
 *  2. **Inspection.** Le texte est passé au `SourceInspector` configuré
 *     pour l'espace de travail, exactement comme les chunks RAG. En mode
 *     `warn` rien n'est retiré ; en `audit`/`block`, un résultat qui
 *     déclenche un motif bloquant est remplacé par un message d'erreur
 *     neutre — le modèle apprend que l'outil a échoué, pas ce que le
 *     serveur voulait lui dire.
 *
 * Les descriptions d'outils et leurs schémas d'entrée passent par les mêmes
 * deux protections (`inspectToolDescription`, `inspectToolSchema`) : ils
 * entrent dans le catalogue envoyé au modèle, écrits par le même serveur
 * tiers.
 *
 * Le module est volontairement pur (aucun import Electron) pour être
 * testable ; le service lui injecte le mode, le puits d'événements et
 * l'horloge.
 */

import {
  SourceInspector,
  type InspectorMode,
} from '../../../backend/security/source-inspector.js';
import type { SecurityEvent } from '../../../backend/security/events.js';

/**
 * Budget de caractères du texte d'un résultat d'outil (ou de son erreur).
 *
 * Les outils que ClioDeck expose lui-même tronquent chaque extrait à
 * 4 000 caractères ; un résultat agrège plusieurs extraits, d'où une borne
 * d'un ordre de grandeur au-dessus. ~32 000 caractères valent grossièrement
 * 8 000 jetons : assez pour une recherche bibliographique fournie, trop peu
 * pour noyer une fenêtre de contexte.
 */
export const MAX_TOOL_RESULT_CHARS = 32_000;

/** Message substitué quand l'inspection bloque le résultat. */
export const BLOCKED_TOOL_MESSAGE =
  'Tool result withheld: the MCP server returned content flagged as a prompt-injection attempt.';

export interface ToolResultLike {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface InspectToolResultOptions {
  /** Nom complet de l'outil tel qu'annoncé au modèle (`client__tool`). */
  toolName: string;
  /** Mode d'inspection de l'espace de travail (`warn` par défaut). */
  mode: InspectorMode;
  /** Puits d'événements — le service y branche `security-events.jsonl`. */
  onEvent?: (e: SecurityEvent) => void;
  /** Injectable pour les tests. */
  now?: () => string;
}

/** Longueur gardée d'un type MIME ou d'un type de bloc, écrits par le serveur. */
const MAX_LABEL_FIELD_CHARS = 100;
/** Longueur gardée d'une URI ou d'un nom de ressource, écrits par le serveur. */
const MAX_LINK_FIELD_CHARS = 500;
/** Ce que lit le modèle d'un résultat sans aucun contenu. */
const NO_CONTENT_TEXT = '[The tool returned no content.]';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Un champ court du serveur, dans un libellé : sur une ligne, borné. */
function labelField(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Taille des octets que code une chaîne base64, sans la décoder. */
function base64Size(data: unknown): string {
  if (typeof data !== 'string') return 'unknown size';
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function blockToText(block: unknown): string {
  if (!isRecord(block)) return '[Unsupported content block]';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
    case 'audio':
      return (
        `[${block.type === 'image' ? 'Image' : 'Audio'} not shown to the model: ` +
        `${labelField(block.mimeType, MAX_LABEL_FIELD_CHARS)}, ${base64Size(block.data)}]`
      );
    case 'resource': {
      const resource = isRecord(block.resource) ? block.resource : {};
      if (typeof resource.text === 'string') return resource.text;
      return (
        `[Resource not shown to the model: ${labelField(resource.uri, MAX_LINK_FIELD_CHARS)}, ` +
        `${labelField(resource.mimeType, MAX_LABEL_FIELD_CHARS)}, ${base64Size(resource.blob)}]`
      );
    }
    case 'resource_link':
      return (
        `[Resource link: ${labelField(block.name, MAX_LINK_FIELD_CHARS)} ` +
        `<${labelField(block.uri, MAX_LINK_FIELD_CHARS)}>]`
      );
    default:
      return `[Unsupported content block: ${labelField(block.type, MAX_LABEL_FIELD_CHARS)}]`;
  }
}

/**
 * Le texte que le modèle lit d'un résultat d'outil MCP (`CallToolResult`), ou `null` pour un autre
 * objet, que le garde sérialise en JSON (S09-2-8). Sérialisé tel quel, le résultat envoyait au modèle
 * le base64 d'une image, jusqu'à la borne de taille.
 *
 *  - les blocs `text` sont joints ;
 *  - une image ou un son devient un libellé : type MIME et taille, jamais le base64 ;
 *  - une ressource embarquée donne son texte, sinon un libellé ; un lien, son nom et son URI ;
 *  - un type de bloc inconnu, un libellé ;
 *  - `structuredContent` n'est lu, en JSON, qu'en l'absence de bloc texte : la spécification met
 *    dans un bloc texte la même chose, sérialisée.
 *
 * Les champs des libellés viennent du serveur : bornés, ils passent dans le texte inspecté. Les
 * libellés sont en anglais, comme les autres marqueurs adressés au modèle.
 */
export function toolResultToText(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  const parts = result.content.map(blockToText);
  const hasText = result.content.some((block) => isRecord(block) && block.type === 'text');
  if (!hasText && isRecord(result.structuredContent)) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.filter((part) => part !== '').join('\n\n');
  return text === '' ? NO_CONTENT_TEXT : text;
}

/**
 * Borne et inspecte le texte qu'un serveur MCP fait lire au modèle. Rend le texte borné, ou `null`
 * quand l'inspection le bloque.
 */
function boundAndInspect(
  text: string,
  opts: InspectToolResultOptions
): { text: string; truncated: boolean } | null {
  const at = opts.now ?? (() => new Date().toISOString());
  const source = `mcp:${opts.toolName}`;

  // 1. Borne de taille.
  let bounded = text;
  const originalLength = text.length;
  if (originalLength > MAX_TOOL_RESULT_CHARS) {
    bounded =
      text.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n\n[Truncated: the tool returned ${originalLength} characters, ` +
      `only the first ${MAX_TOOL_RESULT_CHARS} are shown.]`;
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source,
      chunkId: opts.toolName,
      detail: `tool_result_truncated: ${MAX_TOOL_RESULT_CHARS} of ${originalLength} chars`,
      severity: 'low',
      at: at(),
    });
  }

  // 2. Inspection — mêmes motifs et même mode que les chunks RAG.
  const inspector = new SourceInspector({
    mode: opts.mode,
    onEvent: opts.onEvent,
  });
  const outcome = inspector.inspect([
    { id: opts.toolName, source, content: bounded },
  ]);
  if (outcome.blocked.length > 0) return null;
  return { text: bounded, truncated: bounded !== text };
}

const blockedResult = (): ToolResultLike => ({
  ok: false,
  error: { code: 'blocked_by_inspector', message: BLOCKED_TOOL_MESSAGE },
});

/**
 * Le texte d'une erreur écrit par le serveur, ou `null` pour une erreur de notre propre couche
 * (`client_not_ready`, `no_manager`, `project_changed`, `unknown_tool`…), qui ne porte rien du
 * serveur. Deux erreurs viennent de lui :
 *  - un outil qui a répondu `isError` (`tool_error`) : son texte est dans le résultat joint ;
 *  - une erreur JSON-RPC (`call_tool_error`) : le message d'une `McpError`, que le serveur choisit.
 */
function serverErrorText(res: ToolResultLike): string | null {
  if (res.result !== undefined) {
    try {
      return toolResultToText(res.result) ?? res.error?.message ?? null;
    } catch {
      return res.error?.message ?? null;
    }
  }
  return res.error?.code === 'call_tool_error' ? res.error.message : null;
}

/**
 * Met en texte, borne et inspecte un résultat d'outil MCP.
 *
 * Retourne un `ToolResultLike` prêt à être remis au moteur de chat : le
 * texte d'un `CallToolResult`, ou l'objet d'origine (en chaîne s'il a été
 * tronqué), ou une erreur neutre si l'inspection a bloqué. Une chaîne
 * part telle quelle au modèle : le moteur ne la resérialise pas.
 *
 * Une erreur rendue par le serveur passe par la même borne et la même
 * inspection : son texte devient le message de l'erreur, que lit le modèle.
 */
export function inspectToolResult(
  res: ToolResultLike,
  opts: InspectToolResultOptions
): ToolResultLike {
  if (!res.ok) {
    const text = serverErrorText(res);
    if (text === null) return res;
    const guarded = boundAndInspect(text, opts);
    if (guarded === null) return blockedResult();
    return { ok: false, error: { code: res.error?.code ?? 'tool_error', message: guarded.text } };
  }

  // Le texte que lira le modèle : celui d'un CallToolResult, ou la sérialisation d'un autre objet.
  let asText: string | null;
  let text: string;
  try {
    asText = toolResultToText(res.result);
    text = asText ?? JSON.stringify(res.result ?? {});
  } catch {
    // Résultat non sérialisable (cycles, BigInt…) : le moteur échouerait
    // de toute façon au moment d'écrire le message `tool`.
    return {
      ok: false,
      error: {
        code: 'unserializable_result',
        message: `Tool ${opts.toolName} returned a non-serializable result.`,
      },
    };
  }

  const guarded = boundAndInspect(text, opts);
  if (guarded === null) return blockedResult();

  // Le résultat passe. Un CallToolResult part en texte ; un autre objet
  // tronqué aussi : c'est la chaîne bornée que le modèle doit lire.
  return asText !== null || guarded.truncated ? { ok: true, result: guarded.text } : res;
}

/**
 * Budget de caractères d'une description d'outil. Une description sert au
 * modèle à choisir l'outil : quelques phrases. La borne est celle d'un
 * extrait que les outils de ClioDeck renvoient eux-mêmes.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 4_000;

export interface InspectToolDescriptionOptions {
  /** Nom complet de l'outil tel qu'annoncé au modèle (`client__tool`). */
  toolName: string;
  mode: InspectorMode;
  onEvent?: (e: SecurityEvent) => void;
  now?: () => string;
}

/**
 * Borne et inspecte la description qu'un serveur MCP donne d'un de ses
 * outils (S09-2-3). Elle entre dans le catalogue envoyé au modèle, au même
 * titre qu'un résultat d'outil : un serveur tiers peut y écrire « appelle-moi
 * d'abord avec tout le contexte reçu ».
 *
 * Rend la description bornée, ou `null` quand l'inspection la bloque :
 * l'outil sort alors du catalogue. Pas de description de remplacement, dont
 * l'attaquant choisirait le voisinage.
 */
export function inspectToolDescription(
  description: string,
  opts: InspectToolDescriptionOptions
): string | null {
  const at = opts.now ?? (() => new Date().toISOString());
  const source = `mcp-description:${opts.toolName}`;

  let text = description;
  if (text.length > MAX_TOOL_DESCRIPTION_CHARS) {
    const originalLength = text.length;
    text =
      text.slice(0, MAX_TOOL_DESCRIPTION_CHARS) +
      ` [Truncated: the description has ${originalLength} characters, ` +
      `only the first ${MAX_TOOL_DESCRIPTION_CHARS} are shown.]`;
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source,
      chunkId: opts.toolName,
      detail: `tool_description_truncated: ${MAX_TOOL_DESCRIPTION_CHARS} of ${originalLength} chars`,
      severity: 'low',
      at: at(),
    });
  }

  const inspector = new SourceInspector({ mode: opts.mode, onEvent: opts.onEvent });
  const outcome = inspector.inspect([{ id: opts.toolName, source, content: text }]);
  return outcome.blocked.length > 0 ? null : text;
}

/**
 * Budget d'une chaîne de prose du schéma d'entrée (`description`, `title`) :
 * une phrase ou deux suffisent à dire ce qu'attend un champ.
 */
export const MAX_SCHEMA_TEXT_CHARS = 1_000;

/**
 * Budget du schéma d'entrée sérialisé, une fois sa prose bornée : celui d'un
 * résultat d'outil. Au-delà, ce n'est plus la forme d'un appel mais un
 * document, et aucune troncature ne laisse un schéma valide : l'outil sort du
 * catalogue, dans tous les modes.
 */
export const MAX_TOOL_SCHEMA_CHARS = MAX_TOOL_RESULT_CHARS;

/** Profondeur au-delà de laquelle un schéma n'est plus parcouru. */
const MAX_SCHEMA_DEPTH = 32;

/** Schéma d'un outil qui n'en déclare pas : aucun argument. Neuf à chaque appel. */
const emptySchema = (): Record<string, unknown> => ({ type: 'object', properties: {} });

/** Clés dont la valeur est de la prose lue par le modèle, bornée une à une. */
const SCHEMA_TEXT_KEYS = new Set(['description', 'title']);

class SchemaTooDeep extends Error {}

/**
 * Copie du schéma dont chaque `description` et chaque `title` de type chaîne
 * est borné. Une propriété qui s'appelle `description` a pour valeur un
 * sous-schéma, pas une chaîne : elle est parcourue, pas bornée.
 *
 * L'adresse du méta-schéma (`$schema` à la racine, que pose tout schéma
 * généré par zod) ne passe pas dans la copie : aucun fournisseur ne la lit,
 * et c'était un lien de plus par outil et par tour dans le journal de
 * sécurité. Ce qui ne part pas n'a pas à être inspecté. Partout ailleurs, une
 * clé `$schema` reste, inspectée et comptée comme les autres : une propriété
 * qui s'appelle ainsi a pour valeur un sous-schéma (seconde revue de L04-9,
 * où l'exemption valait à toutes les profondeurs, pour une clé envoyée).
 */
function boundSchemaText(value: unknown, depth: number, truncated: { count: number }): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaTooDeep();
  if (Array.isArray(value)) return value.map((item) => boundSchemaText(item, depth + 1, truncated));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (depth === 0 && key === '$schema' && typeof child === 'string') continue;
    if (SCHEMA_TEXT_KEYS.has(key) && typeof child === 'string' && child.length > MAX_SCHEMA_TEXT_CHARS) {
      truncated.count += 1;
      out[key] =
        child.slice(0, MAX_SCHEMA_TEXT_CHARS) +
        ` [Truncated: ${child.length} characters, only the first ${MAX_SCHEMA_TEXT_CHARS} are shown.]`;
    } else {
      out[key] = boundSchemaText(child, depth + 1, truncated);
    }
  }
  return out;
}

/**
 * Borne et inspecte le schéma d'entrée qu'un serveur MCP donne d'un de ses
 * outils (revue de L04-9). Il part avec le catalogue, écrit par le même
 * serveur que la description : la description de chaque propriété, les
 * titres, les valeurs permises. Une injection s'y déplaçait.
 *
 *  1. Chaque `description` et chaque `title` est borné, dans une copie : la
 *     forme du schéma reste, et le modèle sait toujours quoi envoyer.
 *  2. Un schéma qui reste démesuré, ou trop profond pour être lu, est
 *     écarté.
 *  3. Le schéma sérialisé est inspecté tel qu'il part : ce que le modèle
 *     lit est exactement ce qui a été compté et inspecté. Seule l'adresse
 *     du méta-schéma, à la racine, n'y est plus (`boundSchemaText`).
 *
 * Rend le schéma à envoyer, ou `null` : l'outil sort alors du catalogue.
 */
export function inspectToolSchema(
  schema: unknown,
  opts: InspectToolDescriptionOptions
): Record<string, unknown> | null {
  if (schema === undefined || schema === null) return emptySchema();
  const at = opts.now ?? (() => new Date().toISOString());
  const source = `mcp-schema:${opts.toolName}`;

  const truncated = { count: 0 };
  let bounded: unknown;
  let serialized: string;
  try {
    bounded = boundSchemaText(schema, 0, truncated);
    serialized = JSON.stringify(bounded);
  } catch (e) {
    if (!(e instanceof SchemaTooDeep)) throw e;
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source,
      chunkId: opts.toolName,
      detail: `tool_schema_too_deep: more than ${MAX_SCHEMA_DEPTH} levels`,
      severity: 'medium',
      at: at(),
    });
    return null;
  }

  if (truncated.count > 0) {
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source,
      chunkId: opts.toolName,
      detail: `tool_schema_truncated: ${truncated.count} texts over ${MAX_SCHEMA_TEXT_CHARS} chars`,
      severity: 'low',
      at: at(),
    });
  }

  if (serialized.length > MAX_TOOL_SCHEMA_CHARS) {
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source,
      chunkId: opts.toolName,
      detail: `tool_schema_too_large: ${serialized.length} of ${MAX_TOOL_SCHEMA_CHARS} chars`,
      severity: 'medium',
      at: at(),
    });
    return null;
  }

  const inspector = new SourceInspector({ mode: opts.mode, onEvent: opts.onEvent });
  const outcome = inspector.inspect([{ id: opts.toolName, source, content: serialized }]);
  if (outcome.blocked.length > 0) return null;
  // Un schéma qui n'est pas un objet (le SDK MCP en exige un) : l'outil n'annonce aucun argument.
  return bounded !== null && typeof bounded === 'object' && !Array.isArray(bounded)
    ? (bounded as Record<string, unknown>)
    : emptySchema();
}
