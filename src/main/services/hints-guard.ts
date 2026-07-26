/**
 * Garde appliqué au contexte de projet (`context.md`, `.cliodeck/hints.md`)
 * avant qu'il n'atteigne le modèle.
 *
 * Ce fichier est injecté en rôle `system` — donc au SOMMET de la hiérarchie
 * de confiance du modèle, au-dessus des consignes de l'application
 * elle-même. Or `context.md` vit à la RACINE du projet : il voyage avec un
 * dossier partagé, un gabarit d'équipe, un dépôt cloné. Un projet reçu d'un
 * tiers pouvait ainsi dicter le comportement de l'assistant à l'insu de son
 * lecteur.
 *
 * Les chunks RAG et les résultats d'outils MCP passaient déjà par le
 * `SourceInspector` ; ce chemin-là ne le faisait pas. C'était la dernière
 * entrée non défendue du modèle de menace (ADR 0005).
 *
 * Deux mesures, identiques à celles du garde MCP :
 *   1. borne de taille — un contexte de 2 Mo noierait la conversation ;
 *   2. inspection par les mêmes motifs, dans le même mode que le RAG.
 */
import {
  SourceInspector,
  type InspectorMode,
} from '../../../backend/security/source-inspector.js';
import type { SecurityEvent } from '../../../backend/security/events.js';
import type { WorkspaceHints } from '../../../backend/core/hints/loader.js';

/**
 * Au-delà, ce n'est plus un contexte de projet mais un corpus. La valeur
 * suit celle des résultats d'outils MCP, pour la même raison : ce qui entre
 * dans le prompt doit rester lisible par un humain.
 */
export const MAX_HINTS_CHARS = 32_000;

export interface HintsGuardOptions {
  mode: InspectorMode;
  onEvent?: (e: SecurityEvent) => void;
  now?: () => string;
}

/**
 * Renvoie les hints bornés et inspectés. En mode bloquant, un contexte jugé
 * hostile est entièrement écarté — `present: false`, donc rien n'est injecté.
 */
export function guardWorkspaceHints(
  hints: WorkspaceHints,
  opts: HintsGuardOptions
): WorkspaceHints {
  if (!hints.present) return hints;

  const at = opts.now ?? (() => new Date().toISOString());
  const source = 'workspace-hints';
  let normalized = hints.normalized;

  if (normalized.length > MAX_HINTS_CHARS) {
    const originalLength = normalized.length;
    normalized =
      normalized.slice(0, MAX_HINTS_CHARS) +
      `\n\n[Tronqué : le contexte du projet fait ${originalLength} caractères, ` +
      `seuls les ${MAX_HINTS_CHARS} premiers sont retenus.]`;
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source,
      chunkId: 'context',
      detail: `hints_truncated: ${MAX_HINTS_CHARS} of ${originalLength} chars`,
      severity: 'low',
      at: at(),
    });
  }

  const inspector = new SourceInspector({ mode: opts.mode, onEvent: opts.onEvent });
  const outcome = inspector.inspect([
    { id: 'context', source, content: normalized },
  ]);

  if (outcome.blocked.length > 0) {
    // Écarté plutôt que remplacé par un avertissement : un message `system`
    // expliquant qu'un contexte a été bloqué serait lui-même une consigne,
    // et l'attaquant choisirait son libellé.
    return { ...hints, present: false, normalized: '' };
  }

  return normalized === hints.normalized ? hints : { ...hints, normalized };
}
