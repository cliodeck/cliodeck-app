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
 * Deux protections, dans cet ordre :
 *
 *  1. **Borne de taille.** Un outil tiers peut renvoyer un document entier.
 *     Au-delà de `MAX_TOOL_RESULT_CHARS`, la sérialisation est tronquée et
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
 * Budget de caractères pour la sérialisation d'un résultat d'outil.
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

/**
 * Sérialise, borne et inspecte un résultat d'outil MCP.
 *
 * Retourne un `ToolResultLike` prêt à être remis au moteur de chat : soit
 * le résultat d'origine (éventuellement tronqué), soit une erreur neutre
 * si l'inspection a bloqué.
 */
export function inspectToolResult(
  res: ToolResultLike,
  opts: InspectToolResultOptions
): ToolResultLike {
  // Un échec d'outil ne transporte qu'un message d'erreur produit par notre
  // propre couche : rien à inspecter.
  if (!res.ok) return res;

  const at = opts.now ?? (() => new Date().toISOString());
  const source = `mcp:${opts.toolName}`;

  // 1. Sérialisation + borne de taille.
  let serialized: string;
  try {
    serialized = JSON.stringify(res.result ?? {});
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

  let truncated = false;
  const originalLength = serialized.length;
  if (originalLength > MAX_TOOL_RESULT_CHARS) {
    truncated = true;
    serialized =
      serialized.slice(0, MAX_TOOL_RESULT_CHARS) +
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
    { id: opts.toolName, source, content: serialized },
  ]);

  if (outcome.blocked.length > 0) {
    return {
      ok: false,
      error: { code: 'blocked_by_inspector', message: BLOCKED_TOOL_MESSAGE },
    };
  }

  // Le résultat passe. S'il a été tronqué, on renvoie la chaîne bornée
  // plutôt que l'objet d'origine : c'est elle que le modèle doit lire.
  return truncated ? { ok: true, result: serialized } : res;
}
