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
 *
 * Le texte d'un mode de projet, venu du même dossier, passe par le même
 * garde (`guardProjectModePrompt`).
 */
import {
  SourceInspector,
  type InspectorMode,
} from '../../../backend/security/source-inspector.js';
import type { SecurityEvent } from '../../../backend/security/events.js';
import type { WorkspaceHints } from '../../../backend/core/hints/loader.js';
import type { ResolvedMode } from '../../../backend/types/mode.js';

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
 * Une consigne venue du dossier du projet, bornée puis inspectée. `null` quand l'inspection la
 * bloque.
 */
function guardProjectText(
  text: string,
  what: { source: string; chunkId: string; label: string; detail: string },
  opts: HintsGuardOptions
): string | null {
  const at = opts.now ?? (() => new Date().toISOString());
  let bounded = text;

  if (bounded.length > MAX_HINTS_CHARS) {
    const originalLength = bounded.length;
    bounded =
      bounded.slice(0, MAX_HINTS_CHARS) +
      `\n\n[Tronqué : ${what.label} fait ${originalLength} caractères, ` +
      `seuls les ${MAX_HINTS_CHARS} premiers sont retenus.]`;
    opts.onEvent?.({
      kind: 'unusual_encoding',
      source: what.source,
      chunkId: what.chunkId,
      detail: `${what.detail}: ${MAX_HINTS_CHARS} of ${originalLength} chars`,
      severity: 'low',
      at: at(),
    });
  }

  const inspector = new SourceInspector({ mode: opts.mode, onEvent: opts.onEvent });
  const outcome = inspector.inspect([
    { id: what.chunkId, source: what.source, content: bounded },
  ]);

  return outcome.blocked.length > 0 ? null : bounded;
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

  const normalized = guardProjectText(
    hints.normalized,
    {
      source: 'workspace-hints',
      chunkId: 'context',
      label: 'le contexte du projet',
      detail: 'hints_truncated',
    },
    opts
  );

  if (normalized === null) {
    // Écarté plutôt que remplacé par un avertissement : un message `system`
    // expliquant qu'un contexte a été bloqué serait lui-même une consigne,
    // et l'attaquant choisirait son libellé.
    return { ...hints, present: false, normalized: '' };
  }

  return normalized === hints.normalized ? hints : { ...hints, normalized };
}

/**
 * Le texte d'un mode de projet (`<projet>/cliodeck-data/modes/`, S06-1-7), borné et inspecté
 * comme le contexte du projet. Ce dossier voyage avec le projet, et un mode de projet remplace,
 * à identifiant égal, un mode intégré, `default-assistant` compris : son texte devient le
 * premier message `system` du tour, au-dessus du contexte du projet.
 *
 * Un mode intégré ou global (`~/.config/cliodeck/modes/`) est celui de l'utilisateur : rendu
 * tel quel. En mode bloquant, un texte jugé hostile rend `undefined` : aucun texte de mode
 * n'est injecté.
 */
export function guardProjectModePrompt(
  text: string,
  mode: Pick<ResolvedMode, 'source' | 'metadata'>,
  opts: HintsGuardOptions
): string | undefined {
  if (mode.source !== 'project') return text;
  return (
    guardProjectText(
      text,
      {
        source: 'project-mode',
        chunkId: mode.metadata.id,
        label: 'le mode du projet',
        detail: 'mode_prompt_truncated',
      },
      opts
    ) ?? undefined
  );
}
